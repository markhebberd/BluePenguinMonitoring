using Android.Content;
using Android.OS;
using PenguinMonitor.Models;
using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Net.Http;
using System.Text;

namespace PenguinMonitor.Services
{
    public class DataStorageService
    {
        private const string APP_SETTINGS_FILENAME = "app_settings.json";
        private const string COLONY_STATE_FILENAME = "colony_state.json";
        internal const string REMOTE_BIRD_DATA_FILENAME = "remotePenguinData.json";
        internal const string BOX_NOTES_FILENAME = "boxNotes.json";
        internal const string BREEDING_DATES_FILENAME = "predictedDates.json";

        private static readonly HttpClient _httpClient = Http.CreateClient(TimeSpan.FromSeconds(15));
        private const int RETRY_MAX_SECONDS = 30;
        private const int RETRY_DELAY_MS = 5000;

        private static async Task<T> WithRetry<T>(Func<Task<T>> action, string label, Action<string>? onStatus = null, Func<bool>? isCancelled = null)
        {
            var deadline = DateTime.UtcNow.AddSeconds(RETRY_MAX_SECONDS);
            for (int attempt = 0; ; attempt++)
            {
                try
                {
                    onStatus?.Invoke(attempt > 0 ? $"{label} (attempt {attempt + 1})..." : $"{label}...");
                    var result = await action();
                    return result;
                }
                catch (Exception ex)
                {
                    if (DateTime.UtcNow >= deadline || (isCancelled?.Invoke() == true))
                    {
                        onStatus?.Invoke($"{label} ✗");
                        throw new Exception($"{label} failed after {attempt + 1} attempts: {ex.Message}");
                    }
                    onStatus?.Invoke($"{label} (attempt {attempt + 1} failed, retrying)...");
                    await Task.Delay(Math.Min(RETRY_DELAY_MS, (int)(deadline - DateTime.UtcNow).TotalMilliseconds));
                }
            }
        }
        internal const string WILDWATCH_BASE_URL = "https://wildwatch.co.nz/penguin-api";
        internal const string WILDWATCH_PENGUINS_URL = "https://wildwatch.co.nz/api/penguins.php";
        internal const string WILDWATCH_API_URL = "https://wildwatch.co.nz/api/crud.php";
        internal const string WILDWATCH_SYNC_URL = "https://wildwatch.co.nz/api/sync.php";
        internal const string WILDWATCH_API_KEY = "b30181424b2d70102fb90a32af6c013e63e7b0d49ae466ebf90aa0f969ddbe02";
        internal const string WILDWATCH_EVENTS_URL = "https://wildwatch.co.nz/api/events.php";
        internal const string WILDWATCH_REPORTS_URL = "https://wildwatch.co.nz/api/reports.php";

        // ===== Background Polling =====

        private static string _lastWatermark = "";
        private static System.Timers.Timer? _pollTimer;
        private static bool _pollingSyncing = false;

        internal enum PollResult { Failed, NoChanges, Changed }

        /// <summary>
        /// Check events.php for changes since last watermark.
        /// </summary>
        internal async Task<PollResult> CheckForChangesAsync(string token)
        {
            try
            {
                var url = string.IsNullOrEmpty(_lastWatermark)
                    ? WILDWATCH_EVENTS_URL
                    : $"{WILDWATCH_EVENTS_URL}?wm={Uri.EscapeDataString(_lastWatermark)}";
                var request = new HttpRequestMessage(HttpMethod.Get, url);
                request.Headers.Add("Authorization", $"Bearer {token}");
                var response = await _httpClient.SendAsync(request);
                if (!response.IsSuccessStatusCode) return PollResult.Failed;
                var json = await response.Content.ReadAsStringAsync();
                var data = JsonConvert.DeserializeObject<Dictionary<string, object>>(json);
                if (data == null) return PollResult.Failed;
                if (data.ContainsKey("wm")) _lastWatermark = data["wm"]?.ToString() ?? "";
                bool changed = data.ContainsKey("changed") && data["changed"]?.ToString() == "True";
                return changed ? PollResult.Changed : PollResult.NoChanges;
            }
            catch { return PollResult.Failed; }
        }

        /// <summary>
        /// Start background polling every 5 minutes. Calls onChanged on the main thread when new data detected.
        /// </summary>
        /// <summary>
        /// Start background polling every 5 minutes.
        /// onChecked is called on every successful poll (changed or not).
        /// onChanged is called only when server has new data.
        /// </summary>
        internal void StartBackgroundPolling(string token, Func<Task> onChanged, Action? onChecked = null, Func<Task>? onPendingUpload = null)
        {
            StopBackgroundPolling();
            _pollTimer = new System.Timers.Timer(15 * 1000); // 15 seconds (testing)
            _pollTimer.Elapsed += async (s, e) =>
            {
                if (_pollingSyncing || string.IsNullOrEmpty(token)) return;
                try
                {
                    var result = await CheckForChangesAsync(token);
                    if (result != PollResult.Failed)
                    {
                        onChecked?.Invoke();
                        if (result == PollResult.Changed)
                        {
                            _pollingSyncing = true;
                            await onChanged();
                            _pollingSyncing = false;
                        }
                        else if (onPendingUpload != null)
                        {
                            await onPendingUpload();
                        }
                    }
                }
                catch { _pollingSyncing = false; }
            };
            _pollTimer.AutoReset = true;
            _pollTimer.Start();

            // Fetch initial watermark silently
            _ = CheckForChangesAsync(token);
        }

        internal void StopBackgroundPolling()
        {
            _pollTimer?.Stop();
            _pollTimer?.Dispose();
            _pollTimer = null;
        }

        // ===== Sync Result =====

        public class SyncResult
        {
            public Dictionary<string, BoxTag>? BoxTags { get; set; }
            public BoxTagService.SyncResult? TagSyncResult { get; set; }
            public string? BoxTagError { get; set; }
            public int BirdCount { get; set; }
            public int BoxCount { get; set; }
            public int Uploaded { get; set; }
            public int UploadErrors { get; set; }
            public int BiometricCount { get; set; }
            public int BiometricsUploaded { get; set; }
            public int BiometricUploadErrors { get; set; }
            public string? Error { get; set; }
            public bool AuthFailed { get; set; }
            /// <summary>
            /// Server-detected conflicts: box already has today's data.
            /// </summary>
            public List<SyncConflict>? Conflicts { get; set; }
        }

        // Observation time for upload. If the observation has no valid timestamp
        // (e.g. a chick added with no scan to seed one), default to now.
        private static string ObsTimeUtc(BoxObservation o)
        {
            var t = o.WhenDataCollectedUtc;
            if (t == default || t.Year < 2000) t = DateTime.UtcNow;
            return t.ToString("yyyy-MM-ddTHH:mm:ssZ");
        }

        // ===== Main Sync: Upload pending, download fresh state =====

        internal async Task<SyncResult> SyncWithServer(Android.Content.Context context, ColonyState colonyState, AppSettings appSettings, Dictionary<string, BoxTag>? boxTags = null, ICollection<string>? validBoxIds = null, Action<int, string>? onLineProgress = null, Func<bool>? isCancelled = null)
        {
            var result = new SyncResult();
            try
            {
                var token = appSettings.AuthToken;
                if (string.IsNullOrEmpty(token))
                {
                    result.Error = "Not logged in. Tap 'Login' to connect your Wildwatch account.";
                    result.AuthFailed = true;
                    return result;
                }

                var sw = System.Diagnostics.Stopwatch.StartNew();

                // Fetch colony data (always, so box sets stay current)
                {
                    try
                    {
                        var colonyRequest = new HttpRequestMessage(HttpMethod.Get, $"{WILDWATCH_BASE_URL}/colonies.php");
                        colonyRequest.Headers.Add("Authorization", $"Bearer {token}");
                        var colonyResponse = await _httpClient.SendAsync(colonyRequest);
                        if (colonyResponse.IsSuccessStatusCode)
                        {
                            var colonyJson = await colonyResponse.Content.ReadAsStringAsync();
                            var colonies = JsonConvert.DeserializeObject<List<Dictionary<string, object>>>(colonyJson);
                            if (colonies != null && colonies.Count > 0)
                            {
                                var match = colonies.FirstOrDefault(c => Convert.ToInt32(c["colony_id"]) == appSettings.SelectedColonyId) ?? colonies[0];
                                appSettings.SelectedColonyId = Convert.ToInt32(match["colony_id"]);
                                appSettings.SelectedColonyName = match["colony_name"]?.ToString() ?? "";
                                appSettings.SelectedColonyPrefix = match.TryGetValue("colony_prefix", out var cpfx) ? cpfx?.ToString() ?? "" : "";
                                appSettings.AllBoxSetsString = match["location_sets_string"]?.ToString() ?? "";
                                if (string.IsNullOrEmpty(appSettings.BoxSetString))
                                    appSettings.BoxSetString = "All";
                            }
                            else
                            {
                                // No permissions — clear colony
                                appSettings.SelectedColonyId = 0;
                                appSettings.SelectedColonyName = "";
                                appSettings.AllBoxSetsString = "";
                            }
                        }
                    }
                    catch { }
                }

                // Step 1: Upload ALL pending observations — server detects conflicts
                var pendingBoxes = new List<object>();
                foreach (var pending in colonyState.PendingObservations)
                {
                    if (!pending.IsPendingUpload || string.IsNullOrEmpty(pending.BoxName)) continue;
                    var scans = new List<object>();
                    foreach (var scan in pending.ScannedIds)
                    {
                        scans.Add(new {
                            pit_id = scan.BirdId,
                            scan_time_utc = scan.Timestamp.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                            latitude = scan.Latitude,
                            longitude = scan.Longitude,
                            accuracy = scan.Accuracy,
                        });
                    }
                    pendingBoxes.Add(new {
                        box_name = pending.BoxName,
                        observation_time_utc = ObsTimeUtc(pending),
                        adults = pending.Adults,
                        eggs = pending.Eggs,
                        chicks = pending.Chicks,
                        breeding_status = pending.BreedingStatus,
                        gate_status = pending.GateStatus,
                        notes = pending.Notes,
                        scans = scans,
                    });
                }

                if (pendingBoxes.Count > 0)
                {
                    var uploadBody = JsonConvert.SerializeObject(new {
                        daily_label = colonyState.DailyLabel,
                        observations = pendingBoxes,
                    });
                    var uploadRequest = new HttpRequestMessage(HttpMethod.Post, $"{WILDWATCH_SYNC_URL}?action=upload&colony_id={(appSettings.SelectedColonyId > 0 ? appSettings.SelectedColonyId : 1)}");
                    uploadRequest.Headers.Add("Authorization", $"Bearer {token}");
                    uploadRequest.Content = new StringContent(uploadBody, Encoding.UTF8, "application/json");

                    var uploadResponse = await _httpClient.SendAsync(uploadRequest);
                    if (uploadResponse.StatusCode == System.Net.HttpStatusCode.Unauthorized)
                    {
                        result.Error = "Session expired. Please log in again.";
                        result.AuthFailed = true;
                        return result;
                    }

                    var uploadJson = await uploadResponse.Content.ReadAsStringAsync();
                    var uploadResult = JsonConvert.DeserializeObject<Dictionary<string, object>>(uploadJson);

                    if (uploadResult != null && uploadResult.ContainsKey("created"))
                    {
                        var created = JsonConvert.DeserializeObject<List<Dictionary<string, object>>>(uploadResult["created"].ToString());
                        result.Uploaded = created?.Count ?? 0;

                        // Remove successfully uploaded observations from pending
                        foreach (var c in created ?? new())
                        {
                            var boxName = c["box_name"]?.ToString();
                            if (boxName != null)
                            {
                                // Remove the matching pending observation
                                var match = colonyState.PendingObservations.FirstOrDefault(p => p.BoxName == boxName && p.IsPendingUpload);
                                if (match != null)
                                    colonyState.PendingObservations.Remove(match);
                            }
                        }
                    }
                    if (uploadResult != null && uploadResult.ContainsKey("errors"))
                    {
                        var errors = JsonConvert.DeserializeObject<List<object>>(uploadResult["errors"].ToString());
                        result.UploadErrors = errors?.Count ?? 0;
                    }
                    // Server-detected conflicts (box already has today's data)
                    if (uploadResult != null && uploadResult.ContainsKey("conflicts"))
                    {
                        result.Conflicts = JsonConvert.DeserializeObject<List<SyncConflict>>(uploadResult["conflicts"].ToString());
                    }
                }

                // Step 1b: Upload any pending biometric edits (independent of pending observations)
                await UploadPendingBiometrics(colonyState, token, result);

                // Step 2: Fetch + process in parallel — each task reports its own progress
                var nzToday = MainActivity.NzToday;
                bool authFailed = false;

                // Boxes: fetch, parse, update colony state
                Task boxesTask = WithRetry(async () =>
                {
                    var req = new HttpRequestMessage(HttpMethod.Get, $"{WILDWATCH_SYNC_URL}?colony_id={(appSettings.SelectedColonyId > 0 ? appSettings.SelectedColonyId : 1)}");
                    req.Headers.Add("Authorization", $"Bearer {token}");
                    var resp = await _httpClient.SendAsync(req);
                    if (resp.StatusCode == System.Net.HttpStatusCode.Unauthorized) { authFailed = true; return 0; }
                    resp.EnsureSuccessStatusCode();
                    var json = await resp.Content.ReadAsStringAsync();
                    var serverState = JsonConvert.DeserializeObject<SyncResponse>(json);

                    colonyState.PreviousBoxes.Clear();
                    if (serverState?.boxes != null)
                    {
                        foreach (var kvp in serverState.boxes)
                        {
                            var b = kvp.Value;
                            var obs = BoxObservation.FromServerData(b.observation_id, b.location_id, b.observation_time_utc,
                                b.adults, b.eggs, b.chicks, b.breeding_status, b.gate_status, b.notes ?? "", b.monitor_filename, b.observer_name);
                            obs.BoxName = kvp.Key;
                            if (b.scans != null) foreach (var scan in b.scans)
                                obs.ScannedIds.Add(new ScanRecord { BirdId = scan.pit_id ?? "", Timestamp = DateTime.TryParse(scan.scan_time_utc, out var st) ? st : DateTime.UtcNow });
                            for (int ns = 0; ns < b.no_scan; ns++)
                                obs.ScannedIds.Add(new ScanRecord { BirdId = $"NOSCAN_{ns + 1}", Timestamp = obs.WhenDataCollectedUtc });

                            var obsNzDate = MainActivity.ToNzTime(obs.WhenDataCollectedUtc).Date;
                            if (obsNzDate == nzToday)
                            {
                                bool hasPending = colonyState.PendingObservations.Any(p => p.BoxName == kvp.Key && p.IsPendingUpload && MainActivity.ToNzTime(p.WhenDataCollectedUtc).Date == nzToday);
                                if (!hasPending) { obs.IsPendingUpload = false; colonyState.TodayBoxes[kvp.Key] = obs; }
                            }
                            else colonyState.PreviousBoxes[kvp.Key] = obs;
                        }
                        result.BoxCount = serverState.boxes.Count;

                        var serverTodayBoxNames = new HashSet<string>(serverState.boxes.Where(kvp => { var d = DateTime.TryParse(kvp.Value.observation_time_utc, out var dt) ? dt : DateTime.MinValue; return MainActivity.ToNzTime(d).Date == nzToday; }).Select(kvp => kvp.Key));
                        foreach (var key in colonyState.TodayBoxes.Keys.Where(k => !serverTodayBoxNames.Contains(k) && !colonyState.PendingObservations.Any(p => p.BoxName == k && p.IsPendingUpload)).ToList())
                            colonyState.TodayBoxes.Remove(key);
                    }
                    if (serverState?.previous != null)
                        foreach (var kvp in serverState.previous)
                        {
                            var b = kvp.Value;
                            var obs = BoxObservation.FromServerData(b.observation_id, b.location_id, b.observation_time_utc, b.adults, b.eggs, b.chicks, b.breeding_status, b.gate_status, b.notes ?? "", b.monitor_filename, b.observer_name);
                            obs.BoxName = kvp.Key;
                            if (b.scans != null) foreach (var scan in b.scans) obs.ScannedIds.Add(new ScanRecord { BirdId = scan.pit_id ?? "", Timestamp = DateTime.TryParse(scan.scan_time_utc, out var st) ? st : DateTime.UtcNow });
                            for (int ns = 0; ns < b.no_scan; ns++)
                                obs.ScannedIds.Add(new ScanRecord { BirdId = $"NOSCAN_{ns + 1}", Timestamp = obs.WhenDataCollectedUtc });
                            colonyState.PreviousBoxes[kvp.Key] = obs;
                        }
                    colonyState.LastSyncedUtc = DateTime.UtcNow;
                    if (serverState?.locations != null)
                    {
                        var boxNotes = new Dictionary<string, BoxNoteData>();
                        foreach (var loc in serverState.locations) boxNotes[loc.location_name ?? ""] = new BoxNoteData { LocationId = loc.location_id, BoxName = loc.location_name ?? "", PersistentNotes = loc.persistent_notes ?? "" };
                        File.WriteAllText(Path.Combine(context.FilesDir?.AbsolutePath, BOX_NOTES_FILENAME), JsonConvert.SerializeObject(boxNotes, Formatting.Indented));
                    }
                    onLineProgress?.Invoke(0, $"{result.BoxCount} boxes ✓");
                    return result.BoxCount;
                }, "Boxes", s => onLineProgress?.Invoke(0, s), isCancelled);

                // Penguins: fetch, parse, save
                Task birdsTask = WithRetry(async () =>
                {
                    var req = new HttpRequestMessage(HttpMethod.Get, WILDWATCH_PENGUINS_URL);
                    req.Headers.Add("Authorization", $"Bearer {token}");
                    var resp = await _httpClient.SendAsync(req);
                    if (resp.StatusCode == System.Net.HttpStatusCode.Unauthorized) { authFailed = true; return 0; }
                    resp.EnsureSuccessStatusCode();
                    var birdsJson = await resp.Content.ReadAsStringAsync();
                    if (string.IsNullOrEmpty(birdsJson) || !birdsJson.TrimStart().StartsWith("["))
                        throw new Exception($"Penguins API: expected JSON array");
                    var penguinRecords = JsonConvert.DeserializeObject<List<WildWatchPenguin>>(birdsJson);
                    var remotePenguinData = new Dictionary<string, PenguinData>();
                    foreach (var record in penguinRecords)
                    {
                        if (string.IsNullOrEmpty(record.pit_id) || record.pit_id.Length < 8) continue;
                        var cleanId = new string(record.pit_id.Where(char.IsLetterOrDigit).ToArray());
                        var eightDigitId = cleanId.Length >= 8 ? cleanId.Substring(cleanId.Length - 8).ToUpper() : cleanId.ToUpper();
                        if (eightDigitId.Length != 8) continue;
                        // life_stage column dropped — derive Adult/Chick/Returnee; is_dead is the only stored flag.
                        var chipDate = DateTime.TryParse(record.chip_date, out DateTime cd) ? cd : DateTime.MinValue;
                        LifeStage lifeStage;
                        if (record.is_dead == 1) lifeStage = LifeStage.Dead;
                        else if (record.chipped_as_adult == 1) lifeStage = LifeStage.Adult;
                        else if (chipDate > DateTime.MinValue && DateTime.UtcNow > chipDate.AddMonths(3)) lifeStage = LifeStage.Returnee; // chipped as chick, now back as an adult
                        else lifeStage = LifeStage.Chick;
                        remotePenguinData[cleanId.ToUpper()] = new PenguinData
                        {
                            FullPitId = record.pit_id ?? "", ScannedId = eightDigitId, PengNum = record.peng_num ?? "",
                            LastKnownLifeStage = lifeStage, Sex = record.sex ?? "", VidForScanner = record.vid_for_scanner ?? "",
                            ChipDate = chipDate,
                            ChipAs = record.chipped_as_adult == 1 ? "Adult" : "", ChickSizeCode = record.chick_size_code ?? ""
                        };
                    }
                    File.WriteAllText(Path.Combine(context.FilesDir?.AbsolutePath, REMOTE_BIRD_DATA_FILENAME),
                        JsonConvert.SerializeObject(remotePenguinData, Formatting.Indented));
                    result.BirdCount = remotePenguinData.Count;
                    onLineProgress?.Invoke(1, $"{result.BirdCount} penguin records ✓");
                    return result.BirdCount;
                }, "Penguins", s => onLineProgress?.Invoke(1, s), isCancelled);

                // Biometrics: fetch today's records so the detail form opens instantly/offline.
                // Non-critical — failures don't fail the sync.
                Task bioTask = WithRetry(async () =>
                {
                    var nzTodayStr = MainActivity.NzToday.ToString("yyyy-MM-dd");
                    var req = new HttpRequestMessage(HttpMethod.Get,
                        $"{WILDWATCH_API_URL}?action=list&table=penguin_biometric_data&observation_date={nzTodayStr}");
                    req.Headers.Add("Authorization", $"Bearer {token}");
                    var resp = await _httpClient.SendAsync(req);
                    if (resp.StatusCode == System.Net.HttpStatusCode.Unauthorized) { authFailed = true; return 0; }
                    resp.EnsureSuccessStatusCode();
                    var bioJson = await resp.Content.ReadAsStringAsync();
                    if (string.IsNullOrEmpty(bioJson) || !bioJson.TrimStart().StartsWith("["))
                        throw new Exception("Biometrics API: expected JSON array");
                    var rows = JsonConvert.DeserializeObject<List<Dictionary<string, object>>>(bioJson) ?? new();
                    int merged = 0;
                    foreach (var row in rows)
                    {
                        var pengNum = row.TryGetValue("peng_num", out var pn) ? pn?.ToString() : null;
                        if (string.IsNullOrEmpty(pengNum)) continue;
                        // Never clobber a local unsynced edit
                        if (colonyState.TodayBiometrics.TryGetValue(pengNum, out var local) && local.IsPendingUpload)
                            continue;
                        colonyState.TodayBiometrics[pengNum] = BiometricRecordFromRow(row, nzTodayStr);
                        merged++;
                    }
                    result.BiometricCount = merged;
                    return merged;
                }, "Biometrics", null, isCancelled);

                // Breeding dates: fetch per-box current-clutch predictions from wildwatch
                // (which now owns the estimator). Non-critical — failures don't fail the sync.
                Task datesTask = WithRetry(async () =>
                {
                    int cid = appSettings.SelectedColonyId > 0 ? appSettings.SelectedColonyId : 1;
                    var req = new HttpRequestMessage(HttpMethod.Get, $"{WILDWATCH_REPORTS_URL}?report=breeding_dates&colony_id={cid}");
                    req.Headers.Add("Authorization", $"Bearer {token}");
                    var resp = await _httpClient.SendAsync(req);
                    if (resp.StatusCode == System.Net.HttpStatusCode.Unauthorized) { authFailed = true; return 0; }
                    resp.EnsureSuccessStatusCode();
                    var datesJson = await resp.Content.ReadAsStringAsync();
                    if (string.IsNullOrEmpty(datesJson) || !datesJson.TrimStart().StartsWith("{"))
                        throw new Exception("Breeding dates API: expected JSON object");
                    var parsed = JsonConvert.DeserializeObject<Dictionary<string, BoxPredictedDates>>(datesJson);
                    File.WriteAllText(Path.Combine(context.FilesDir?.AbsolutePath, BREEDING_DATES_FILENAME), datesJson);
                    return parsed?.Count ?? 0;
                }, "Breeding dates", null, isCancelled);

                // Tags: fetch + sync
                Task<BoxTagService.SyncResult?> tagSyncTask;
                if (boxTags != null && BoxTagService.IsApiConfigured && context?.FilesDir?.AbsolutePath != null)
                    tagSyncTask = WithRetry(async () =>
                    {
                        var tagResult = await BoxTagService.SyncWithApiAsync(boxTags, context.FilesDir.AbsolutePath, validBoxIds);
                        if (tagResult.Error != null) throw new Exception(tagResult.Error);
                        return (BoxTagService.SyncResult?)tagResult;
                    }, "Tags", s => onLineProgress?.Invoke(2, s), isCancelled);
                else
                    tagSyncTask = Task.FromResult<BoxTagService.SyncResult?>(null);

                // Wait for all — don't throw if individual tasks fail
                try { await Task.WhenAll(boxesTask, birdsTask, tagSyncTask, bioTask, datesTask); } catch { }

                // Save colony state after all tasks complete (boxes task already mutated it)
                SaveColonyState(context, colonyState);

                if (authFailed) { result.Error = "Session expired. Please log in again."; result.AuthFailed = true; return result; }
                if (boxesTask.IsFaulted) { result.Error = $"Boxes: {boxesTask.Exception?.InnerException?.Message ?? "Failed"}"; return result; }
                if (birdsTask.IsFaulted)
                    result.Error = $"Penguin data: {birdsTask.Exception?.InnerException?.Message ?? "Failed"}";

                // Process tag results
                if (tagSyncTask.IsFaulted)
                {
                    result.TagSyncResult = new BoxTagService.SyncResult { Error = tagSyncTask.Exception?.InnerException?.Message ?? "Failed" };
                    onLineProgress?.Invoke(2, "Tags ✗");
                }
                else
                {
                    var tagSyncResult = await tagSyncTask;
                    result.TagSyncResult = tagSyncResult;
                    if (tagSyncResult != null)
                    {
                        result.BoxTags = tagSyncResult.Tags;
                        result.BoxTagError = tagSyncResult.Error;
                        onLineProgress?.Invoke(2, $"{tagSyncResult.Tags.Count} box tags ✓");
                    }
                }
            }
            catch (Exception ex)
            {
                result.Error = ex.Message;
            }
            return result;
        }

        /// <summary>
        /// Upload confirmed edits after user approval.
        /// </summary>
        internal async Task<int> UploadConfirmedEdits(ColonyState colonyState, AppSettings appSettings, List<string> confirmedBoxNames)
        {
            var token = appSettings.AuthToken;
            if (string.IsNullOrEmpty(token)) return 0;

            var uploads = new List<object>();
            foreach (var boxName in confirmedBoxNames)
            {
                var pending = colonyState.PendingObservations.FirstOrDefault(p => p.BoxName == boxName && p.IsPendingUpload);
                if (pending == null) continue;

                var scans = new List<object>();
                foreach (var scan in pending.ScannedIds)
                {
                    scans.Add(new {
                        pit_id = scan.BirdId,
                        scan_time_utc = scan.Timestamp.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                        latitude = scan.Latitude, longitude = scan.Longitude, accuracy = scan.Accuracy,
                    });
                }
                uploads.Add(new {
                    box_name = pending.BoxName,
                    observation_id = pending.ObservationId,
                    observation_time_utc = ObsTimeUtc(pending),
                    adults = pending.Adults, eggs = pending.Eggs, chicks = pending.Chicks,
                    breeding_status = pending.BreedingStatus, gate_status = pending.GateStatus,
                    notes = pending.Notes, scans = scans,
                });
            }

            if (uploads.Count == 0) return 0;

            var body = JsonConvert.SerializeObject(new { daily_label = colonyState.DailyLabel, observations = uploads });
            var request = new HttpRequestMessage(HttpMethod.Post, $"{WILDWATCH_SYNC_URL}?action=confirm");
            request.Headers.Add("Authorization", $"Bearer {token}");
            request.Content = new StringContent(body, Encoding.UTF8, "application/json");

            var response = await _httpClient.SendAsync(request);
            var json = await response.Content.ReadAsStringAsync();
            var uploadResult = JsonConvert.DeserializeObject<Dictionary<string, object>>(json);

            int uploaded = 0;
            if (uploadResult != null && uploadResult.ContainsKey("created"))
            {
                var created = JsonConvert.DeserializeObject<List<Dictionary<string, object>>>(uploadResult["created"].ToString());
                foreach (var c in created ?? new())
                {
                    var boxName = c["box_name"]?.ToString();
                    if (boxName != null)
                    {
                        var match = colonyState.PendingObservations.FirstOrDefault(p => p.BoxName == boxName && p.IsPendingUpload);
                        if (match != null)
                        {
                            colonyState.PendingObservations.Remove(match);
                            match.IsPendingUpload = false;
                            var nzDate = MainActivity.ToNzTime(match.WhenDataCollectedUtc).Date;
                            if (nzDate == MainActivity.NzToday)
                                colonyState.TodayBoxes[boxName] = match;
                        }
                        uploaded++;
                    }
                }
            }
            return uploaded;
        }

        /// <summary>
        /// Upload-only: send pending observations to server, check for conflicts. No download.
        /// </summary>
        internal async Task<SyncResult> UploadPendingOnly(ColonyState colonyState, AppSettings appSettings)
        {
            var result = new SyncResult();
            var token = appSettings.AuthToken;
            if (string.IsNullOrEmpty(token)) { result.Error = "Not logged in"; result.AuthFailed = true; return result; }
            if (colonyState.PendingObservations.Count(p => p.IsPendingUpload) == 0) return result;

            var pendingBoxes = new List<object>();
            foreach (var pending in colonyState.PendingObservations)
            {
                if (!pending.IsPendingUpload || string.IsNullOrEmpty(pending.BoxName)) continue;
                var scans = pending.ScannedIds.Select(scan => (object)new {
                    pit_id = scan.BirdId,
                    scan_time_utc = scan.Timestamp.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                    latitude = scan.Latitude, longitude = scan.Longitude, accuracy = scan.Accuracy,
                }).ToList();
                var obsPayload = new Dictionary<string, object?>
                {
                    ["box_name"] = pending.BoxName,
                    ["observation_time_utc"] = ObsTimeUtc(pending),
                    ["adults"] = pending.Adults, ["eggs"] = pending.Eggs, ["chicks"] = pending.Chicks,
                    ["breeding_status"] = pending.BreedingStatus, ["gate_status"] = pending.GateStatus,
                    ["notes"] = pending.Notes, ["scans"] = scans,
                };
                if (pending.ConfirmedAgainstObsId.HasValue)
                    obsPayload["expected_observation_id"] = pending.ConfirmedAgainstObsId.Value;
                pendingBoxes.Add(obsPayload);
            }

            var uploadBody = JsonConvert.SerializeObject(new { daily_label = colonyState.DailyLabel, observations = pendingBoxes });
            var request = new HttpRequestMessage(HttpMethod.Post, $"{WILDWATCH_SYNC_URL}?action=upload&colony_id={(appSettings.SelectedColonyId > 0 ? appSettings.SelectedColonyId : 1)}");
            request.Headers.Add("Authorization", $"Bearer {token}");
            request.Content = new StringContent(uploadBody, Encoding.UTF8, "application/json");

            var response = await _httpClient.SendAsync(request);
            if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized) { result.Error = "Session expired"; result.AuthFailed = true; return result; }

            var json = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode || string.IsNullOrEmpty(json) || !json.TrimStart().StartsWith("{"))
            { result.Error = $"Upload failed ({(int)response.StatusCode}): {json?.Substring(0, Math.Min(json?.Length ?? 0, 200))}"; return result; }

            var uploadResult = JsonConvert.DeserializeObject<Dictionary<string, object>>(json);
            if (uploadResult != null && uploadResult.ContainsKey("created"))
            {
                var created = JsonConvert.DeserializeObject<List<Dictionary<string, object>>>(uploadResult["created"].ToString());
                result.Uploaded = created?.Count ?? 0;
                foreach (var c in created ?? new())
                {
                    var boxName = c["box_name"]?.ToString();
                    if (boxName != null)
                    {
                        var match = colonyState.PendingObservations.FirstOrDefault(p => p.BoxName == boxName && p.IsPendingUpload);
                        if (match != null)
                        {
                            colonyState.PendingObservations.Remove(match);
                            // Move to TodayBoxes so it stays visible locally
                            match.IsPendingUpload = false;
                            var nzDate = MainActivity.ToNzTime(match.WhenDataCollectedUtc).Date;
                            if (nzDate == MainActivity.NzToday)
                                colonyState.TodayBoxes[boxName] = match;
                        }
                    }
                }
            }
            if (uploadResult != null && uploadResult.ContainsKey("errors"))
            {
                var errors = JsonConvert.DeserializeObject<List<object>>(uploadResult["errors"].ToString());
                result.UploadErrors = errors?.Count ?? 0;
            }
            if (uploadResult != null && uploadResult.ContainsKey("conflicts"))
                result.Conflicts = JsonConvert.DeserializeObject<List<SyncConflict>>(uploadResult["conflicts"].ToString());

            return result;
        }

        // ===== Biometrics: cache + queue =====

        /// <summary>Build a BiometricRecord from a crud.php penguin_biometric_data row.</summary>
        private static BiometricRecord BiometricRecordFromRow(Dictionary<string, object> row, string dateFallback)
        {
            string? S(string k) => row.TryGetValue(k, out var v) && v != null ? v.ToString() : null;
            bool B(string k) { var s = S(k); return s == "1" || string.Equals(s, "true", StringComparison.OrdinalIgnoreCase); }
            int? I(string k) { var s = S(k); return int.TryParse(s, out var n) ? n : (int?)null; }
            return new BiometricRecord
            {
                PengNum = S("peng_num") ?? "",
                ObservationDate = S("observation_date") ?? dateFallback,
                Weight = S("weight"),
                FlipperLength = S("flipper_length"),
                ObservedSex = S("observed_sex"),
                ConditionMoulting = B("condition_moulting"),
                ConditionTicks = B("condition_ticks"),
                ConditionDead = B("condition_dead"),
                Notes = S("notes"),
                BiometricId = I("biometric_id"),
                IsPendingUpload = false,
            };
        }

        private static int? ExtractBiometricId(string createResponseJson)
        {
            try
            {
                var obj = JsonConvert.DeserializeObject<Dictionary<string, object>>(createResponseJson);
                if (obj == null) return null;
                foreach (var key in new[] { "biometric_id", "id" })
                    if (obj.TryGetValue(key, out var v) && v != null && int.TryParse(v.ToString(), out var n)) return n;
            }
            catch { }
            return null;
        }

        /// <summary>Upload all pending biometric edits via crud.php (create or update). Mutates colonyState.</summary>
        private async Task UploadPendingBiometrics(ColonyState colonyState, string token, SyncResult result)
        {
            foreach (var bio in colonyState.TodayBiometrics.Values.Where(b => b.IsPendingUpload).ToList())
            {
                try
                {
                    var fields = new Dictionary<string, object>
                    {
                        ["peng_num"] = bio.PengNum,
                        ["observation_date"] = bio.ObservationDate,
                    };
                    if (!string.IsNullOrEmpty(bio.Weight)) fields["weight"] = bio.Weight;
                    if (!string.IsNullOrEmpty(bio.FlipperLength)) fields["flipper_length"] = bio.FlipperLength;
                    if (!string.IsNullOrEmpty(bio.ObservedSex)) fields["observed_sex"] = bio.ObservedSex;
                    if (bio.ConditionMoulting) fields["condition_moulting"] = true;
                    if (bio.ConditionTicks) fields["condition_ticks"] = true;
                    if (bio.ConditionDead) fields["condition_dead"] = true;
                    if (!string.IsNullOrEmpty(bio.Notes)) fields["notes"] = bio.Notes;

                    var url = bio.BiometricId.HasValue
                        ? $"{WILDWATCH_API_URL}?action=update&table=penguin_biometric_data&id={bio.BiometricId.Value}"
                        : $"{WILDWATCH_API_URL}?action=create&table=penguin_biometric_data";
                    var req = new HttpRequestMessage(HttpMethod.Post, url);
                    req.Headers.Add("Authorization", $"Bearer {token}");
                    req.Content = new StringContent(JsonConvert.SerializeObject(fields), Encoding.UTF8, "application/json");
                    var resp = await _httpClient.SendAsync(req);
                    if (!resp.IsSuccessStatusCode) { result.BiometricUploadErrors++; continue; }

                    // Capture the new id on create so a later edit updates instead of duplicating
                    if (!bio.BiometricId.HasValue)
                        bio.BiometricId = ExtractBiometricId(await resp.Content.ReadAsStringAsync());
                    bio.IsPendingUpload = false;
                    result.BiometricsUploaded++;
                }
                catch { result.BiometricUploadErrors++; }
            }
        }

        /// <summary>Upload only pending biometrics (used for prompt background flush after a save).</summary>
        internal async Task<SyncResult> UploadPendingBiometricsOnly(ColonyState colonyState, AppSettings appSettings)
        {
            var result = new SyncResult();
            var token = appSettings.AuthToken;
            if (string.IsNullOrEmpty(token)) { result.Error = "Not logged in"; result.AuthFailed = true; return result; }
            await UploadPendingBiometrics(colonyState, token, result);
            return result;
        }

        public class SyncConflict
        {
            public string? box_name { get; set; }
            public SyncConflictObs? server { get; set; }
            public Dictionary<string, object>? incoming { get; set; }
        }
        public class SyncConflictObs
        {
            public int observation_id { get; set; }
            public string? observation_time_utc { get; set; }
            public string? observer_name { get; set; }
            public int adults { get; set; }
            public int eggs { get; set; }
            public int chicks { get; set; }
            public int no_scan { get; set; }
            public string? breeding_status { get; set; }
            public string? gate_status { get; set; }
            public string? notes { get; set; }
            public string? monitor_filename { get; set; }
            public List<SyncScan>? scans { get; set; }
        }

        // ===== JSON models for sync.php response =====

        private class SyncResponse
        {
            public string? snapshot_time { get; set; }
            public Dictionary<string, SyncBox>? boxes { get; set; }
            public Dictionary<string, SyncBox>? previous { get; set; }
            public List<SyncLocation>? locations { get; set; }
        }
        private class SyncBox
        {
            public int observation_id { get; set; }
            public int location_id { get; set; }
            public string? observation_time_utc { get; set; }
            public string? monitor_filename { get; set; }
            public string? observer_name { get; set; }
            public int adults { get; set; }
            public int eggs { get; set; }
            public int chicks { get; set; }
            public int no_scan { get; set; }
            public string? breeding_status { get; set; }
            public string? gate_status { get; set; }
            public string? notes { get; set; }
            public List<SyncScan>? scans { get; set; }
        }
        public class SyncScan
        {
            public string? pit_id { get; set; }
            public string? scan_time_utc { get; set; }
            public string? peng_num { get; set; }
            public string? sex { get; set; }
        }
        private class SyncLocation
        {
            public int location_id { get; set; }
            public string? location_name { get; set; }
            public string? persistent_notes { get; set; }
        }

        // ===== Colony State persistence =====

        public static void SaveColonyState(Android.Content.Context context, ColonyState state)
        {
            try
            {
                if (string.IsNullOrEmpty(context.FilesDir?.AbsolutePath)) return;
                var json = JsonConvert.SerializeObject(state, Formatting.Indented);
                var path = Path.Combine(context.FilesDir.AbsolutePath, COLONY_STATE_FILENAME);
                var tempPath = path + ".tmp";
                File.WriteAllText(tempPath, json);
                File.Move(tempPath, path, true);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"SaveColonyState failed: {ex.Message}");
            }
        }

        public static ColonyState LoadColonyState(Android.Content.Context context)
        {
            try
            {
                var path = Path.Combine(context.FilesDir?.AbsolutePath, COLONY_STATE_FILENAME);
                if (File.Exists(path))
                {
                    var json = File.ReadAllText(path);
                    var state = JsonConvert.DeserializeObject<ColonyState>(json);
                    if (state != null) return state;
                }

            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"LoadColonyState failed: {ex.Message}");
            }
            return new ColonyState();
        }

        // ===== App Settings =====

        public static void saveApplicationSettings(AppSettings appSettings)
        {
            try
            {
                string saveTo = Path.Combine(appSettings.filesDir, APP_SETTINGS_FILENAME);
                string tempFile = saveTo + ".tmp";
                var appSettingsJson = JsonConvert.SerializeObject(appSettings, Formatting.Indented);
                File.Delete(tempFile);
                File.WriteAllText(tempFile, appSettingsJson);
                AppSettings g = JsonConvert.DeserializeObject<AppSettings>(File.ReadAllText(tempFile));
                if (g.IsBlueToothEnabled != null)
                {
                    File.Move(tempFile, saveTo, true);
                    return;
                }
            }
            catch { }
        }

        public static AppSettings loadAppSettingsFromDir(string filesDir)
        {
            string appSettingsPath = Path.Combine(filesDir, APP_SETTINGS_FILENAME);
            try
            {
                return JsonConvert.DeserializeObject<AppSettings>(File.ReadAllText(appSettingsPath));
            }
            catch
            {
                return new AppSettings(filesDir);
            }
        }

        // ===== Remote Data Loaders (unchanged) =====

        public async Task<Dictionary<string, PenguinData>?> loadRemotePengInfoFromAppDataDir(Android.Content.Context? context)
        {
            try
            {
                string remoteBirdPath = Path.Combine(context.FilesDir?.AbsolutePath, REMOTE_BIRD_DATA_FILENAME);
                var remoteBirdJson = File.ReadAllText(remoteBirdPath);
                return JsonConvert.DeserializeObject<Dictionary<string, PenguinData>>(remoteBirdJson);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to load remote penguin data: {ex.Message}");
                return null;
            }
        }


        public async Task<Dictionary<string, BoxPredictedDates>?> loadBreedingDatesFromAppDataDir(Android.Content.Context? context)
        {
            try
            {
                string breedingDatesPath = Path.Combine(context.FilesDir?.AbsolutePath, BREEDING_DATES_FILENAME);
                var breedingDatesJson = File.ReadAllText(breedingDatesPath);
                return JsonConvert.DeserializeObject<Dictionary<string, BoxPredictedDates>>(breedingDatesJson);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to load predicted breeding data: {ex.Message}");
                return null;
            }
        }

        public Dictionary<string, BoxNoteData> LoadBoxNotesFromDisk(Android.Content.Context context)
        {
            try
            {
                string path = Path.Combine(context.FilesDir?.AbsolutePath, BOX_NOTES_FILENAME);
                if (File.Exists(path))
                {
                    var json = File.ReadAllText(path);
                    return JsonConvert.DeserializeObject<Dictionary<string, BoxNoteData>>(json) ?? new Dictionary<string, BoxNoteData>();
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to load box notes: {ex.Message}");
            }
            return new Dictionary<string, BoxNoteData>();
        }

        internal async Task<bool> UpdateBoxNotesAsync(int locationId, string notes, string token)
        {
            try
            {
                var request = new HttpRequestMessage(HttpMethod.Post, $"{WILDWATCH_API_URL}?action=update&table=observation_locations&id={locationId}");
                request.Headers.Add("Authorization", $"Bearer {token}");
                var body = JsonConvert.SerializeObject(new { persistent_notes = notes });
                request.Content = new StringContent(body, Encoding.UTF8, "application/json");
                var response = await _httpClient.SendAsync(request);
                return response.IsSuccessStatusCode;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to update box notes: {ex.Message}");
                return false;
            }
        }

        // Full reset: remove every file and subdirectory in the app's internal storage.
        // Used on logout so no cached colony/penguin data, box tags, notes, or settings
        // survive until the next login.
        public void ClearInternalStorageData(string filesDir)
        {
            try
            {
                if (string.IsNullOrEmpty(filesDir) || !Directory.Exists(filesDir)) return;
                foreach (var f in Directory.GetFiles(filesDir))
                {
                    try { File.Delete(f); } catch (Exception ex) { System.Diagnostics.Debug.WriteLine($"Clear: {f}: {ex.Message}"); }
                }
                foreach (var d in Directory.GetDirectories(filesDir))
                {
                    try { Directory.Delete(d, recursive: true); } catch (Exception ex) { System.Diagnostics.Debug.WriteLine($"Clear: {d}: {ex.Message}"); }
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to clear data: {ex.Message}");
            }
        }

        // ===== Breeding Status (uses server previous data instead of monitor history) =====

        internal static string GetBoxBreedingStatusString(string boxName, BoxObservation? currentBox, BoxObservation? previousBox)
        {
            // Use the previous observation from server to determine breeding status
            var obs = currentBox ?? previousBox;
            if (obs == null) return "";

            if (obs.BreedingStatus == "ABN") return "Abandoned";
            if (!string.IsNullOrEmpty(obs.BreedingStatus)) return obs.BreedingStatus;
            return "";
        }

        public static string breedingDateStatus(int daysSinceLaid)
        {
            DateTime estHatch = MainActivity.NzToday.AddDays(38 - daysSinceLaid);
            if (estHatch.AddDays(3) >= MainActivity.NzToday)
                return "Hatch" + getDateString(estHatch);

            DateTime estPG = MainActivity.NzToday.AddDays(52 - daysSinceLaid);
            if (estPG.AddDays(3) >= MainActivity.NzToday)
                return "PG" + getDateString(estPG);

            DateTime chipStart = MainActivity.NzToday.AddDays(80 - daysSinceLaid);
            if (chipStart.AddDays(3) >= MainActivity.NzToday)
                return "Chip" + getDateString(chipStart);

            DateTime estFledge = MainActivity.NzToday.AddDays(87 - daysSinceLaid);
            if (estFledge.AddDays(3) >= MainActivity.NzToday)
                return "Fledge" + getDateString(estFledge);
            return "";
        }

        private static string getDateString(DateTime expectedDate)
        {
            DateTime today = MainActivity.NzToday;
            if (expectedDate.Date.Equals(today)) return " today";
            if ((expectedDate.Date - today).TotalDays == 1 && expectedDate > today) return " tomorrow";
            if ((today - expectedDate.Date).TotalDays == 1) return " yesterday";
            if (expectedDate > today)
                return " " + Math.Ceiling((expectedDate - today).TotalDays) + " days";
            return " " + Math.Ceiling((today - expectedDate).TotalDays) + " days ago";
        }
    }
}
