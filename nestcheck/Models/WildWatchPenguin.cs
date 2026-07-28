namespace PenguinMonitor.Models
{
    public class WildWatchPenguin
    {
        public string peng_num { get; set; }
        public string pit_id { get; set; }
        public string sex { get; set; }
        public int? is_dead { get; set; }
        public string chip_date { get; set; }
        public int? chipped_as_adult { get; set; }
        public string chick_size_code { get; set; }
        // Weighted observed_sex tallies from penguins.php ("probably" 2, "maybe" 1). Null on an
        // older server, which simply means no prompt rather than a broken parse.
        public int? sex_guess_m { get; set; }
        public int? sex_guess_f { get; set; }
    }
}
