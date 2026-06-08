using System;
using System.Collections.Generic;

namespace PenguinMonitor.Models
{
    public class ColonyState
    {
        public DateTime LastSyncedUtc { get; set; }
        public string DailyLabel { get; set; } = "";
        public string DailyLabelDate { get; set; } = "";

        /// <summary>
        /// Current observations being edited (today's fieldwork).
        /// Keyed by box name (e.g. "1", "49", "AA").
        /// </summary>
        public Dictionary<string, BoxObservation> CurrentBoxes { get; set; } = new();

        /// <summary>
        /// Previous state from server (last known observation per box).
        /// Shown as read-only summary. Not uploaded.
        /// </summary>
        public Dictionary<string, BoxObservation> PreviousBoxes { get; set; } = new();

        /// <summary>
        /// Location name → location_id mapping from server.
        /// </summary>
        public Dictionary<string, int> LocationIds { get; set; } = new();

        public int DirtyCount => CountDirty();

        private int CountDirty()
        {
            int count = 0;
            foreach (var box in CurrentBoxes.Values)
                if (box.IsDirty) count++;
            return count;
        }
    }
}
