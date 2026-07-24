namespace PenguinMonitor.Models
{
    public class BoxPredictedDates
    {
        public int boxNumber { get; set; }
        public string estHatchDate { get; set; }
        public string estPGDate { get; set; }
        public string estFledgeDate { get; set; }
        public string chipWindowStart { get; set; }
        public string chipWindowFinish { get; set; }
        public int uncertaintyDays { get; set; }

        // The milestone nearest today for this box's current clutch — the one the observer
        // is either about to see or has just missed, whichever is closer ("Hatch 2 days ago",
        // "PG in 7 days ±3d"). estHatchDate is blank once chicks are present.
        public string breedingDateStatus()
        {
            try
            {
                DateTime today = MainActivity.NzToday;
                (string label, DateTime date)? closest = null;
                void consider(string label, string dateStr)
                {
                    if (string.IsNullOrEmpty(dateStr) || !DateTime.TryParse(dateStr, out DateTime d)) return;
                    if (closest == null ||
                        Math.Abs((d.Date - today).TotalDays) < Math.Abs((closest.Value.date - today).TotalDays))
                        closest = (label, d.Date);
                }

                consider("Hatch", estHatchDate);
                consider("PG", estPGDate);
                consider("Chip", chipWindowStart);
                consider("Fledge", estFledgeDate);

                if (closest == null) return "";
                var (bestLabel, bestDate) = closest.Value;
                // ± is a prediction's error bar, so it only means anything ahead of the date —
                // a milestone in the past either happened or it didn't.
                string uncertainty = bestDate > today && uncertaintyDays > 0 ? " ±" + uncertaintyDays + "d" : "";
                return bestLabel + getDateString(bestDate) + uncertainty;
            }
            catch { return ""; }
        }
        private string getDateString(DateTime expectedDate)
        {
            DateTime today = MainActivity.NzToday;
            if (expectedDate.Date.Equals(today))
            {
                return " today";
            }
            if ((expectedDate.Date - today).TotalDays == 1 && expectedDate > today)
            {
                return " tomorrow";
            }
            if ((today - expectedDate.Date).TotalDays == 1)
            {
                return " yesterday";
            }
            if (expectedDate > today)
            {
                return " in " + Math.Ceiling((expectedDate - today).TotalDays) + " days";
            }
            return " " + Math.Ceiling((today - expectedDate).TotalDays) + " days ago";
        }
    }
}