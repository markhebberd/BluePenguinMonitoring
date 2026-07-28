using System;
using System.Collections.Generic;
using Newtonsoft.Json;

namespace PenguinMonitor.Models
{
    public class BoxObservation
    {
        /// <summary>Server-side observation ID. Null for observations not yet uploaded.</summary>
        public int? ObservationId { get; set; }

        public int LocationId { get; set; }
        public string? BoxName { get; set; }

        public List<ScanRecord> ScannedIds { get; set; } = new();
        public int Adults { get; set; }
        public int Eggs { get; set; }
        public int Chicks { get; set; }
        /// <summary>Eggs seen failed on this visit, and chicks seen dead — losses the live counts
        /// can't show, e.g. an egg that failed and was replaced the same day. Null means nobody
        /// recorded either way; 0 means checked and none lost. Matches observations.failed_eggs
        /// and observations.dead_chicks on the server.</summary>
        public int? FailedEggs { get; set; }
        public int? DeadChicks { get; set; }
        public string? GateStatus { get; set; }
        public string Notes { get; set; } = "";
        public DateTime WhenDataCollectedUtc { get; set; }
        public string? BreedingStatus { get; set; }
        public string? MonitorFilename { get; set; }
        public string? ObserverName { get; set; }

        /// <summary>True if this observation has been modified locally and not yet uploaded.</summary>
        [JsonProperty("IsDirty")] // Legacy JSON key — kept for backwards compatibility with saved data on devices
        public bool IsPendingUpload { get; set; }

        /// <summary>UTC timestamp of when this observation was first modified locally.</summary>
        [JsonProperty("DirtyTimestampUtc")] // Legacy JSON key
        public DateTime? PendingUploadSinceUtc { get; set; }

        /// <summary>Server observation_id this edit was confirmed against (for optimistic concurrency).</summary>
        public int? ConfirmedAgainstObsId { get; set; }

        /// <summary>Local draft: edited but not yet committed for upload (the box hasn't been locked).
        /// Persisted so a draft that survives an app restart is still shown as unsynced rather than
        /// being mistaken for server-synced data (IsPendingUpload is false for both). Cleared when
        /// the draft is committed for upload or replaced by server data.</summary>
        public bool IsDraft { get; set; }

        public BoxObservation()
        {
            WhenDataCollectedUtc = DateTime.UtcNow;
        }

        /// <summary>
        /// Create a BoxObservation from server sync data.
        /// </summary>
        public static BoxObservation FromServerData(int observationId, int locationId,
            string observationTimeUtc, int adults, int eggs, int chicks,
            string? breedingStatus, string? gateStatus, string notes, string? monitorFilename,
            string? observerName = null)
        {
            DateTime.TryParse(observationTimeUtc, null, System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out var parsedTime);
            return new BoxObservation
            {
                ObservationId = observationId,
                LocationId = locationId,
                WhenDataCollectedUtc = parsedTime != default ? parsedTime : DateTime.UtcNow,
                Adults = adults,
                Eggs = eggs,
                Chicks = chicks,
                BreedingStatus = breedingStatus,
                GateStatus = gateStatus,
                Notes = notes ?? "",
                MonitorFilename = monitorFilename,
                ObserverName = observerName,
                IsPendingUpload = false,
            };
        }
    }
}
