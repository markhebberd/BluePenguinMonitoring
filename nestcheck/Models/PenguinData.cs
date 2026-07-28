namespace PenguinMonitor.Models
{
    public enum LifeStage
    {
        Adult,
        Chick,
        Returnee,
        Dead
    }
    public class PenguinData
    {
        public string FullPitId { get; set; } = "";
        public string ScannedId { get; set; } = "";
        public string PengNum { get; set; } = "";
        public LifeStage LastKnownLifeStage { get; set; }
        public DateTime ChipDate { get; set; }
        public string Sex { get; set; } = "";
        public string ChipAs { get; set; } = "";
        public string ChickSizeCode { get; set; } = "";
        /// <summary>Weighted field-sex evidence from the server: a "probably" counts 2, a "maybe" 1.
        /// Once one side reaches SexConfirmScore the bird is worth sexing for real.</summary>
        public int SexGuessM { get; set; }
        public int SexGuessF { get; set; }
    }
}