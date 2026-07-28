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
        private const string USERS_FILENAME = "wildwatch_users.json";

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
            /// <summary>What the server refused, box by box. An observation whose scan was rejected
            /// still lands, so the box stops being pending — a bare count here is a bird's scan
            /// disappearing with nobody told which bird, or which box.</summary>
            public List<string> UploadErrorDetails { get; set; } = new List<string>();
            public int Reconciled { get; set; } // pending boxes matched to identical server data before upload
            public int BiometricCount { get; set; }
            public int BiometricsUploaded { get; set; }
            public int BiometricUploadErrors { get; set; }
            /// <summary>Why each biometric upload failed, in the server's words. A failed biometric
            /// stays queued, so the sync is not a clean one and must not report itself as such.</summary>
            public List<string> BiometricErrors { get; set; } = new List<string>();
            public string? Error { get; set; }
            /// <summary>Non-fatal notes from the offline-chip flush (e.g. a bird the server
            /// rejected). Kept out of Error so the sync still counts as successful — a queued-chip
            /// problem must not read as a failed download or stop background polling.</summary>
            public List<string>? ChipWarnings { get; set; }
            public bool AuthFailed { get; set; }
            /// <summary>
            /// Server-detected conflicts: box already has today's data.
            /// </summary>
            public List<SyncConflict>? Conflicts { get; set; }
        }

        /// <summary>The queued observation a server reply is about. Several days can be queued for
        /// one box after a spell out of signal, so the day the server names picks the right one;
        /// clearing another day's round would leave it to upload a second time. Falls back to the
        /// box's oldest queued round when the server didn't say (older server).</summary>
        private static BoxObservation? MatchPending(ColonyState colonyState, string boxName, string? nzDate)
        {
            var forBox = colonyState.PendingObservations
                .Where(p => p.BoxName == boxName && p.IsPendingUpload)
                .OrderBy(p => p.WhenDataCollectedUtc);
            if (!string.IsNullOrEmpty(nzDate) && DateTime.TryParse(nzDate, out var d))
            {
                var exact = forBox.FirstOrDefault(p => MainActivity.ToNzTime(p.WhenDataCollectedUtc).Date == d.Date);
                if (exact != null) return exact;
            }
            return forBox.FirstOrDefault();
        }

        private static string? CreatedNzDate(Dictionary<string, object> created) =>
            created.TryGetValue("nz_date", out var v) ? v?.ToString() : null;

        /// <summary>The NZ day a conflict's rejected observation was made on — read from the copy of
        /// it the server echoed back, so the right queued round is the one shown and replaced.</summary>
        internal static string? ConflictNzDate(SyncConflict conflict)
        {
            if (conflict.incoming == null) return null;
            if (!conflict.incoming.TryGetValue("observation_time_utc", out var t) || t == null) return null;
            return DateTime.TryParse(t.ToString(), null,
                       System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out var utc)
                ? MainActivity.ToNzTime(utc).ToString("yyyy-MM-dd") : null;
        }

        /// <summary>The queued round a conflict is about, picked by box and day.</summary>
        internal static BoxObservation? PendingForConflict(ColonyState colonyState, SyncConflict conflict) =>
            MatchPending(colonyState, conflict.box_name ?? "", ConflictNzDate(conflict));

        /// <summary>Does this box hold local work for that day that the server hasn't got? Either
        /// queued for upload, or a draft the box hasn't been locked on yet. Both must survive a
        /// download: a draft is invisible once the server's copy takes its place in TodayBoxes, and
        /// since drafts are never uploaded, overwriting one silently threw the edit away.</summary>
        private static bool HasUnsentLocalEdit(ColonyState colonyState, string boxName, DateTime nzDate) =>
            colonyState.PendingObservations.Any(p => p.BoxName == boxName
                && (p.IsPendingUpload || p.IsDraft)
                && MainActivity.ToNzTime(p.WhenDataCollectedUtc).Date == nzDate);

        // The colony every crud.php write belongs to. Bare peng_nums are resolved against it
        // server-side, so leaving it off silently files another colony's bird under Tarakohe's.
        private static int ColonyIdOf(AppSettings s) => s.SelectedColonyId > 0 ? s.SelectedColonyId : 1;

        // Observation time for upload. If the observation has no valid timestamp
        // (e.g. a chick added with no scan to seed one), default to now.
        private static string ObsTimeUtc(BoxObservation o)
        {
            var t = o.WhenDataCollectedUtc;
            if (t == default || t.Year < 2000) t = DateTime.UtcNow;
            return t.ToString("yyyy-MM-ddTHH:mm:ssZ");
        }

        // Full tag identity: upper-cased with any leading alpha prefix (e.g. "LA") stripped, so a
        // 15-digit tag and its "LA"+15 form compare equal. Free-text manual entry was removed, so
        // every scan is now a full tag (scanner or search) — we compare the whole number, not a tail.
        public static string PitFull(string? id)
        {
            id = (id ?? "").ToUpperInvariant();
            int i = 0;
            while (i < id.Length && char.IsLetter(id[i])) i++;
            return id.Substring(i);
        }

        // A content fingerprint of an observation (ignores time/observer/id): counts, statuses,
        // notes, no-scan count, and the exact set of scanned birds. Two observations with the
        // same signature carry the same data. Shared by the download-first reconcile and the
        // conflict-dialog guard so "identical" means the same thing in both.
        public static string BoxSignature(BoxObservation o)
        {
            string N(string? s) => (s ?? "").Trim();
            bool IsNoScan(string? id) => (id ?? "").StartsWith("NOSCAN", StringComparison.OrdinalIgnoreCase);
            int noScan = o.ScannedIds.Count(s => IsNoScan(s.BirdId));
            var pits = o.ScannedIds.Where(s => !IsNoScan(s.BirdId)).Select(s => PitFull(s.BirdId)).OrderBy(x => x, StringComparer.Ordinal);
            // Losses count as content: without them an edit that only recorded a failed egg looked
            // identical to the server row, so the reconcile adopted the server copy and the loss was
            // never uploaded. Null and 0 compare equal — "not recorded" and "none" are the same box.
            return $"{o.Adults}|{o.Eggs}|{o.Chicks}|{N(o.BreedingStatus).ToUpperInvariant()}|{N(o.GateStatus).ToUpperInvariant()}|{N(o.Notes)}|{noScan}|{string.Join(",", pits)}|{o.FailedEggs ?? 0}|{o.DeadChicks ?? 0}";
        }

        // Download-first reconcile: before uploading, pull current server state and drop any
        // pending box whose data already matches the server. On a patchy connection a write can
        // commit server-side while the reply is lost, leaving the box queued; without this it
        // would re-upload and the server would report its own saved row back as a "replace"
        // conflict. Adopting the server row (with its observation_id) resolves it silently and
        // stops the box re-uploading. Returns the number reconciled.
        internal async Task<int> ReconcilePendingBeforeUpload(ColonyState colonyState, AppSettings appSettings, string token)
        {
            var pending = colonyState.PendingObservations
                .Where(p => p.IsPendingUpload && !string.IsNullOrEmpty(p.BoxName)).ToList();
            if (pending.Count == 0) return 0;

            var req = new HttpRequestMessage(HttpMethod.Get,
                $"{WILDWATCH_SYNC_URL}?colony_id={(appSettings.SelectedColonyId > 0 ? appSettings.SelectedColonyId : 1)}");
            req.Headers.Add("Authorization", $"Bearer {token}");
            var resp = await _httpClient.SendAsync(req);
            if (!resp.IsSuccessStatusCode) return 0;
            var json = await resp.Content.ReadAsStringAsync();
            if (string.IsNullOrWhiteSpace(json) || !json.TrimStart().StartsWith("{")) return 0;
            var serverState = JsonConvert.DeserializeObject<SyncResponse>(json);
            if (serverState?.boxes == null) return 0;

            var nzToday = MainActivity.NzToday;
            int reconciled = 0;
            foreach (var p in pending)
            {
                if (!serverState.boxes.TryGetValue(p.BoxName!, out var b)) continue;
                var serverObs = BoxObservation.FromServerData(b.observation_id, b.location_id, b.observation_time_utc,
                    b.adults, b.eggs, b.chicks, b.breeding_status, b.gate_status, b.notes ?? "", b.monitor_filename,
                    b.observer_name, b.failed_eggs, b.dead_chicks);
                serverObs.BoxName = p.BoxName;
                if (b.scans != null) foreach (var s in b.scans) serverObs.ScannedIds.Add(new ScanRecord { BirdId = s.pit_id ?? "" });
                for (int ns = 0; ns < b.no_scan; ns++) serverObs.ScannedIds.Add(new ScanRecord { BirdId = $"NOSCAN_{ns + 1}" });
                // Only a server row for the same NZ day can be the twin of a pending box.
                if (MainActivity.ToNzTime(serverObs.WhenDataCollectedUtc).Date != nzToday) continue;
                if (BoxSignature(serverObs) != BoxSignature(p)) continue; // genuinely different — leave it to upload/conflict

                colonyState.PendingObservations.Remove(p);
                serverObs.IsPendingUpload = false;
                colonyState.TodayBoxes[p.BoxName!] = serverObs; // adopt the server copy incl. its observation_id
                reconciled++;
            }
            return reconciled;
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

                // Step 0: Download-first reconcile — drop pending boxes whose data already
                // matches the server (a lost reply on a patchy connection re-queues an
                // observation the server already saved), so we never re-upload them or get
                // asked to replace identical data.
                result.Reconciled = await ReconcilePendingBeforeUpload(colonyState, appSettings, token);

                // Step 0b: birds chipped while offline go up BEFORE the observations that scanned
                // them. The server resolves each scan against the chips it knows: a pit_id it has
                // never seen is dropped from the observation with an error, and since the
                // observation itself lands, the box stops being pending and that scan is gone for
                // good. Creating the bird first is what makes its scan resolvable.
                var chipWarnings = await FlushQueuedChips(context, appSettings);
                if (chipWarnings.Count > 0) result.ChipWarnings = chipWarnings;

                // Step 1: Upload ALL pending observations — server detects conflicts
                var pendingBoxes = colonyState.PendingObservations
                    .Where(p => p.IsPendingUpload && !string.IsNullOrEmpty(p.BoxName))
                    .Select(p => (object)BuildObservationPayload(p))
                    .ToList();

                if (pendingBoxes.Count > 0)
                {
                    var uploadBody = JsonConvert.SerializeObject(BuildUploadBody(colonyState, pendingBoxes));
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
                    // A gateway error page or an empty body here used to surface as a raw JSON
                    // parser message with nothing to act on; name the responder instead.
                    if (string.IsNullOrWhiteSpace(uploadJson) || !uploadJson.TrimStart().StartsWith("{"))
                        throw new Exception($"Upload: {ServerMessage(uploadJson, (int)uploadResponse.StatusCode)}");
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
                                var match = MatchPending(colonyState, boxName, CreatedNzDate(c));
                                if (match != null)
                                    colonyState.PendingObservations.Remove(match);
                            }
                        }
                    }
                    if (uploadResult != null && uploadResult.ContainsKey("errors"))
                    {
                        var errors = JsonConvert.DeserializeObject<List<object>>(uploadResult["errors"].ToString());
                        result.UploadErrors = errors?.Count ?? 0;
                        result.UploadErrorDetails.AddRange(DescribeUploadErrors(uploadResult["errors"]));
                    }
                    // Server-detected conflicts (box already has today's data)
                    if (uploadResult != null && uploadResult.ContainsKey("conflicts"))
                    {
                        result.Conflicts = JsonConvert.DeserializeObject<List<SyncConflict>>(uploadResult["conflicts"].ToString());
                    }
                }

                // Step 1b: Upload any pending biometric edits (independent of pending observations)
                await UploadPendingBiometrics(colonyState, token, result, ColonyIdOf(appSettings));

                // Step 1c: watched flags are kept locally and pushed here (offline-safe queue)
                var localBoxNotes = LoadBoxNotesFromDisk(context);
                await UploadPendingWatchedFlags(context, appSettings, localBoxNotes);

                // Step 1d: the day's note, if a change to it never reached the server (set while
                // offline, or refused). Riding along on an observation upload isn't enough — that
                // only fills a day with no note, so a corrected label would never land.
                await FlushPendingDayNote(context, colonyState, appSettings);

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
                    if (string.IsNullOrWhiteSpace(json) || !json.TrimStart().StartsWith("{"))
                        throw new Exception(ServerMessage(json, (int)resp.StatusCode));
                    var serverState = JsonConvert.DeserializeObject<SyncResponse>(json);

                    colonyState.PreviousBoxes.Clear();
                    if (serverState?.boxes != null)
                    {
                        foreach (var kvp in serverState.boxes)
                        {
                            var b = kvp.Value;
                            var obs = BoxObservation.FromServerData(b.observation_id, b.location_id, b.observation_time_utc,
                                b.adults, b.eggs, b.chicks, b.breeding_status, b.gate_status, b.notes ?? "", b.monitor_filename,
                                b.observer_name, b.failed_eggs, b.dead_chicks);
                            obs.BoxName = kvp.Key;
                            if (b.scans != null) foreach (var scan in b.scans)
                                obs.ScannedIds.Add(new ScanRecord { BirdId = scan.pit_id ?? "", Timestamp = DateTime.TryParse(scan.scan_time_utc, out var st) ? st : DateTime.UtcNow });
                            for (int ns = 0; ns < b.no_scan; ns++)
                                obs.ScannedIds.Add(new ScanRecord { BirdId = $"NOSCAN_{ns + 1}", Timestamp = obs.WhenDataCollectedUtc });

                            var obsNzDate = MainActivity.ToNzTime(obs.WhenDataCollectedUtc).Date;
                            if (obsNzDate == nzToday)
                            {
                                if (!HasUnsentLocalEdit(colonyState, kvp.Key, nzToday))
                                { obs.IsPendingUpload = false; colonyState.TodayBoxes[kvp.Key] = obs; }
                            }
                            else colonyState.PreviousBoxes[kvp.Key] = obs;
                        }
                        result.BoxCount = serverState.boxes.Count;

                        var serverTodayBoxNames = new HashSet<string>(serverState.boxes.Where(kvp => { var d = DateTime.TryParse(kvp.Value.observation_time_utc, out var dt) ? dt : DateTime.MinValue; return MainActivity.ToNzTime(d).Date == nzToday; }).Select(kvp => kvp.Key));
                        foreach (var key in colonyState.TodayBoxes.Keys
                                     .Where(k => !serverTodayBoxNames.Contains(k) && !HasUnsentLocalEdit(colonyState, k, nzToday)).ToList())
                            colonyState.TodayBoxes.Remove(key);
                    }
                    if (serverState?.previous != null)
                        foreach (var kvp in serverState.previous)
                        {
                            var b = kvp.Value;
                            var obs = BoxObservation.FromServerData(b.observation_id, b.location_id, b.observation_time_utc, b.adults, b.eggs, b.chicks, b.breeding_status, b.gate_status, b.notes ?? "", b.monitor_filename, b.observer_name, b.failed_eggs, b.dead_chicks);
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
                        foreach (var loc in serverState.locations)
                        {
                            var bn = new BoxNoteData { LocationId = loc.location_id, BoxName = loc.location_name ?? "", PersistentNotes = loc.persistent_notes ?? "", Watched = loc.watched == 1 };
                            // A local edit that hasn't reached the server yet survives the refresh
                            // instead of being clobbered by the server value — for the watched flag
                            // and for the note itself, which was previously overwritten in silence.
                            if (localBoxNotes.TryGetValue(bn.BoxName, out var prior))
                            {
                                if (prior.WatchedPendingUpload)
                                {
                                    bn.Watched = prior.Watched;
                                    bn.WatchedPendingUpload = true;
                                }
                                if (prior.NotesPendingUpload)
                                {
                                    bn.PersistentNotes = prior.PersistentNotes;
                                    bn.NotesPendingUpload = true;
                                }
                            }
                            boxNotes[bn.BoxName] = bn;
                        }
                        File.WriteAllText(Path.Combine(context.FilesDir?.AbsolutePath, BOX_NOTES_FILENAME), JsonConvert.SerializeObject(boxNotes, Formatting.Indented));
                    }
                    // Keep the signing acronym current: an admin assigning one should reach the
                    // phone on the next sync, not the next login.
                    if (serverState?.observer != null &&
                        (appSettings.ObserverChipAcronym != (serverState.observer.chip_acronym ?? "")
                         || appSettings.ObserverFalconId != (serverState.observer.falcon_id ?? "")))
                    {
                        appSettings.ObserverChipAcronym = serverState.observer.chip_acronym ?? "";
                        appSettings.ObserverFalconId = serverState.observer.falcon_id ?? "";
                        saveApplicationSettings(appSettings);
                    }
                    // Who can be named as today's observer/scribe. Cached so the pickers still
                    // work in the field with no signal — a colony's people rarely change mid-round.
                    if (serverState?.users != null)
                        File.WriteAllText(Path.Combine(context.FilesDir?.AbsolutePath, USERS_FILENAME),
                            JsonConvert.SerializeObject(serverState.users, Formatting.Indented));
                    // Surface how many people the server returned so an empty picker can be diagnosed
                    // in the field: -1 = the response had no users field at all, 0 = empty list.
                    int peopleCount = serverState?.users?.Count ?? -1;
                    onLineProgress?.Invoke(0, $"{result.BoxCount} boxes, {peopleCount} people ✓");
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
                            LastKnownLifeStage = lifeStage, Sex = record.sex ?? "",
                            ChipDate = chipDate,
                            ChipAs = record.chipped_as_adult == 1 ? "Adult" : "", ChickSizeCode = record.chick_size_code ?? "",
                            SexGuessM = record.sex_guess_m ?? 0, SexGuessF = record.sex_guess_f ?? 0,
                            HasAlert = record.alert == 1
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
                        $"{WILDWATCH_API_URL}?action=list&table=penguin_biometric_data&observation_date={nzTodayStr}&colony_id={ColonyIdOf(appSettings)}");
                    req.Headers.Add("Authorization", $"Bearer {token}");
                    var resp = await _httpClient.SendAsync(req);
                    if (resp.StatusCode == System.Net.HttpStatusCode.Unauthorized) { authFailed = true; return 0; }
                    resp.EnsureSuccessStatusCode();
                    var bioJson = await resp.Content.ReadAsStringAsync();
                    if (string.IsNullOrEmpty(bioJson) || !bioJson.TrimStart().StartsWith("["))
                        throw new Exception("Biometrics API: expected JSON array");
                    var rows = JsonConvert.DeserializeObject<List<Dictionary<string, object>>>(bioJson) ?? new();
                    int merged = 0;
                    var onServer = new HashSet<string>();
                    foreach (var row in rows)
                    {
                        var pengNum = row.TryGetValue("peng_num", out var pn) ? pn?.ToString() : null;
                        if (string.IsNullOrEmpty(pengNum)) continue;
                        var key = ColonyState.BiometricKey(pengNum, nzTodayStr);
                        // A row flagged deleted is not a record. The server filters these out now;
                        // this is the second lock on the door, since the cost of missing one is a
                        // deleted record reappearing on a phone as though it were still true.
                        if (row.TryGetValue("is_deleted", out var del) && del != null
                            && (del.ToString() == "1" || string.Equals(del.ToString(), "true", StringComparison.OrdinalIgnoreCase)))
                            continue;
                        onServer.Add(key);
                        // Never clobber a local unsynced edit
                        if (colonyState.TodayBiometrics.TryGetValue(key, out var local) && local.IsPendingUpload)
                            continue;
                        colonyState.TodayBiometrics[key] = BiometricRecordFromRow(row, nzTodayStr);
                        merged++;
                    }
                    // Today's set is the server's to define: a cached record for today that the
                    // server no longer has was deleted there, so drop it. Anything queued for
                    // upload stays — it isn't missing from the server, it just hasn't arrived —
                    // and so does an earlier day's record, which this fetch never asked about.
                    foreach (var gone in colonyState.TodayBiometrics
                                 .Where(kv => kv.Value.ObservationDate == nzTodayStr
                                           && !onServer.Contains(kv.Key) && !kv.Value.IsPendingUpload)
                                 .Select(kv => kv.Key).ToList())
                        colonyState.TodayBiometrics.Remove(gone);
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
        internal async Task<int> UploadConfirmedEdits(ColonyState colonyState, AppSettings appSettings,
            List<(string boxName, string? nzDate)> confirmedBoxes)
        {
            var token = appSettings.AuthToken;
            if (string.IsNullOrEmpty(token)) return 0;

            var uploads = new List<object>();
            foreach (var (boxName, nzDate) in confirmedBoxes)
            {
                // The day that was confirmed, not just the box: a replace aimed at one round must
                // not send a different day's round in its place.
                var pending = MatchPending(colonyState, boxName, nzDate);
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
                    notes = pending.Notes, failed_eggs = pending.FailedEggs, dead_chicks = pending.DeadChicks, scans = scans,
                });
            }

            if (uploads.Count == 0) return 0;

            var body = JsonConvert.SerializeObject(new { daily_label = colonyState.DailyLabel,
                daily_observer_id = colonyState.DailyObserverId, daily_scribe_id = colonyState.DailyScribeId,
                observations = uploads });
            var request = new HttpRequestMessage(HttpMethod.Post, $"{WILDWATCH_SYNC_URL}?action=confirm");
            request.Headers.Add("Authorization", $"Bearer {token}");
            request.Content = new StringContent(body, Encoding.UTF8, "application/json");

            var response = await _httpClient.SendAsync(request);
            var json = await response.Content.ReadAsStringAsync();
            // Nothing usable came back (gateway page, empty body): report none uploaded rather than
            // throwing — this runs inside a dialog flow whose continuation must still fire.
            if (string.IsNullOrWhiteSpace(json) || !json.TrimStart().StartsWith("{")) return 0;
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
                        var match = MatchPending(colonyState, boxName, CreatedNzDate(c));
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

        /// <summary>One observation in the shape sync.php's upload action accepts. Shared with the
        /// manual JSON export so a hand-delivered file is byte-for-byte what a sync would have
        /// sent — an export that drifted from the wire format would be useless at the far end.</summary>
        internal static Dictionary<string, object?> BuildObservationPayload(BoxObservation obs)
        {
            var scans = obs.ScannedIds.Select(scan => (object)new {
                pit_id = scan.BirdId,
                scan_time_utc = scan.Timestamp.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                latitude = scan.Latitude, longitude = scan.Longitude, accuracy = scan.Accuracy,
            }).ToList();
            var payload = new Dictionary<string, object?>
            {
                ["box_name"] = obs.BoxName,
                ["observation_time_utc"] = ObsTimeUtc(obs),
                ["adults"] = obs.Adults, ["eggs"] = obs.Eggs, ["chicks"] = obs.Chicks,
                ["breeding_status"] = obs.BreedingStatus, ["gate_status"] = obs.GateStatus,
                ["notes"] = obs.Notes, ["failed_eggs"] = obs.FailedEggs, ["dead_chicks"] = obs.DeadChicks,
                ["scans"] = scans,
            };
            if (obs.ConfirmedAgainstObsId.HasValue)
                payload["expected_observation_id"] = obs.ConfirmedAgainstObsId.Value;
            return payload;
        }

        /// <summary>The upload envelope: the day's label and people, wrapped around the observations.</summary>
        internal static object BuildUploadBody(ColonyState colonyState, List<object> observations) => new {
            daily_label = colonyState.DailyLabel,
            daily_observer_id = colonyState.DailyObserverId,
            daily_scribe_id = colonyState.DailyScribeId,
            observations,
        };

        /// <summary>
        /// Upload-only: send pending observations to server, check for conflicts. No download.
        /// </summary>
        internal async Task<SyncResult> UploadPendingOnly(ColonyState colonyState, AppSettings appSettings)
        {
            var result = new SyncResult();
            var token = appSettings.AuthToken;
            if (string.IsNullOrEmpty(token)) { result.Error = "Not logged in"; result.AuthFailed = true; return result; }
            if (colonyState.PendingObservations.Count(p => p.IsPendingUpload) == 0) return result;

            var pendingBoxes = colonyState.PendingObservations
                .Where(p => p.IsPendingUpload && !string.IsNullOrEmpty(p.BoxName))
                .Select(p => (object)BuildObservationPayload(p))
                .ToList();

            var uploadBody = JsonConvert.SerializeObject(BuildUploadBody(colonyState, pendingBoxes));
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
                        var match = MatchPending(colonyState, boxName, CreatedNzDate(c));
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
                result.UploadErrorDetails.AddRange(DescribeUploadErrors(uploadResult["errors"]));
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
                // Wildwatch's column is is_moulting — not the condition_* family the other flags use.
                ConditionMoulting = B("is_moulting"),
                ConditionTicks = B("condition_ticks"),
                ConditionDead = B("condition_dead"),
                Notes = S("notes"),
                BiometricId = I("biometric_id"),
                IsPendingUpload = false,
            };
        }

        /// <summary>Read sync.php's per-observation "errors" into lines a person can act on —
        /// "Box 12: Unknown pit_id: …" — rather than the count that hid them.</summary>
        private static List<string> DescribeUploadErrors(object? errorsNode)
        {
            var lines = new List<string>();
            try
            {
                var rows = JsonConvert.DeserializeObject<List<Dictionary<string, object>>>(errorsNode?.ToString() ?? "[]");
                foreach (var r in rows ?? new())
                {
                    var box = r.TryGetValue("box", out var b) ? b?.ToString() : null;
                    var why = r.TryGetValue("error", out var e) ? e?.ToString() : null;
                    lines.Add(string.IsNullOrEmpty(box) ? (why ?? "rejected") : $"Box {box}: {why ?? "rejected"}");
                }
            }
            catch { }
            return lines;
        }

        /// <summary>The server's own words for a failed request: its "error" field where the body is
        /// JSON, otherwise the status and a short snippet of whatever came back instead.</summary>
        private static string ServerMessage(string? body, int statusCode)
        {
            try
            {
                if (!string.IsNullOrWhiteSpace(body) && body.TrimStart().StartsWith("{"))
                {
                    var obj = JsonConvert.DeserializeObject<Dictionary<string, object>>(body);
                    if (obj != null && obj.TryGetValue("error", out var e) && e != null)
                        return e.ToString() ?? $"HTTP {statusCode}";
                }
            }
            catch { }
            var snippet = (body ?? "").Trim();
            if (snippet.Length > 120) snippet = snippet.Substring(0, 120) + "…";
            return string.IsNullOrEmpty(snippet) ? $"HTTP {statusCode}" : $"HTTP {statusCode}: {snippet}";
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
        private async Task UploadPendingBiometrics(ColonyState colonyState, string token, SyncResult result, int colonyId)
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
                    // The server's column is is_moulting; a payload naming it condition_moulting was
                    // rejected outright, so every moulting bird stayed queued. Always sent (unlike
                    // the flags below) so unticking it clears the flag on the next upload.
                    fields["is_moulting"] = bio.ConditionMoulting;
                    if (bio.ConditionTicks) fields["condition_ticks"] = true;
                    if (!string.IsNullOrEmpty(bio.Notes)) fields["notes"] = bio.Notes;
                    // Dead is not a biometric column — the flag was retired in favour of a death
                    // date on the bird itself, and is written separately below.

                    var url = bio.BiometricId.HasValue
                        ? $"{WILDWATCH_API_URL}?action=update&table=penguin_biometric_data&id={bio.BiometricId.Value}&colony_id={colonyId}"
                        : $"{WILDWATCH_API_URL}?action=create&table=penguin_biometric_data&colony_id={colonyId}";
                    var req = new HttpRequestMessage(HttpMethod.Post, url);
                    req.Headers.Add("Authorization", $"Bearer {token}");
                    req.Content = new StringContent(JsonConvert.SerializeObject(fields), Encoding.UTF8, "application/json");
                    var resp = await _httpClient.SendAsync(req);
                    if (!resp.IsSuccessStatusCode)
                    {
                        // Keep what the server said: a rejected field silently re-queues the bird
                        // every sync, and without the reason there's nothing to go on in the field.
                        result.BiometricUploadErrors++;
                        result.BiometricErrors.Add($"#{bio.PengNum}: {ServerMessage(await resp.Content.ReadAsStringAsync(), (int)resp.StatusCode)}");
                        continue;
                    }

                    // Capture the new id on create so a later edit updates instead of duplicating
                    if (!bio.BiometricId.HasValue)
                        bio.BiometricId = ExtractBiometricId(await resp.Content.ReadAsStringAsync());
                    bio.IsPendingUpload = false;
                    result.BiometricsUploaded++;

                    if (bio.ConditionDead)
                    {
                        var deathError = await MarkPenguinDead(bio.PengNum, bio.ObservationDate, token, colonyId);
                        if (deathError != null)
                        {
                            // The biometric itself is saved; only the death date didn't land. Count
                            // it so the sync reads as partial rather than reporting a clean run.
                            result.BiometricUploadErrors++;
                            result.BiometricErrors.Add($"#{bio.PengNum} death date: {deathError}");
                        }
                    }
                }
                catch (Exception ex)
                {
                    result.BiometricUploadErrors++;
                    result.BiometricErrors.Add($"#{bio.PengNum}: {ex.Message}");
                }
            }
        }

        /// <summary>Record a bird as dead on the date it was found. Death lives on the penguin, not on
        /// the visit: penguins.death_date, stamped 02:00 UTC — 2pm NZ, wildwatch's convention, so a
        /// same-day morning scan still reads as before the death. A bird that already has a death
        /// date keeps it; the first record of a death is the one that counts, and a later visit to
        /// the same carcass must not move the date. Returns null on success, else why it failed.</summary>
        private async Task<string?> MarkPenguinDead(string pengNum, string observationDate, string token, int colonyId)
        {
            if (string.IsNullOrEmpty(pengNum)) return "no penguin number";

            var getReq = new HttpRequestMessage(HttpMethod.Get,
                $"{WILDWATCH_API_URL}?action=get&table=penguins&id={Uri.EscapeDataString(pengNum)}&colony_id={colonyId}");
            getReq.Headers.Add("Authorization", $"Bearer {token}");
            var getResp = await _httpClient.SendAsync(getReq);
            var getBody = await getResp.Content.ReadAsStringAsync();
            if (!getResp.IsSuccessStatusCode) return ServerMessage(getBody, (int)getResp.StatusCode);
            try
            {
                var row = JsonConvert.DeserializeObject<Dictionary<string, object>>(getBody);
                if (row != null && row.TryGetValue("death_date", out var dd)
                    && dd != null && !string.IsNullOrWhiteSpace(dd.ToString()))
                    return null;   // already recorded dead — leave the original date alone
            }
            catch { }

            var fields = new Dictionary<string, object>
            {
                ["death_date"] = $"{observationDate} 02:00:00",
                ["_reason"] = "Recorded dead in nestcheck",
            };
            var req = new HttpRequestMessage(HttpMethod.Post,
                $"{WILDWATCH_API_URL}?action=update&table=penguins&id={Uri.EscapeDataString(pengNum)}&colony_id={colonyId}");
            req.Headers.Add("Authorization", $"Bearer {token}");
            req.Content = new StringContent(JsonConvert.SerializeObject(fields), Encoding.UTF8, "application/json");
            var resp = await _httpClient.SendAsync(req);
            return resp.IsSuccessStatusCode ? null
                : ServerMessage(await resp.Content.ReadAsStringAsync(), (int)resp.StatusCode);
        }

        /// <summary>Upload only pending biometrics (used for prompt background flush after a save).</summary>
        internal async Task<SyncResult> UploadPendingBiometricsOnly(ColonyState colonyState, AppSettings appSettings)
        {
            var result = new SyncResult();
            var token = appSettings.AuthToken;
            if (string.IsNullOrEmpty(token)) { result.Error = "Not logged in"; result.AuthFailed = true; return result; }
            await UploadPendingBiometrics(colonyState, token, result, ColonyIdOf(appSettings));
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
            public int? failed_eggs { get; set; }
            public int? dead_chicks { get; set; }
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
            public List<SyncUser>? users { get; set; }
            public SyncObserver? observer { get; set; }
        }
        /// <summary>The logged-in user as the server sees them, refreshed each sync.</summary>
        private class SyncObserver
        {
            public int observer_id { get; set; }
            public string? name { get; set; }
            public string? chip_acronym { get; set; }
            public string? falcon_id { get; set; }
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
            public int? failed_eggs { get; set; }
            public int? dead_chicks { get; set; }
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
        /// <summary>A person who can be named as the day's observer or scribe. Active users only.
        /// falcon_id is the chipper/permit id; only users who have one may be picked as the chipper.
        /// (Requires sync.php to include falcon_id in the users payload — else it's null for all.)</summary>
        public class SyncUser
        {
            public int id { get; set; }
            public string? name { get; set; }
            public string? f_name { get; set; }
            public string? surname { get; set; }
            /// <summary>Initials this person signs a chipping with (users.chip_acronym).</summary>
            public string? chip_acronym { get; set; }
            public string? falcon_id { get; set; }
        }
        private class SyncLocation
        {
            public int location_id { get; set; }
            public string? location_name { get; set; }
            public string? persistent_notes { get; set; }
            public int watched { get; set; }
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
                // Keep the copy we're about to replace. This file is the only home of a day's
                // unsent work, and starting from an empty state loses a round nobody can redo.
                try { if (File.Exists(path)) File.Copy(path, path + ".bak", true); } catch { }
                File.Move(tempPath, path, true);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"SaveColonyState failed: {ex.Message}");
            }
        }

        public static ColonyState LoadColonyState(Android.Content.Context context)
        {
            var dir = context.FilesDir?.AbsolutePath;
            var path = Path.Combine(dir ?? "", COLONY_STATE_FILENAME);
            ColonyState? Read(string p)
            {
                try
                {
                    if (!File.Exists(p)) return null;
                    return JsonConvert.DeserializeObject<ColonyState>(File.ReadAllText(p));
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"LoadColonyState {p}: {ex.Message}");
                    return null;
                }
            }

            var state = Read(path);
            if (state != null) { state.MigrateBiometricKeys(); return state; }

            // The live file is unreadable. Fall back to the previous copy rather than opening on an
            // empty colony, and keep the bad one — an unsent observation is recoverable from a file
            // on disk, never from a state we deleted.
            var fallback = Read(path + ".bak");
            if (fallback != null)
            {
                try { if (File.Exists(path)) File.Copy(path, path + ".corrupt", true); } catch { }
                System.Diagnostics.Debug.WriteLine("LoadColonyState: recovered from .bak");
                fallback.MigrateBiometricKeys();
                return fallback;
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

        // ===== Offline chip queue =====
        internal const string QUEUED_CHIPS_FILENAME = "queuedChips.json";

        internal List<PendingChipState> LoadQueuedChips(Android.Content.Context context)
        {
            try
            {
                var p = Path.Combine(context.FilesDir?.AbsolutePath, QUEUED_CHIPS_FILENAME);
                if (File.Exists(p))
                    return JsonConvert.DeserializeObject<List<PendingChipState>>(File.ReadAllText(p)) ?? new List<PendingChipState>();
            }
            catch (Exception ex) { System.Diagnostics.Debug.WriteLine($"LoadQueuedChips: {ex.Message}"); }
            return new List<PendingChipState>();
        }

        internal void SaveQueuedChips(Android.Content.Context context, List<PendingChipState> queue)
        {
            try { File.WriteAllText(Path.Combine(context.FilesDir?.AbsolutePath, QUEUED_CHIPS_FILENAME), JsonConvert.SerializeObject(queue)); }
            catch (Exception ex) { System.Diagnostics.Debug.WriteLine($"SaveQueuedChips: {ex.Message}"); }
        }

        // Only one flush at a time. A manual sync and a background sync can overlap, and two
        // flushes reading the same queue file would POST the same birds twice.
        private static readonly SemaphoreSlim _chipFlushLock = new SemaphoreSlim(1, 1);

        /// <summary>
        /// Upload birds chipped while offline. Each queued entry goes up as ONE atomic
        /// create_chipped_bird call (penguin + chip + biometrics in a single server transaction),
        /// so a connection drop mid-flush can never leave half a bird behind. The server keys on
        /// pit_id, so replaying an entry whose first attempt actually landed just returns the
        /// peng_num it landed as — retrying is always safe.
        ///
        /// Connectivity failures keep the entry queued for the next sync. Only a definitive
        /// server rejection drops it, and never silently: the reason comes back as a warning.
        /// </summary>
        internal async Task<List<string>> FlushQueuedChips(Android.Content.Context context, AppSettings appSettings)
        {
            var warnings = new List<string>();
            var token = appSettings.AuthToken;
            if (string.IsNullOrEmpty(token)) return warnings;
            if (LoadQueuedChips(context).Count == 0) return warnings;
            if (!await _chipFlushLock.WaitAsync(0)) return warnings; // another sync is already flushing

            try
            {
                var queue = LoadQueuedChips(context); // re-read under the lock
                var colonyId = appSettings.SelectedColonyId > 0 ? appSettings.SelectedColonyId : 1;

                foreach (var q in queue.ToList())
                {
                    var chipDate = MainActivity.ToNzTime(q.CreatedUtc).ToString("yyyy-MM-dd");
                    var fields = new Dictionary<string, object>
                    {
                        ["pit_id"] = q.FullPitId,
                        ["chipped_as_adult"] = q.IsChick ? 0 : 1,
                        ["chip_date"] = chipDate,
                        ["observation_date"] = chipDate,
                        ["chip_box"] = q.ChipBox,
                    };
                    if (q.ChipperId > 0) fields["chipper_id"] = q.ChipperId;
                    else if (!string.IsNullOrEmpty(q.ChipBy)) fields["chip_by"] = q.ChipBy;   // legacy queued item (pre-dropdown)
                    if (q.AssistantId > 0) fields["assistant_id"] = q.AssistantId;
                    if (!string.IsNullOrEmpty(q.ChickSizeCode)) fields["chick_size_code"] = q.ChickSizeCode;
                    if (!string.IsNullOrEmpty(q.RequestedPengNum)) fields["requested_peng_num"] = q.RequestedPengNum;
                    if (!string.IsNullOrEmpty(q.Weight)) fields["weight"] = q.Weight;
                    if (!string.IsNullOrEmpty(q.Flipper)) fields["flipper_length"] = q.Flipper;
                    if (!string.IsNullOrEmpty(q.SexCode)) fields["observed_sex"] = q.SexCode;
                    if (!string.IsNullOrEmpty(q.Notes)) fields["notes"] = q.Notes;

                    System.Net.HttpStatusCode status;
                    Dictionary<string, object>? body;
                    try
                    {
                        var req = new HttpRequestMessage(HttpMethod.Post,
                            $"{WILDWATCH_BASE_URL}/crud.php?action=create_chipped_bird&colony_id={colonyId}");
                        req.Headers.Add("Authorization", $"Bearer {token}");
                        req.Content = new StringContent(JsonConvert.SerializeObject(fields), Encoding.UTF8, "application/json");
                        var resp = await _httpClient.SendAsync(req);
                        status = resp.StatusCode;
                        var raw = await resp.Content.ReadAsStringAsync();
                        body = JsonConvert.DeserializeObject<Dictionary<string, object>>(raw);
                    }
                    catch (Exception ex)
                    {
                        // Connectivity, or a response we can't parse (proxy/HTML error page). The
                        // transaction rolled back either way — stop; everything left stays queued
                        // and replays safely on the next sync.
                        System.Diagnostics.Debug.WriteLine($"FlushQueuedChips: {ex.Message}");
                        break;
                    }

                    var pengNum = body != null && body.ContainsKey("peng_num") ? body["peng_num"]?.ToString() : null;
                    if (string.IsNullOrEmpty(pengNum))
                    {
                        // Not a per-bird problem: expired session, lost editor rights, server
                        // fault. Retrying WILL help, so keep the queue intact — dropping birds
                        // because a token went stale would be real field data lost.
                        if (status != System.Net.HttpStatusCode.BadRequest)
                        {
                            System.Diagnostics.Debug.WriteLine($"FlushQueuedChips: {(int)status}, keeping queue");
                            break;
                        }

                        // 400: the server rolled back and definitively refused this bird.
                        // Retrying can't help, so drop it — but never silently: say enough
                        // that the bird can be re-entered by hand.
                        var why = body?.GetValueOrDefault("error")?.ToString() ?? "unknown error";
                        var who = string.IsNullOrEmpty(q.RequestedPengNum) ? q.FullPitId : q.RequestedPengNum;
                        warnings.Add($"Queued bird {who} (PIT {q.FullPitId}, box {q.BoxName}) rejected: {why}");
                    }
                    else if (pengNum != q.RequestedPengNum && !string.IsNullOrEmpty(q.RequestedPengNum))
                    {
                        // The predicted number was taken, so the server parked it out-of-band.
                        // Surface it — the field notes say one number and the database another.
                        warnings.Add($"Bird written down as {q.RequestedPengNum} synced as {pengNum} (number was taken — rename on wildwatch).");
                    }

                    queue.Remove(q);
                    SaveQueuedChips(context, queue);
                }
            }
            finally { _chipFlushLock.Release(); }

            return warnings;
        }

        /// <summary>
        /// Push local box edits — the watched flag and the persistent note — to the server. Both are
        /// kept locally and synced; a failed push just stays pending for the next sync (offline-safe).
        /// </summary>
        internal async Task UploadPendingWatchedFlags(Android.Content.Context context, AppSettings appSettings, Dictionary<string, BoxNoteData>? boxNotes = null)
        {
            var token = appSettings.AuthToken;
            if (string.IsNullOrEmpty(token)) return;
            var notes = boxNotes ?? LoadBoxNotesFromDisk(context);
            var colonyId = appSettings.SelectedColonyId > 0 ? appSettings.SelectedColonyId : 1;
            bool changed = false;
            foreach (var n in notes.Values.Where(n => (n.WatchedPendingUpload || n.NotesPendingUpload) && n.LocationId > 0).ToList())
            {
                try
                {
                    // One update carries whichever of the two is outstanding; a field that isn't
                    // pending is left out so it can't overwrite a change made on the website.
                    var fields = new Dictionary<string, object>();
                    if (n.WatchedPendingUpload) fields["watched"] = n.Watched ? 1 : 0;
                    if (n.NotesPendingUpload) fields["persistent_notes"] = n.PersistentNotes ?? "";
                    var req = new HttpRequestMessage(HttpMethod.Post,
                        $"{WILDWATCH_BASE_URL}/crud.php?action=update&table=observation_locations&id={n.LocationId}&colony_id={colonyId}");
                    req.Headers.Add("Authorization", $"Bearer {token}");
                    req.Content = new StringContent(JsonConvert.SerializeObject(fields), Encoding.UTF8, "application/json");
                    var resp = await _httpClient.SendAsync(req);
                    if (resp.IsSuccessStatusCode)
                    {
                        n.WatchedPendingUpload = false;
                        n.NotesPendingUpload = false;
                        changed = true;
                    }
                }
                catch { /* stays pending */ }
            }
            if (changed) SaveBoxNotesToDisk(context, notes);
        }

        public void SaveBoxNotesToDisk(Android.Content.Context context, Dictionary<string, BoxNoteData> boxNotes)
        {
            try
            {
                File.WriteAllText(Path.Combine(context.FilesDir?.AbsolutePath, BOX_NOTES_FILENAME),
                    JsonConvert.SerializeObject(boxNotes, Formatting.Indented));
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to save box notes: {ex.Message}");
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

        /// <summary>Cached list of people who can be the day's observer or scribe. Empty until
        /// the first sync; the pickers then fall back to "not recorded".</summary>
        internal static List<SyncUser> LoadUsers(Context context)
        {
            try
            {
                var path = Path.Combine(context.FilesDir?.AbsolutePath, USERS_FILENAME);
                if (!File.Exists(path)) return new List<SyncUser>();
                return JsonConvert.DeserializeObject<List<SyncUser>>(File.ReadAllText(path)) ?? new List<SyncUser>();
            }
            catch { return new List<SyncUser>(); }
        }

        // Push the day's note (the phone's "Daily label") straight to the day_notes table for a
        // colony + NZ date. Unlike the daily_label carried on an observation upload — which only
        // fills a day that has no note yet — this upserts, so re-setting the label actually changes
        // it. Needs editor/admin role server-side; a viewer gets 403 and we just keep it local.
        internal async Task<bool> SaveDayNoteAsync(int colonyId, string nzDate, string note, string token,
                                                   int observerId = 0, int scribeId = 0)
        {
            try
            {
                var request = new HttpRequestMessage(HttpMethod.Post, $"{WILDWATCH_API_URL}?action=save_day_note&colony_id={colonyId}");
                request.Headers.Add("Authorization", $"Bearer {token}");
                var body = JsonConvert.SerializeObject(new { colony_id = colonyId, date = nzDate, note,
                    observer_id = observerId == 0 ? (int?)null : observerId,
                    scribe_id = scribeId == 0 ? (int?)null : scribeId });
                request.Content = new StringContent(body, Encoding.UTF8, "application/json");
                var response = await _httpClient.SendAsync(request);
                return response.IsSuccessStatusCode;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to save day note: {ex.Message}");
                return false;
            }
        }

        /// <summary>Retry a day note whose server save didn't land (set while offline, or refused).
        /// The label is otherwise local-only: it rides along on an observation upload, but that
        /// only fills a day with no note, so a correction to an existing one would never arrive.</summary>
        private async Task FlushPendingDayNote(Android.Content.Context context, ColonyState colonyState, AppSettings appSettings)
        {
            var token = appSettings.AuthToken;
            if (string.IsNullOrEmpty(token)) return;
            int colonyId = ColonyIdOf(appSettings);
            bool changed = false;

            // Earlier days first — each goes to the date it was written on, not today.
            foreach (var note in colonyState.PendingDayNotes.ToList())
            {
                if (string.IsNullOrEmpty(note.NzDate)) { colonyState.PendingDayNotes.Remove(note); changed = true; continue; }
                if (await SaveDayNoteAsync(colonyId, note.NzDate, note.Note, token, note.ObserverId, note.ScribeId))
                {
                    colonyState.PendingDayNotes.Remove(note);
                    changed = true;
                }
            }

            if (colonyState.DailyLabelPendingUpload)
            {
                if (string.IsNullOrEmpty(colonyState.DailyLabelDate))
                {
                    colonyState.DailyLabelPendingUpload = false;
                    changed = true;
                }
                else if (await SaveDayNoteAsync(colonyId, colonyState.DailyLabelDate, colonyState.DailyLabel,
                             token, colonyState.DailyObserverId, colonyState.DailyScribeId))
                {
                    colonyState.DailyLabelPendingUpload = false;
                    changed = true;
                }
            }

            if (changed) SaveColonyState(context, colonyState);
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
