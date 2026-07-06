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

        // Next upcoming milestone for this box's current clutch, with the laid-date
        // uncertainty (± days) appended. estHatchDate is blank once chicks are present.
        public string breedingDateStatus()
        {
            try
            {
                string status = null;
                if (!string.IsNullOrEmpty(estHatchDate))
                {
                    DateTime estHatch = DateTime.Parse(estHatchDate);
                    if (estHatch.AddDays(3) >= MainActivity.NzToday) status = "Hatch" + getDateString(estHatch);
                }
                if (status == null && !string.IsNullOrEmpty(estPGDate))
                {
                    DateTime estPG = DateTime.Parse(estPGDate);
                    if (estPG.AddDays(3) >= MainActivity.NzToday) status = "PG" + getDateString(estPG);
                }
                if (status == null && !string.IsNullOrEmpty(chipWindowStart))
                {
                    DateTime chipStart = DateTime.Parse(chipWindowStart);
                    if (chipStart.AddDays(3) >= MainActivity.NzToday) status = "Chip" + getDateString(chipStart);
                }
                if (status == null && !string.IsNullOrEmpty(estFledgeDate))
                {
                    DateTime estFledge = DateTime.Parse(estFledgeDate);
                    status = "Fledge" + getDateString(estFledge);
                }
                if (status == null) return "";
                return status + (uncertaintyDays > 1 ? " ±" + uncertaintyDays + "d" : "");
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
                return " " + Math.Ceiling((expectedDate - today).TotalDays) + " days";
            }
            return " " + Math.Ceiling((today - expectedDate).TotalDays) + " days ago";
        }
    }
}