using System;

namespace BluePenguinMonitoring.Models
{
    public class ScanRecord
    {
        public string BirdId { get; set; } = "";
        public DateTime Timestamp { get; set; }
        public double Latitude { get; set; }
        public double Longitude { get; set; }
        public float Accuracy { get; set; }
    }
}