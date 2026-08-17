using Android.Content;
using Newtonsoft.Json;
using PenguinMonitor.Models;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;

namespace PenguinMonitor.Services
{
    public class BoxTagService
    {
        private const string BOX_TAGS_FILENAME = "box_tags.json";
        private static BoxTagApiService? _apiService;

        /// <summary>
        /// Load box tags from JSON file
        /// </summary>
        public static Dictionary<string, BoxTag> LoadBoxTags(string filesDir)
        {
            string boxTagsPath = Path.Combine(filesDir, BOX_TAGS_FILENAME);
            try
            {
                if (File.Exists(boxTagsPath))
                {
                    var json = File.ReadAllText(boxTagsPath);
                    var tags = JsonConvert.DeserializeObject<Dictionary<string, BoxTag>>(json)
                               ?? new Dictionary<string, BoxTag>();
                    // Tags saved before the reader's "LA" prefix was dropped: a scanned box tag is
                    // matched to its box by string (GetBoxIdByTag), so both sides must spell it the
                    // same way. Idempotent — a bare tag stays as it is.
                    foreach (var t in tags.Values) t.TagNumber = BluetoothManager.BareEid(t.TagNumber ?? "");
                    return tags;
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to load box tags: {ex.Message}");
            }
            return new Dictionary<string, BoxTag>();
        }

        /// <summary>
        /// Save box tags to JSON file
        /// </summary>
        public static void SaveBoxTags(Dictionary<string, BoxTag> boxTags, string filesDir)
        {
            try
            {
                string saveTo = Path.Combine(filesDir, BOX_TAGS_FILENAME);
                string tempFile = saveTo + ".tmp";
                var json = JsonConvert.SerializeObject(boxTags, Formatting.Indented);

                File.Delete(tempFile);
                File.WriteAllText(tempFile, json);

                // Verify the file can be deserialized
                var test = JsonConvert.DeserializeObject<Dictionary<string, BoxTag>>(File.ReadAllText(tempFile));
                if (test != null)
                {
                    File.Move(tempFile, saveTo, true);
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to save box tags: {ex.Message}");
            }
        }

        /// <summary>
        /// Add or update a box tag
        /// </summary>
        public static void AssignBoxTag(Dictionary<string, BoxTag> boxTags, string boxId, string tagNumber,
            double latitude, double longitude, float accuracy, string filesDir, int observerId = 0)
        {
            boxTags[boxId] = new BoxTag
            {
                BoxID = boxId,
                TagNumber = tagNumber,
                ScanTimeUTC = DateTime.UtcNow,
                Latitude = latitude,
                Longitude = longitude,
                Accuracy = accuracy,
                ObserverId = observerId
            };
            SaveBoxTags(boxTags, filesDir);

            // Upload to server (fire-and-forget)
            if (_apiService != null)
            {
                _ = Task.Run(async () =>
                {
                    try
                    {
                        await _apiService.SaveBoxTagAsync(boxTags[boxId]);
                        System.Diagnostics.Debug.WriteLine($"BoxTagService.AssignBoxTag: Uploaded {boxId} to remote");
                    }
                    catch (Exception ex)
                    {
                        System.Diagnostics.Debug.WriteLine($"BoxTagService.AssignBoxTag: Remote upload failed: {ex.Message}");
                    }
                });
            }
        }

        /// <summary>
        /// Remove the tag number from a box without replacing it, keeping the stored location.
        /// Clears pit_id locally and on the server.
        /// </summary>
        public static void ClearBoxTagNumber(Dictionary<string, BoxTag> boxTags, string boxId, string filesDir)
        {
            if (boxTags.TryGetValue(boxId, out var tag))
            {
                tag.TagNumber = "";
                SaveBoxTags(boxTags, filesDir);

                if (_apiService != null)
                {
                    _ = Task.Run(async () =>
                    {
                        try
                        {
                            await _apiService.DeleteBoxTagAsync(boxId);
                            System.Diagnostics.Debug.WriteLine($"BoxTagService.ClearBoxTagNumber: Cleared {boxId} tag on remote");
                        }
                        catch (Exception ex)
                        {
                            System.Diagnostics.Debug.WriteLine($"BoxTagService.ClearBoxTagNumber: Remote clear failed: {ex.Message}");
                        }
                    });
                }
            }
        }

        /// <summary>
        /// Remove a box tag
        /// </summary>
        public static void RemoveBoxTag(Dictionary<string, BoxTag> boxTags, string boxId, string filesDir)
        {
            if (boxTags.ContainsKey(boxId))
            {
                boxTags.Remove(boxId);
                SaveBoxTags(boxTags, filesDir);
            }
        }

        /// <summary>
        /// Get box ID by tag number
        /// </summary>
        public static string? GetBoxIdByTag(Dictionary<string, BoxTag> boxTags, string tagNumber)
        {
            foreach (var kvp in boxTags)
            {
                if (kvp.Value.TagNumber == tagNumber)
                {
                    return kvp.Key;
                }
            }
            return null;
        }

        /// <summary>
        /// Check if a scanned ID is a box tag (ISO digits start with 9000250)
        /// </summary>
        public static bool IsBoxTag(string scannedId)
        {
            // Tags are the bare ISO digits; a value that still carries the reader's letter prefix
            // (an older stored scan, a pasted number) is the same tag, so judge it once stripped.
            var cleanId = BluetoothManager.BareEid(new String(scannedId.Where(char.IsLetterOrDigit).ToArray()));
            return cleanId.StartsWith("9000250", StringComparison.Ordinal);
        }

        /// <summary>
        /// Check if a scanned ID is a penguin tag (ISO digits start with 9560000)
        /// </summary>
        public static bool IsPenguinTag(string scannedId)
        {
            var cleanId = BluetoothManager.BareEid(new String(scannedId.Where(char.IsLetterOrDigit).ToArray()));
            return cleanId.StartsWith("9560000", StringComparison.Ordinal);
        }

        #region Remote API Methods

        /// <summary>
        /// Initialize the API service with credentials
        /// </summary>
        public static void InitializeApi(string apiUrl, Func<string?> tokenProvider, Func<int> colonyProvider)
        {
            if (!string.IsNullOrWhiteSpace(apiUrl))
            {
                _apiService = new BoxTagApiService(apiUrl, tokenProvider, colonyProvider);
                System.Diagnostics.Debug.WriteLine($"BoxTagService API initialized: {apiUrl}");
            }
        }

        /// <summary>
        /// What the sync found for box tags. Filled from the snapshot feed's locations now — a box
        /// tag IS a location's pit_id and stored fix, so there is nothing left to fetch separately;
        /// this API only takes the writes.
        /// </summary>
        public class SyncResult
        {
            public Dictionary<string, BoxTag> Tags { get; set; } = new();
            public bool ApiAvailable { get; set; }
            public string? Error { get; set; }
        }

        /// <summary>
        /// Remove a box tag from both local and remote
        /// </summary>
        public static async Task RemoveBoxTagAsync(
            Dictionary<string, BoxTag> boxTags,
            string boxId,
            string filesDir)
        {
            if (boxTags.ContainsKey(boxId))
            {
                boxTags.Remove(boxId);

                // Save locally first
                SaveBoxTags(boxTags, filesDir);

                if (_apiService != null)
                {
                    try
                    {
                        await _apiService.DeleteBoxTagAsync(boxId);
                        System.Diagnostics.Debug.WriteLine($"BoxTagService.RemoveBoxTagAsync: Deleted {boxId} from remote");
                    }
                    catch (Exception ex)
                    {
                        System.Diagnostics.Debug.WriteLine($"BoxTagService.RemoveBoxTagAsync: Remote delete failed: {ex.Message}");
                    }
                }
            }
        }

        #endregion
    }
}
