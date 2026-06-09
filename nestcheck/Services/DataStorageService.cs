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
        private const string LEGACY_MONITOR_FILENAME = "penguin_data_autosave.json";
        internal const string REMOTE_BIRD_DATA_FILENAME = "remotePenguinData.json";
        internal const string REMOTE_BOX_DATA_FILENAME = "remoteBoxData.json";
        internal const string BOX_NOTES_FILENAME = "boxNotes.json";
        internal const string BREEDING_DATES_FILENAME = "predictedDates.json";

        private static readonly HttpClient _httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        internal const string WILDWATCH_BASE_URL = "https://wildwatch.co.nz/penguin-api";
        internal const string WILDWATCH_PENGUINS_URL = "https://wildwatch.co.nz/api/penguins.php";
        internal const string WILDWATCH_API_URL = "https://wildwatch.co.nz/api/crud.php";
        internal const string WILDWATCH_SYNC_URL = "https://wildwatch.co.nz/api/sync.php";
        internal const string WILDWATCH_API_KEY = "b30181424b2d70102fb90a32af6c013e63e7b0d49ae466ebf90aa0f969ddbe02";

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
            public string? Error { get; set; }
            public bool AuthFailed { get; set; }
            /// <summary>
            /// Server-detected conflicts: box already has today's data.
            /// </summary>
            public List<SyncConflict>? Conflicts { get; set; }
        }

        // ===== Main Sync: Upload dirty, download fresh state =====

        internal async Task<SyncResult> SyncWithServer(Android.Content.Context context, ColonyState colonyState, AppSettings appSettings, Dictionary<string, BoxTag>? boxTags = null, ICollection<string>? validBoxIds = null)
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

                // Fetch default colony if not set
                if (appSettings.SelectedColonyId == 0 || string.IsNullOrEmpty(appSettings.SelectedColonyName))
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
                                var first = colonies[0];
                                appSettings.SelectedColonyId = Convert.ToInt32(first["colony_id"]);
                                appSettings.SelectedColonyName = first["colony_name"]?.ToString() ?? "";
                                appSettings.AllBoxSetsString = first["location_sets_string"]?.ToString() ?? "";
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
                var dirtyBoxes = new List<object>();
                foreach (var pending in colonyState.PendingObservations)
                {
                    if (!pending.IsDirty || string.IsNullOrEmpty(pending.BoxName)) continue;
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
                    dirtyBoxes.Add(new {
                        box_name = pending.BoxName,
                        observation_time_utc = pending.WhenDataCollectedUtc.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                        adults = pending.Adults,
                        eggs = pending.Eggs,
                        chicks = pending.Chicks,
                        breeding_status = pending.BreedingStatus,
                        gate_status = pending.GateStatus,
                        notes = pending.Notes,
                        scans = scans,
                    });
                }

                if (dirtyBoxes.Count > 0)
                {
                    var uploadBody = JsonConvert.SerializeObject(new {
                        daily_label = colonyState.DailyLabel,
                        observations = dirtyBoxes,
                    });
                    var uploadRequest = new HttpRequestMessage(HttpMethod.Post, $"{WILDWATCH_SYNC_URL}?action=upload");
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
                                var match = colonyState.PendingObservations.FirstOrDefault(p => p.BoxName == boxName && p.IsDirty);
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

                // Step 2: Download fresh state from server (parallel with penguin data + box tags)
                var downloadRequest = new HttpRequestMessage(HttpMethod.Get, WILDWATCH_SYNC_URL);
                downloadRequest.Headers.Add("Authorization", $"Bearer {token}");
                Task<HttpResponseMessage> stateTask = _httpClient.SendAsync(downloadRequest);

                Task<HttpResponseMessage> birdsTask = _httpClient.GetAsync(WILDWATCH_PENGUINS_URL);

                Task<BoxTagService.SyncResult?> tagSyncTask;
                if (boxTags != null && BoxTagService.IsApiConfigured && context?.FilesDir?.AbsolutePath != null)
                    tagSyncTask = BoxTagService.SyncWithApiAsync(boxTags, context.FilesDir.AbsolutePath, validBoxIds)
                        .ContinueWith(t => (BoxTagService.SyncResult?)t.Result);
                else
                    tagSyncTask = Task.FromResult<BoxTagService.SyncResult?>(null);

                await Task.WhenAll(stateTask, birdsTask, tagSyncTask);
                sw.Stop();
                System.Diagnostics.Debug.WriteLine($"SyncWithServer total: {sw.ElapsedMilliseconds}ms");

                // Step 2a: Process state download
                var stateResponse = await stateTask;
                if (stateResponse.StatusCode == System.Net.HttpStatusCode.Unauthorized)
                {
                    result.Error = "Session expired. Please log in again.";
                    result.AuthFailed = true;
                    return result;
                }
                stateResponse.EnsureSuccessStatusCode();
                var stateJson = await stateResponse.Content.ReadAsStringAsync();
                if (string.IsNullOrEmpty(stateJson) || !stateJson.TrimStart().StartsWith("{"))
                    throw new Exception($"Sync API: expected JSON object, got: {stateJson?.Substring(0, Math.Min(stateJson?.Length ?? 0, 100))}");

                var serverState = JsonConvert.DeserializeObject<SyncResponse>(stateJson);

                // Update from server — additive, never remove local data
                // PreviousBoxes can be fully replaced (read-only server data)
                colonyState.PreviousBoxes.Clear();
                var nzToday = MainActivity.NzToday;
                if (serverState?.boxes != null)
                {
                    foreach (var kvp in serverState.boxes)
                    {
                        var b = kvp.Value;
                        var obs = BoxObservation.FromServerData(
                            b.observation_id, b.location_id, b.observation_time_utc,
                            b.adults, b.eggs, b.chicks,
                            b.breeding_status, b.gate_status, b.notes ?? "", b.monitor_filename,
                            b.observer_name);
                        obs.BoxName = kvp.Key;

                        // Add scans from server
                        if (b.scans != null)
                        {
                            foreach (var scan in b.scans)
                            {
                                obs.ScannedIds.Add(new ScanRecord
                                {
                                    BirdId = scan.pit_id ?? "",
                                    Timestamp = DateTime.TryParse(scan.scan_time_utc, out var st) ? st : DateTime.UtcNow,
                                });
                            }
                        }

                        var obsNzDate = MainActivity.ToNzTime(obs.WhenDataCollectedUtc).Date;
                        if (obsNzDate == nzToday)
                        {
                            // Don't overwrite if there's a local pending edit for this box today
                            bool hasPendingEdit = colonyState.PendingObservations.Any(p =>
                                p.BoxName == kvp.Key && p.IsDirty &&
                                MainActivity.ToNzTime(p.WhenDataCollectedUtc).Date == nzToday);
                            if (!hasPendingEdit)
                            {
                                obs.IsDirty = false;
                                colonyState.TodayBoxes[kvp.Key] = obs;
                            }
                        }
                        else
                        {
                            colonyState.PreviousBoxes[kvp.Key] = obs;
                        }
                    }
                    result.BoxCount = serverState.boxes.Count;
                }

                // Process previous observations (for boxes where latest is today)
                if (serverState?.previous != null)
                {
                    foreach (var kvp in serverState.previous)
                    {
                        var b = kvp.Value;
                        var obs = BoxObservation.FromServerData(
                            b.observation_id, b.location_id, b.observation_time_utc,
                            b.adults, b.eggs, b.chicks,
                            b.breeding_status, b.gate_status, b.notes ?? "", b.monitor_filename,
                            b.observer_name);
                        obs.BoxName = kvp.Key;

                        if (b.scans != null)
                        {
                            foreach (var scan in b.scans)
                            {
                                obs.ScannedIds.Add(new ScanRecord
                                {
                                    BirdId = scan.pit_id ?? "",
                                    Timestamp = DateTime.TryParse(scan.scan_time_utc, out var st) ? st : DateTime.UtcNow,
                                });
                            }
                        }

                        colonyState.PreviousBoxes[kvp.Key] = obs;
                    }
                }

                colonyState.LastSyncedUtc = DateTime.UtcNow;

                // Step 2b: Process penguin data
                var birdsResponse = await birdsTask;
                birdsResponse.EnsureSuccessStatusCode();
                var birdsJson = await birdsResponse.Content.ReadAsStringAsync();
                if (string.IsNullOrEmpty(birdsJson) || !birdsJson.TrimStart().StartsWith("["))
                    throw new Exception($"Penguins API: expected JSON array, got: {birdsJson?.Substring(0, Math.Min(birdsJson?.Length ?? 0, 100))}");
                var penguinRecords = JsonConvert.DeserializeObject<List<WildWatchPenguin>>(birdsJson);

                var remotePenguinData = new Dictionary<string, PenguinData>();
                foreach (var record in penguinRecords)
                {
                    if (string.IsNullOrEmpty(record.pit_id) || record.pit_id.Length < 8) continue;
                    var cleanId = new string(record.pit_id.Where(char.IsLetterOrDigit).ToArray());
                    var eightDigitId = cleanId.Length >= 8 ? cleanId.Substring(cleanId.Length - 8).ToUpper() : cleanId.ToUpper();
                    if (eightDigitId.Length != 8) continue;

                    var lifeStage = LifeStage.Adult;
                    if (!string.IsNullOrEmpty(record.life_stage))
                        Enum.TryParse<LifeStage>(record.life_stage, true, out lifeStage);

                    remotePenguinData[eightDigitId] = new PenguinData
                    {
                        ScannedId = eightDigitId,
                        PengNum = record.peng_num ?? "",
                        LastKnownLifeStage = lifeStage,
                        Sex = record.sex ?? "",
                        VidForScanner = record.vid_for_scanner ?? "",
                        ChipDate = DateTime.TryParse(record.chip_date, out DateTime cd) ? cd : DateTime.MinValue,
                        ChipAs = record.chipped_as_adult == 1 ? "Adult" : "",
                        ChickSizeCode = record.chick_size_code ?? ""
                    };
                }

                File.WriteAllText(Path.Combine(context.FilesDir?.AbsolutePath, REMOTE_BIRD_DATA_FILENAME),
                    JsonConvert.SerializeObject(remotePenguinData, Formatting.Indented));
                result.BirdCount = remotePenguinData.Count;

                // Step 2c: Box tag sync results
                var tagSyncResult = await tagSyncTask;
                result.TagSyncResult = tagSyncResult;
                if (tagSyncResult != null)
                {
                    result.BoxTags = tagSyncResult.Tags;
                    result.BoxTagError = tagSyncResult.Error;
                }

                // Save colony state to disk
                SaveColonyState(context, colonyState);
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
                var pending = colonyState.PendingObservations.FirstOrDefault(p => p.BoxName == boxName && p.IsDirty);
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
                    observation_time_utc = pending.WhenDataCollectedUtc.ToString("yyyy-MM-ddTHH:mm:ssZ"),
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
                        var match = colonyState.PendingObservations.FirstOrDefault(p => p.BoxName == boxName && p.IsDirty);
                        if (match != null) colonyState.PendingObservations.Remove(match);
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
            if (colonyState.PendingObservations.Count(p => p.IsDirty) == 0) return result;

            var dirtyBoxes = new List<object>();
            foreach (var pending in colonyState.PendingObservations)
            {
                if (!pending.IsDirty || string.IsNullOrEmpty(pending.BoxName)) continue;
                var scans = pending.ScannedIds.Select(scan => (object)new {
                    pit_id = scan.BirdId,
                    scan_time_utc = scan.Timestamp.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                    latitude = scan.Latitude, longitude = scan.Longitude, accuracy = scan.Accuracy,
                }).ToList();
                dirtyBoxes.Add(new {
                    box_name = pending.BoxName,
                    observation_time_utc = pending.WhenDataCollectedUtc.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                    adults = pending.Adults, eggs = pending.Eggs, chicks = pending.Chicks,
                    breeding_status = pending.BreedingStatus, gate_status = pending.GateStatus,
                    notes = pending.Notes, scans = scans,
                });
            }

            var uploadBody = JsonConvert.SerializeObject(new { daily_label = colonyState.DailyLabel, observations = dirtyBoxes });
            var request = new HttpRequestMessage(HttpMethod.Post, $"{WILDWATCH_SYNC_URL}?action=upload");
            request.Headers.Add("Authorization", $"Bearer {token}");
            request.Content = new StringContent(uploadBody, Encoding.UTF8, "application/json");

            var response = await _httpClient.SendAsync(request);
            if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized) { result.Error = "Session expired"; result.AuthFailed = true; return result; }

            var json = await response.Content.ReadAsStringAsync();
            if (string.IsNullOrEmpty(json) || !json.TrimStart().StartsWith("{"))
            { result.Error = $"Upload failed: {json?.Substring(0, Math.Min(json?.Length ?? 0, 100))}"; return result; }

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
                        var match = colonyState.PendingObservations.FirstOrDefault(p => p.BoxName == boxName && p.IsDirty);
                        if (match != null) colonyState.PendingObservations.Remove(match);
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

                // Try loading legacy monitor data and migrating
                var legacyPath = Path.Combine(context.FilesDir?.AbsolutePath, LEGACY_MONITOR_FILENAME);
                if (File.Exists(legacyPath))
                {
                    var json = File.ReadAllText(legacyPath);
                    var legacy = JsonConvert.DeserializeObject<Dictionary<int, MonitorDetails>>(json);
                    if (legacy != null && legacy.ContainsKey(0))
                    {
                        var state = new ColonyState();
                        foreach (var kvp in legacy[0].BoxData)
                        {
                            var obs = new BoxObservation
                            {
                                BoxName = kvp.Key,
                                ScannedIds = kvp.Value.ScannedIds,
                                Adults = kvp.Value.Adults,
                                Eggs = kvp.Value.Eggs,
                                Chicks = kvp.Value.Chicks,
                                GateStatus = kvp.Value.GateStatus,
                                Notes = kvp.Value.Notes,
                                WhenDataCollectedUtc = kvp.Value.whenDataCollectedUtc,
                                BreedingStatus = kvp.Value.BreedingChance,
                                IsDirty = true,
                                DirtyTimestampUtc = DateTime.UtcNow,
                            };
                            state.PendingObservations.Add(obs);
                        }
                        System.Diagnostics.Debug.WriteLine($"Migrated {state.PendingObservations.Count} boxes from legacy format");
                        SaveColonyState(context, state);
                        return state;
                    }
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

        public async Task<Dictionary<int, BoxRemoteData>?> loadRemoteBoxInfoFromAppDataDir(Android.Content.Context? context)
        {
            try
            {
                string remoteBoxDataPath = Path.Combine(context.FilesDir?.AbsolutePath, REMOTE_BOX_DATA_FILENAME);
                var remoteBoxDataJson = File.ReadAllText(remoteBoxDataPath);
                return JsonConvert.DeserializeObject<Dictionary<int, BoxRemoteData>>(remoteBoxDataJson);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to load remote box data: {ex.Message}");
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

        public void ClearInternalStorageData(string filesDir)
        {
            try
            {
                if (string.IsNullOrEmpty(filesDir)) return;
                foreach (var f in new[] { COLONY_STATE_FILENAME, LEGACY_MONITOR_FILENAME })
                {
                    var path = Path.Combine(filesDir, f);
                    if (File.Exists(path)) File.Delete(path);
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
