namespace PenguinMonitor.Models
{
    /// <summary>
    /// A Bluetooth scanner (HR5 EID reader) the app has connected to before.
    /// Persisted in app settings so it can be reconnected, nicknamed, disabled, or deleted.
    /// When several are enabled the app tries them in list order until one connects.
    /// </summary>
    public class RememberedScanner
    {
        public string Address { get; set; } = "";   // Bluetooth MAC address (stable id)
        public string Name { get; set; } = "";        // original Bluetooth device name
        public string Nickname { get; set; } = "";     // user-editable friendly name
        public bool Enabled { get; set; } = true;      // included in auto-connect when true

        /// <summary>Nickname if set, else the device name, else the address. Always trimmed.</summary>
        public string DisplayName =>
            (!string.IsNullOrWhiteSpace(Nickname) ? Nickname
            : !string.IsNullOrWhiteSpace(Name) ? Name
            : Address).Trim();
    }
}
