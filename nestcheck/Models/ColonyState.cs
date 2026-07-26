using System;
using System.Collections.Generic;
using System.Linq;

namespace PenguinMonitor.Models
{
    public class ColonyState
    {
        public DateTime LastSyncedUtc { get; set; }
        public string DailyLabel { get; set; } = "";
        public string DailyLabelDate { get; set; } = "";
        /// <summary>Who was looking in the boxes today, and who was working the phone — users.id
        /// from the server's people list, 0 for "not recorded". Both ride with the daily label to
        /// the colony's day_notes row. Cleared with it at rollover.</summary>
        public int DailyObserverId { get; set; }
        public int DailyRecorderId { get; set; }

        /// <summary>
        /// Pending observations not yet uploaded to server.
        /// Can have multiple per box (across different days while offline).
        /// </summary>
        public List<BoxObservation> PendingObservations { get; set; } = new();

        /// <summary>
        /// Previous state from server (last known observation per box).
        /// Shown as read-only orange summary. Not uploaded.
        /// </summary>
        public Dictionary<string, BoxObservation> PreviousBoxes { get; set; } = new();

        /// <summary>
        /// Today's confirmed observations (uploaded to server today, or downloaded as today's data).
        /// One per box. Shown in edit fields when revisiting.
        /// </summary>
        public Dictionary<string, BoxObservation> TodayBoxes { get; set; } = new();

        /// <summary>
        /// Today's penguin biometric records, keyed by peng_num.
        /// Downloaded during sync and/or edited locally (IsPendingUpload until uploaded).
        /// </summary>
        public Dictionary<string, BiometricRecord> TodayBiometrics { get; set; } = new();

        public int PendingUploadCount => PendingObservations.Count(o => o.IsPendingUpload);

        public int PendingBiometricCount => TodayBiometrics.Values.Count(b => b.IsPendingUpload);

        /// <summary>
        /// Get all pending observations for a specific box, newest first.
        /// </summary>
        public List<BoxObservation> GetPendingForBox(string boxName)
        {
            return PendingObservations
                .Where(o => o.BoxName == boxName)
                .OrderByDescending(o => o.WhenDataCollectedUtc)
                .ToList();
        }

        /// <summary>
        /// Get or create today's observation for a box.
        /// If one exists in TodayBoxes, return it. Otherwise check pending for today.
        /// </summary>
        /// <summary>
        /// Move yesterday's TodayBoxes into PreviousBoxes. Call on app resume or before display.
        /// </summary>
        public void RolloverDay()
        {
            var nzToday = MainActivity.NzToday;
            var nzTodayStr = nzToday.ToString("yyyy-MM-dd");

            var staleKeys = TodayBoxes
                .Where(kvp => MainActivity.ToNzTime(kvp.Value.WhenDataCollectedUtc).Date < nzToday)
                .Select(kvp => kvp.Key)
                .ToList();
            foreach (var key in staleKeys)
            {
                PreviousBoxes[key] = TodayBoxes[key];
                TodayBoxes.Remove(key);
            }

            // Clear daily label (and who was out) if it was set on a previous day
            if (!string.IsNullOrEmpty(DailyLabelDate) && DailyLabelDate != nzTodayStr)
            {
                DailyLabel = "";
                DailyLabelDate = "";
                DailyObserverId = 0;
                DailyRecorderId = 0;
            }

            // Drop downloaded biometrics from a previous day; keep unsynced edits so they aren't lost
            var staleBio = TodayBiometrics
                .Where(kvp => kvp.Value.ObservationDate != nzTodayStr && !kvp.Value.IsPendingUpload)
                .Select(kvp => kvp.Key)
                .ToList();
            foreach (var key in staleBio)
                TodayBiometrics.Remove(key);
        }

        /// <summary>
        /// Store a biometric record for today, keyed by peng_num, replacing any existing one.
        /// </summary>
        public void SaveBiometric(BiometricRecord record)
        {
            if (string.IsNullOrEmpty(record.PengNum)) return;
            TodayBiometrics[record.PengNum] = record;
        }

        public BoxObservation? GetTodayForBox(string boxName)
        {
            if (TodayBoxes.TryGetValue(boxName, out var today))
                return today;
            // Check pending for today's date
            var nzToday = MainActivity.NzToday;
            return PendingObservations
                .Where(o => o.BoxName == boxName && MainActivity.ToNzTime(o.WhenDataCollectedUtc).Date == nzToday)
                .OrderByDescending(o => o.WhenDataCollectedUtc)
                .FirstOrDefault();
        }

        /// <summary>
        /// Save a box observation. If same box + same NZ day exists in pending, update it.
        /// Otherwise add new.
        /// </summary>
        public void SaveBoxObservation(string boxName, BoxObservation obs)
        {
            obs.BoxName = boxName;
            var nzDate = MainActivity.ToNzTime(obs.WhenDataCollectedUtc).Date;
            var existing = PendingObservations.FirstOrDefault(o =>
                o.BoxName == boxName && MainActivity.ToNzTime(o.WhenDataCollectedUtc).Date == nzDate);
            if (existing != null)
            {
                // Update in place
                var idx = PendingObservations.IndexOf(existing);
                PendingObservations[idx] = obs;
            }
            else
            {
                PendingObservations.Add(obs);
            }
        }

    }
}
