namespace PenguinMonitor.Models
{
    public class BoxNoteData
    {
        public int LocationId { get; set; }
        public string BoxName { get; set; } = "";
        public string PersistentNotes { get; set; } = "";
        public string? BreedingStatus { get; set; }
        /// <summary>Box is flagged as watched on the website (observation_locations.watched).</summary>
        public bool Watched { get; set; }
        /// <summary>Local watched toggle not yet pushed to the server (kept across sync refreshes).</summary>
        public bool WatchedPendingUpload { get; set; }
        /// <summary>Note edited on the phone and not yet accepted by the server — written out of
        /// signal, or refused. Kept across sync refreshes, which otherwise take the server's older
        /// text as truth and quietly undo the edit, and retried on every sync.</summary>
        public bool NotesPendingUpload { get; set; }
    }
}
