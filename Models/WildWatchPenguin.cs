namespace PenguinMonitor.Models
{
    public class WildWatchPenguin
    {
        public int penguin_id { get; set; }
        public string penguin_number { get; set; }
        public string tag_number { get; set; }
        public string sex { get; set; }
        public string life_stage { get; set; }
        public string chip_date { get; set; }
        public string vid_for_scanner { get; set; }
        public int? chipped_as_adult { get; set; }
    }
}
