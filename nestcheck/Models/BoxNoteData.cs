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
    }
}
