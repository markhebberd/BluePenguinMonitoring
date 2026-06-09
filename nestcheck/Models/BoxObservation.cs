using System;
using System.Collections.Generic;

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
        public string? GateStatus { get; set; }
        public string Notes { get; set; } = "";
        public DateTime WhenDataCollectedUtc { get; set; }
        public string? BreedingStatus { get; set; }
        public string? MonitorFilename { get; set; }
        public string? ObserverName { get; set; }

        /// <summary>True if this observation has been modified locally and not yet uploaded.</summary>
        public bool IsDirty { get; set; }

        /// <summary>UTC timestamp of when this observation was first modified locally.</summary>
        public DateTime? DirtyTimestampUtc { get; set; }

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
                IsDirty = false,
            };
        }
    }
}
