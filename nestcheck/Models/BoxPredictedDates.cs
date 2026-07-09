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

        // Next two upcoming milestones for this box's current clutch, with the laid-date
        // uncertainty (± days) appended once. A milestone stays listed until it is past
        // even at maximum uncertainty. estHatchDate is blank once chicks are present.
        public string breedingDateStatus()
        {
            try
            {
                var parts = new List<string>();
                void consider(string label, string dateStr, bool alwaysShow = false)
                {
                    if (parts.Count >= 2 || string.IsNullOrEmpty(dateStr)) return;
                    DateTime d = DateTime.Parse(dateStr);
                    if (alwaysShow || d.AddDays(uncertaintyDays) >= MainActivity.NzToday)
                        parts.Add(label + getDateString(d));
                }

                consider("Hatch", estHatchDate);
                consider("PG", estPGDate);
                consider("Chip", chipWindowStart);
                consider("Fledge", estFledgeDate, alwaysShow: parts.Count == 0);

                if (parts.Count == 0) return "";
                return string.Join(", ", parts) + (uncertaintyDays > 1 ? " ±" + uncertaintyDays + "d" : "");
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