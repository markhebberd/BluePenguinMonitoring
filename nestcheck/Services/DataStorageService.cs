using Android.App.SdkSandbox;
using Android.Content;
using Android.OS;
using PenguinMonitor.Models;
using Newtonsoft.Json;
using SmtpAuthenticator;
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PenguinMonitor.Services
{
    public class DataStorageService
    {
        private const string APP_SETTINGS_FILENAME = "app_settings.json";
        private const string ALL_MONITOR_DATA_FILENAME = "penguin_data_autosave.json";
        internal const string REMOTE_BIRD_DATA_FILENAME = "remotePenguinData.json";
        internal const string REMOTE_BOX_DATA_FILENAME = "remoteBoxData.json";
        internal const string BOX_NOTES_FILENAME = "boxNotes.json";
        internal const string BREEDING_DATES_FILENAME = "predictedDates.json";

        // HTTP client for API downloads
        private static readonly HttpClient _httpClient = new HttpClient();
        internal const string WILDWATCH_PENGUINS_URL = "https://wildwatch.co.nz/penguin-api/penguins.php";
        internal const string WILDWATCH_API_URL = "https://wildwatch.co.nz/penguin-api/crud.php";
        internal const string WILDWATCH_API_KEY = "b30181424b2d70102fb90a32af6c013e63e7b0d49ae466ebf90aa0f969ddbe02";

        public void uploadCurrentMonitorDetailsToServer(string currentDataJson)
        {
            try
            {
                string response = "No Response";
                BackgroundWorker bw = new BackgroundWorker();
                bw.DoWork += (sender, e) =>
                {
                    response = Backend.RequestServerResponse("PenguinReport-Saved:" + currentDataJson.ToString());
                };
                bw.RunWorkerCompleted += (sender, e) =>
                {
                    //Toast.MakeText(this, "Response from Penguin server: " + response, ToastLength.Long)?.Show();
                };
                bw.RunWorkerAsync();
            }
            catch { }
        }
        public static Dictionary<int, MonitorDetails> requestPastMonitorDetailsFromServer(Dictionary<int, MonitorDetails> _allMonitorData)
        {
            try
            {
                MonitorDetails temp = _allMonitorData[0];
                _allMonitorData.Clear();
                _allMonitorData.Add(0, temp);

                string response = "No Response";
                response = Backend.RequestServerResponse("PenguinRequest-Saved:");

                if (string.IsNullOrEmpty(response) || response == "No Response" || response == "fail")
                    throw new Exception($"TCP server returned: {(string.IsNullOrEmpty(response) ? "(empty)" : response.Substring(0, Math.Min(response.Length, 100)))}");

                foreach (string json in response.Split("~~~~", StringSplitOptions.RemoveEmptyEntries))
                {
                    var trimmed = json.Trim();
                    if (string.IsNullOrEmpty(trimmed) || !trimmed.StartsWith("{"))
                        throw new Exception($"TCP monitor data: expected JSON object, got: {trimmed.Substring(0, Math.Min(trimmed.Length, 100))}");
                    MonitorDetails monitor = Newtonsoft.Json.JsonConvert.DeserializeObject<MonitorDetails>(trimmed);
                            
                    /// Don't import deleted monitors
                    if(monitor.IsDeleted)
                        continue;

                    /// Fix any old data with bad timestamps

                    //bool adjusted = false;
                    //DateTime lastSaved = monitor.LastSaved.ToUniversalTime();
                    //List<BoxData> bds = monitor.BoxData.Values.ToList();
                    //bds.Reverse();

                    //DateTime highest = DateTime.MinValue;
                    //DateTime lowest = DateTime.MaxValue;
                    //foreach (BoxData box in bds)
                    //{
                    //    DateTime boxHighest = DateTime.MinValue;

                    //    if (box.whenDataCollectedUtc.ToUniversalTime() > boxHighest)
                    //        boxHighest = box.whenDataCollectedUtc.ToUniversalTime();
                    //    if (box.whenDataCollectedUtc.ToUniversalTime() > highest)
                    //        highest = box.whenDataCollectedUtc.ToUniversalTime();
                    //    if (box.whenDataCollectedUtc.ToUniversalTime() < lowest)
                    //        lowest = box.whenDataCollectedUtc.ToUniversalTime();

                    //    for (int j = 0; j < box.ScannedIds.Count; j++)
                    //    {
                    //        if (box.whenDataCollectedUtc < box.ScannedIds[j].Timestamp.ToUniversalTime())
                    //        {

                    //            if (box.ScannedIds[j].Timestamp.ToUniversalTime() > boxHighest)
                    //                boxHighest = box.ScannedIds[j].Timestamp.ToUniversalTime();
                    //            if (box.ScannedIds[j].Timestamp.ToUniversalTime() > highest)
                    //                highest = box.ScannedIds[j].Timestamp.ToUniversalTime();
                    //            if (box.ScannedIds[j].Timestamp.ToUniversalTime() < lowest)
                    //                lowest = box.ScannedIds[j].Timestamp.ToUniversalTime();
                    //        }
                    //    }
                    //    if (box.whenDataCollectedUtc < boxHighest)
                    //    {
                    //        box.whenDataCollectedUtc = boxHighest;
                    //        adjusted = true;
                    //    }
                    //    else if (box.whenDataCollectedUtc < lowest)
                    //    {  box.whenDataCollectedUtc = lowest;
                    //        adjusted = true;
                    //    }
                    //}

                    //foreach (BoxData box in bds)
                    //{
                    //    if(box.whenDataCollectedUtc.Year < 2020)
                    //    {  
                    //        box.whenDataCollectedUtc = highest;
                    //        adjusted = true;
                    //    }
                    //}
                    //if (monitor.LastSaved.Year < 2020)
                    //{
                    //    monitor.LastSaved = highest.ToUniversalTime();
                    //    adjusted = true;
                    //}
                    //monitor.filename += " GenTime";
                    //if (adjusted)
                    //{
                    //    var currentDataJson = JsonConvert.SerializeObject(monitor, Formatting.Indented);
                    //    string response = Backend.RequestServerResponse("PenguinReport-Saved:" + currentDataJson.ToString());
                    //}
                    _allMonitorData.Add(_allMonitorData.Count, monitor);
                }

                // Sort by observation date descending, LastSaved as tiebreaker. Index 0 = current session.
                var current = _allMonitorData[0];
                var sorted = _allMonitorData.Values.Where((v, i) => i > 0)
                    .OrderByDescending(m => m.BoxData.Values.Any()
                        ? m.BoxData.Values.Max(b => b.whenDataCollectedUtc)
                        : m.LastSaved)
                    .ThenByDescending(m => m.LastSaved).ToList();
                _allMonitorData.Clear();
                _allMonitorData.Add(0, current);
                for (int i = 0; i < sorted.Count; i++)
                    _allMonitorData.Add(i + 1, sorted[i]);
            }
            catch { }
            return _allMonitorData;
        }
        public async static Task SaveAllMonitorDataToDisk(Android.Content.Context context, Dictionary<int, MonitorDetails> _allMonitorData, bool reportHome = true, bool downloadRemoteMonitorData = false)
        {
            try
            {
                if (downloadRemoteMonitorData)
                    _allMonitorData = requestPastMonitorDetailsFromServer(_allMonitorData);

                if (string.IsNullOrEmpty(context.FilesDir?.AbsolutePath))
                    return;
                var allMonitorDataJson = JsonConvert.SerializeObject(_allMonitorData, Formatting.Indented);
                var filePath = Path.Combine(context.FilesDir?.AbsolutePath, ALL_MONITOR_DATA_FILENAME);
                File.WriteAllText(filePath, allMonitorDataJson);
                if (reportHome && _allMonitorData[0].BoxData.Count > 0) {
                    try
                    {
                        var currentDataJson = JsonConvert.SerializeObject(_allMonitorData[0], Formatting.Indented);
                        string response = "No Response";
                        BackgroundWorker bw = new BackgroundWorker();
                        bw.DoWork += (sender, e) => 
                            response = Backend.RequestServerResponse("PenguinReport:" + currentDataJson.ToString()); 
                        bw.RunWorkerCompleted += (sender, e) =>
                        {
                            new Handler(Looper.MainLooper).Post(() =>
                            {
                                if (response == "fail")
                                {
                                    Toast.MakeText(context, "Unable to incremental on server.", ToastLength.Short)?.Show();
                                }
                                else
                                {
                                    Toast.MakeText(context, "Boxes " + response + " on server.", ToastLength.Short)?.Show();
                                }
                            });
                        };
                        bw.RunWorkerAsync();
                    }
                    catch { }
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Auto-save failed: {ex.Message}");
            }
        }
        public Dictionary<int, MonitorDetails>? LoadAllMonitorDataFromDisk(Android.Content.Context? context)
        {
            try
            {
                var filePath = Path.Combine(context.FilesDir?.AbsolutePath, ALL_MONITOR_DATA_FILENAME);
                if (!File.Exists(filePath))
                    return null;

                var json = File.ReadAllText(filePath);
                return Newtonsoft.Json.JsonConvert.DeserializeObject<Dictionary<int, MonitorDetails>>(json);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to load data: {ex.Message}");
                return null;
            }
        }
        /// <summary>
        /// Result of DownloadRemoteData including box tag sync info
        /// </summary>
        public class DownloadResult
        {
            public Dictionary<string, BoxTag>? BoxTags { get; set; }
            public BoxTagService.SyncResult? TagSyncResult { get; set; }
            public string? BoxTagError { get; set; }
            public int BirdCount { get; set; }
            public int MonitorCount { get; set; }
            public int BoxNoteCount { get; set; }
            public string? Error { get; set; }
        }

        internal async Task<DownloadResult> DownloadRemoteData(Android.Content.Context? context, Dictionary<int, MonitorDetails> allMonitorData, Dictionary<string, BoxTag>? boxTags = null, ICollection<string>? validBoxIds = null)
        {
            var downloadResult = new DownloadResult();
            try
            {
                var overallStopwatch = System.Diagnostics.Stopwatch.StartNew();

                // Fetch penguins from WildWatch API
                var birdsStopwatch = System.Diagnostics.Stopwatch.StartNew();
                Task<HttpResponseMessage> responseBirdsTask = _httpClient.GetAsync(WILDWATCH_PENGUINS_URL)
                    .ContinueWith(t => { birdsStopwatch.Stop(); return t.Result; });

                // Save monitor data
                var monitorStopwatch = System.Diagnostics.Stopwatch.StartNew();
                Task saveMonitorDataToDiskTask = Task.Run(async () => {
                    await SaveAllMonitorDataToDisk(context, allMonitorData, reportHome:false, downloadRemoteMonitorData: true);
                    monitorStopwatch.Stop();
                });

                // Box tag sync task
                var tagSyncStopwatch = System.Diagnostics.Stopwatch.StartNew();
                Task<BoxTagService.SyncResult?> tagSyncTask;
                if (boxTags != null && BoxTagService.IsApiConfigured && context?.FilesDir?.AbsolutePath != null)
                {
                    tagSyncTask = BoxTagService.SyncWithApiAsync(boxTags, context.FilesDir.AbsolutePath, validBoxIds)
                        .ContinueWith(t => { tagSyncStopwatch.Stop(); return (BoxTagService.SyncResult?)t.Result; });
                }
                else
                {
                    tagSyncStopwatch.Stop();
                    tagSyncTask = Task.FromResult<BoxTagService.SyncResult?>(null);
                }

                // Fetch box notes from WildWatch API
                var notesRequest = new HttpRequestMessage(HttpMethod.Get, $"{WILDWATCH_API_URL}?action=list&table=observation_locations");
                notesRequest.Headers.Add("X-API-Key", WILDWATCH_API_KEY);
                Task<HttpResponseMessage> responseLocationsTask = _httpClient.SendAsync(notesRequest);

                // Await all in parallel
                await Task.WhenAll(responseBirdsTask, saveMonitorDataToDiskTask, tagSyncTask, responseLocationsTask);
                overallStopwatch.Stop();

                // Log timing info
                System.Diagnostics.Debug.WriteLine($"responseBirdsTask: {birdsStopwatch.ElapsedMilliseconds}ms");
                System.Diagnostics.Debug.WriteLine($"saveMonitorDataToDiskTask: {monitorStopwatch.ElapsedMilliseconds}ms");
                System.Diagnostics.Debug.WriteLine($"tagSyncTask: {tagSyncStopwatch.ElapsedMilliseconds}ms");
                System.Diagnostics.Debug.WriteLine($"DownloadRemoteData total: {overallStopwatch.ElapsedMilliseconds}ms");

                // Retrieve box tag sync results
                var tagSyncResult = await tagSyncTask;
                downloadResult.TagSyncResult = tagSyncResult;
                if (tagSyncResult != null)
                {
                    downloadResult.BoxTags = tagSyncResult.Tags;
                    downloadResult.BoxTagError = tagSyncResult.Error;
                }

                // Parse penguins from JSON API
                HttpResponseMessage responseBirds = await responseBirdsTask;
                responseBirds.EnsureSuccessStatusCode();
                var jsonContent = await responseBirds.Content.ReadAsStringAsync();
                if (string.IsNullOrEmpty(jsonContent) || !jsonContent.TrimStart().StartsWith("["))
                    throw new Exception($"Penguins API: expected JSON array, got: {jsonContent?.Substring(0, Math.Min(jsonContent?.Length ?? 0, 100))}");
                var penguinRecords = JsonConvert.DeserializeObject<List<WildWatchPenguin>>(jsonContent);

                Dictionary<string, PenguinData> remotePenguinData = new Dictionary<string, PenguinData>();
                foreach (var record in penguinRecords)
                {
                    if (string.IsNullOrEmpty(record.pit_id) || record.pit_id.Length < 8)
                        continue;

                    var cleanId = new string(record.pit_id.Where(char.IsLetterOrDigit).ToArray());
                    var eightDigitId = cleanId.Length >= 8 ? cleanId.Substring(cleanId.Length - 8).ToUpper() : cleanId.ToUpper();

                    if (eightDigitId.Length != 8) continue;

                    var lifeStage = LifeStage.Adult;
                    if (!string.IsNullOrEmpty(record.life_stage))
                    {
                        if (Enum.TryParse<LifeStage>(record.life_stage, true, out var parsedLifeStage))
                            lifeStage = parsedLifeStage;
                    }

                    remotePenguinData[eightDigitId] = new PenguinData
                    {
                        ScannedId = eightDigitId,
                        LastKnownLifeStage = lifeStage,
                        Sex = record.sex ?? "",
                        VidForScanner = record.vid_for_scanner ?? "",
                        ChipDate = DateTime.TryParse(record.chip_date, out DateTime chipDateFound) ? chipDateFound : DateTime.MinValue,
                        ChipAs = record.chipped_as_adult == 1 ? "Adult" : ""
                    };
                }

                var birdJson = JsonConvert.SerializeObject(remotePenguinData, Formatting.Indented);
                File.WriteAllText(Path.Combine(context.FilesDir?.AbsolutePath, REMOTE_BIRD_DATA_FILENAME), birdJson);

                // Parse and save box notes from observation_locations
                HttpResponseMessage responseLocations = await responseLocationsTask;
                if (responseLocations.IsSuccessStatusCode)
                {
                    var locationsJson = await responseLocations.Content.ReadAsStringAsync();
                    if (string.IsNullOrEmpty(locationsJson) || !locationsJson.TrimStart().StartsWith("["))
                        throw new Exception($"Locations API: expected JSON array, got: {locationsJson?.Substring(0, Math.Min(locationsJson?.Length ?? 0, 100))}");
                    var locations = JsonConvert.DeserializeObject<List<WildWatchLocation>>(locationsJson);
                    var boxNotes = new Dictionary<string, BoxNoteData>();
                    foreach (var loc in locations)
                    {
                        if (!string.IsNullOrEmpty(loc.location_name))
                        {
                            boxNotes[loc.location_name] = new BoxNoteData
                            {
                                LocationId = loc.location_id,
                                BoxName = loc.location_name,
                                PersistentNotes = loc.persistent_notes ?? ""
                            };
                        }
                    }
                    // Merge latest breeding status from overview (separate fetch, won't break other data)
                    try {
                        var overviewResp = await _httpClient.GetAsync(WILDWATCH_PENGUINS_URL.Replace("penguins.php", "dashboard.php") + "?view=overview");
                        if (overviewResp.IsSuccessStatusCode) {
                            var overviewJson = await overviewResp.Content.ReadAsStringAsync();
                            var overview = JsonConvert.DeserializeObject<Dictionary<string, object>>(overviewJson);
                            if (overview != null && overview.ContainsKey("box_info")) {
                                var boxInfo = JsonConvert.DeserializeObject<Dictionary<string, Dictionary<string, object>>>(overview["box_info"].ToString());
                                if (boxInfo != null) {
                                    foreach (var kvp in boxInfo) {
                                        if (boxNotes.ContainsKey(kvp.Key) && kvp.Value.ContainsKey("s")) {
                                            var status = kvp.Value["s"]?.ToString();
                                            if (!string.IsNullOrEmpty(status))
                                                boxNotes[kvp.Key].BreedingStatus = status;
                                        }
                                    }
                                }
                            }
                        }
                    } catch { }

                    var boxNotesJson = JsonConvert.SerializeObject(boxNotes, Formatting.Indented);
                    File.WriteAllText(Path.Combine(context.FilesDir?.AbsolutePath, BOX_NOTES_FILENAME), boxNotesJson);
                }

                int boxDataCount = 0;
                foreach (MonitorDetails monitorDetails in allMonitorData.Values)
                    boxDataCount += monitorDetails.BoxData.Count;

                // Build toast message with box tag sync info
                string tagSyncInfo = "";
                if (tagSyncResult != null)
                {
                    if (tagSyncResult.Error != null)
                    {
                        tagSyncInfo = ", box tags sync failed";
                    }
                    else
                    {
                        int total = tagSyncResult.Tags.Count;
                        if (tagSyncResult.Uploaded > 0 && tagSyncResult.Downloaded > 0)
                            tagSyncInfo = $", boxTags: {tagSyncResult.Uploaded} up, {tagSyncResult.Downloaded} down.";
                        else if (tagSyncResult.Uploaded > 0)
                            tagSyncInfo = $", boxTags: {tagSyncResult.Uploaded} uploaded.";
                        else if (tagSyncResult.Downloaded > 0)
                            tagSyncInfo = $", boxTags: {tagSyncResult.Downloaded} downloaded.";
                        else
                            tagSyncInfo = $", {total} box tags synced.";
                    }
                }

                downloadResult.BirdCount = remotePenguinData.Count;
                downloadResult.MonitorCount = boxDataCount;

                // Verify penguin count matches server
                var errors = new List<string>();
                try {
                    var countResp = await _httpClient.GetAsync(WILDWATCH_PENGUINS_URL + "?count");
                    var countJson = await countResp.Content.ReadAsStringAsync();
                    var countObj = JsonConvert.DeserializeObject<Dictionary<string, int>>(countJson);
                    if (countObj != null && countObj.ContainsKey("count")) {
                        int expected = countObj["count"];
                        if (remotePenguinData.Count < expected)
                            errors.Add($"Penguins: got {remotePenguinData.Count}/{expected}");
                    }
                } catch { }

                if (remotePenguinData.Count == 0)
                    errors.Add("No penguin records received from server");

                if (errors.Count > 0)
                    downloadResult.Error = string.Join("; ", errors);
            }
            catch (Exception ex)
            {
                downloadResult.Error = ex.Message;
            }
            return downloadResult;
        }
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
        public async Task<Dictionary<string, PenguinData>?> loadRemotePengInfoFromAppDataDir(Android.Content.Context? context)
        {
            try
            {
                string remoteBirdPath = Path.Combine(context.FilesDir?.AbsolutePath, REMOTE_BIRD_DATA_FILENAME);
                //if (!File.Exists(remoteBirdPath))
                //{
                //    await DownloadRemoteData(context, allMonitorData);
                //}
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
                //if (!File.Exists(remoteBoxDataPath))
                //{
                //    await DownloadRemoteData(context, allMonitorData);
                //}
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

        internal async Task<bool> UpdateBoxNotesAsync(int locationId, string notes)
        {
            try
            {
                var request = new HttpRequestMessage(HttpMethod.Post, $"{WILDWATCH_API_URL}?action=update&table=observation_locations&id={locationId}");
                request.Headers.Add("X-API-Key", WILDWATCH_API_KEY);
                var body = JsonConvert.SerializeObject(new { persistent_notes = notes });
                request.Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
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
                if (string.IsNullOrEmpty(filesDir))
                    return;

                var filePath = Path.Combine(filesDir, ALL_MONITOR_DATA_FILENAME);
                if (File.Exists(filePath))
                {
                    File.Delete(filePath);
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to clear auto-save file: {ex.Message}");
            }
        }
        internal static List<BoxData> getOlderBoxDatas(Dictionary<int, MonitorDetails> allMonitorData, int currentlyVisibleMonitor, string boxName)
        {
            List<BoxData> olderBoxDatas = new List<BoxData>();
            for (int i = currentlyVisibleMonitor + 1; i < allMonitorData.Count; i++)
                if (allMonitorData[i].BoxData.ContainsKey(boxName))
                    olderBoxDatas.Add(allMonitorData[i].BoxData[boxName]);
            string? lastBreedingStatus = null;
            for (int i = olderBoxDatas.Count - 1; i >= 0; i--)
            {
                if (olderBoxDatas.ElementAt(i).BreedingChance == null)
                    olderBoxDatas.ElementAt(i).BreedingChance = lastBreedingStatus;
                else
                    lastBreedingStatus = olderBoxDatas.ElementAt(i).BreedingChance;
            }
            return olderBoxDatas;
        }
        internal static string GetBoxBreedingStatusString(string boxName, BoxData? thisBoxData, List<BoxData> olderBoxDatas)
        {
            if(olderBoxDatas.Count == 0)
                return "";
            int skip = 0;
            if (thisBoxData == null) // iterate only using olderboxdatas
            {
                if (olderBoxDatas.Count == 1)
                    return "";
                thisBoxData = olderBoxDatas[0];
                skip = 1;
            }
            if (boxName == "49")
                ;
            // Check if current box is abandoned
            if (thisBoxData?.BreedingChance == "ABN")
                return "Abandoned";
            if (thisBoxData == null || thisBoxData.Eggs + thisBoxData.Chicks == 0 || olderBoxDatas == null || olderBoxDatas.Count==0)
                return "";
            string breedingStatusString = "";
            DateTime whenOffspringFound = MainActivity.ToNzTime(thisBoxData.whenDataCollectedUtc).Date;
            DateTime whenOffspringNotFound = DateTime.MinValue;
            foreach (BoxData olderBoxData in olderBoxDatas.Skip(skip))
            {
                // If we hit an ABN when going back in time (while eggs/chicks still present), the nest was abandoned
                if (olderBoxData.BreedingChance == "ABN" && olderBoxData.Eggs + olderBoxData.Chicks > 0)
                    return "Abandoned";
                if (olderBoxData.Eggs + olderBoxData.Chicks == 0)
                {
                    // Also check if ABN was set on the record when eggs/chicks went to 0
                    if (olderBoxData.BreedingChance == "ABN")
                        return "Abandoned";
                    if (thisBoxData.Eggs > 1) //in case of multiple eggs, assume first one was laid 2 days before found
                        whenOffspringFound = whenOffspringFound.AddDays(-2);
                    whenOffspringNotFound = MainActivity.ToNzTime(olderBoxData.whenDataCollectedUtc).Date;
                    TimeSpan uncertainty = (whenOffspringFound - whenOffspringNotFound)/2;
                    DateTime probableLaidDate = whenOffspringNotFound.AddDays(Math.Ceiling(uncertainty.TotalDays));
                    int daysSinceLaid = (int)(MainActivity.NzToday - probableLaidDate).TotalDays;
                    return breedingDateStatus(daysSinceLaid) + (uncertainty.TotalDays > 1 ? " ±" + (int)uncertainty.TotalDays : "");
                }
                whenOffspringFound = olderBoxData.whenDataCollectedUtc;
            }
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
            return "Fail detecting laid date?";
        }

        /// <summary>
        /// Gets estimated breeding dates for a box based on local data.
        /// Returns null if dates cannot be calculated.
        /// </summary>
        internal static (DateTime? hatch, DateTime? pg, DateTime? chipStart, DateTime? fledge)? GetEstimatedBreedingDates(string boxName, BoxData? thisBoxData, List<BoxData> olderBoxDatas)
        {
            if(olderBoxDatas.Count == 0)
                return null;
            int skip = 0;
            if (thisBoxData == null)
            {
                if (olderBoxDatas.Count == 1)
                    return null;
                thisBoxData = olderBoxDatas[0];
                skip = 1;
            }
            if (thisBoxData?.BreedingChance == "ABN")
                return null;
            if (thisBoxData == null || thisBoxData.Eggs + thisBoxData.Chicks == 0 || olderBoxDatas == null || olderBoxDatas.Count == 0)
                return null;

            // Track whether we ever saw eggs in the history (needed to calculate hatch date)
            bool sawEggsInHistory = thisBoxData.Eggs > 0;

            DateTime whenOffspringFound = MainActivity.ToNzTime(thisBoxData.whenDataCollectedUtc).Date;
            foreach (BoxData olderBoxData in olderBoxDatas.Skip(skip))
            {
                if (olderBoxData.Eggs > 0)
                    sawEggsInHistory = true;

                if (olderBoxData.BreedingChance == "ABN" && olderBoxData.Eggs + olderBoxData.Chicks > 0)
                    return null;
                if (olderBoxData.Eggs + olderBoxData.Chicks == 0)
                {
                    if (olderBoxData.BreedingChance == "ABN")
                        return null;
                    if (thisBoxData.Eggs > 1)
                        whenOffspringFound = whenOffspringFound.AddDays(-2);
                    DateTime whenOffspringNotFound = MainActivity.ToNzTime(olderBoxData.whenDataCollectedUtc).Date;
                    TimeSpan uncertainty = (whenOffspringFound - whenOffspringNotFound) / 2;
                    DateTime probableLaidDate = whenOffspringNotFound.AddDays(Math.Ceiling(uncertainty.TotalDays));
                    int daysSinceLaid = (int)(MainActivity.NzToday - probableLaidDate).TotalDays;

                    // Only show hatch date if we saw eggs in history (otherwise we don't know when egg was laid)
                    // Also don't show if chicks already present (hatching already occurred)
                    DateTime? estHatch = (sawEggsInHistory && thisBoxData.Chicks == 0) ? MainActivity.NzToday.AddDays(38 - daysSinceLaid) : null;
                    DateTime estPG = MainActivity.NzToday.AddDays(52 - daysSinceLaid);
                    DateTime chipStart = MainActivity.NzToday.AddDays(80 - daysSinceLaid);
                    DateTime estFledge = MainActivity.NzToday.AddDays(87 - daysSinceLaid);

                    return (estHatch, estPG, chipStart, estFledge);
                }
                whenOffspringFound = olderBoxData.whenDataCollectedUtc;
            }
            return null;
        }
        private static string getDateString(DateTime expectedDate)
        {
            DateTime today = MainActivity.NzToday;
            if (expectedDate.Date.Equals(today))
            {
                return " today";
            }
            if ((expectedDate.Date - today).TotalDays == 1 && expectedDate > today)
            {
                return " tomorrow";
            }
            if ((today - expectedDate.Date).TotalDays == 1)
            {
                return " yesterday";
            }
            if (expectedDate > today)
            {
                return " " + Math.Ceiling((expectedDate - today).TotalDays) + " days";
            }
            return " " + Math.Ceiling((today - expectedDate).TotalDays) + " days ago";
        }
    }
}