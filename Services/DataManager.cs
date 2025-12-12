using PenguinMonitor.Models;
using System.Collections.ObjectModel;
using System.Text.RegularExpressions;

namespace PenguinMonitor.Services;

public class DataManager
{
    private static DataManager? _instance;
    public static DataManager Instance => _instance ??= new DataManager();

    // Core data structures from old MainActivity
    public Dictionary<int, MonitorDetails> AllMonitorData { get; set; } = new();
    public AppSettings AppSettings { get; set; } = new("");  // filesDir will be set on first load
    public Dictionary<string, PenguinData>? RemotePenguinData { get; set; }
    public Dictionary<string, BoxPredictedDates>? RemoteBreedingDates { get; set; }
    public Dictionary<string, BoxTag> BoxTags { get; set; } = new();
    public Dictionary<string, int> BoxNamesAndIndexes { get; set; } = new();

    // Bluetooth manager (Android platform specific)
    private BluetoothManager? _bluetoothManager;
    public BluetoothManager? BluetoothManager => _bluetoothManager;

    // GPS/Location tracking
    private float _gpsAccuracy = -1;
    public float GpsAccuracy => _gpsAccuracy;

    // Current state
    public int CurrentBoxIndex { get; set; } = 1;
    public string CurrentBoxName { get; set; } = "";
    public int CurrentHistoricalDataIndex { get; set; } = 0;
    public bool IsBoxLocked { get; set; } = true;

    // Events for UI updates
    public event EventHandler? DataChanged;
    public event EventHandler<string>? BoxChanged;
    public event EventHandler<string>? StatusChanged;
    public event Action<string>? EidDataReceived;

    public void RaiseDataChanged() => DataChanged?.Invoke(this, EventArgs.Empty);
    public void RaiseBoxChanged(string boxName) => BoxChanged?.Invoke(this, boxName);
    public void RaiseStatusChanged(string status) => StatusChanged?.Invoke(this, status);

    public void InitializeBluetooth()
    {
        if (_bluetoothManager != null) return;

        _bluetoothManager = new BluetoothManager();
        _bluetoothManager.StatusChanged += (status) => RaiseStatusChanged(status);
        _bluetoothManager.EidDataReceived += (eid) => EidDataReceived?.Invoke(eid);

        if (AppSettings.IsBlueToothEnabled)
        {
            _ = _bluetoothManager.StartConnectionAsync();
        }
    }

    public async Task EnableBluetoothAsync()
    {
        if (_bluetoothManager == null)
        {
            InitializeBluetooth();
        }

        if (_bluetoothManager != null)
        {
            await _bluetoothManager.StartConnectionAsync();
        }
    }

    public void DisableBluetooth()
    {
        _bluetoothManager?.Disconnect();
        RaiseStatusChanged("Bluetooth Disabled");
    }

    public void UpdateGpsAccuracy(float accuracy)
    {
        _gpsAccuracy = accuracy;
        RaiseStatusChanged(GetFullStatusText());
    }

    public string GetFullStatusText()
    {
        // Build combined status like main branch: "{bluetoothStatus} | GPS: ±{accuracy}m"
        var btStatus = "Bluetooth Disabled";
        if (_bluetoothManager != null)
        {
            btStatus = _bluetoothManager.IsConnected ? "✅ HR5 Connected" : "🔗 Connecting to HR5...";
        }
        else if (AppSettings.IsBlueToothEnabled)
        {
            btStatus = "Bluetooth Enabled";
        }

        var gpsStatus = _gpsAccuracy > 0 ? $" | GPS: ±{_gpsAccuracy:F1}m" : " | GPS: No signal";
        return btStatus + gpsStatus;
    }

    // Get current box data
    public BoxData? GetCurrentBoxData()
    {
        int displayMonitorIndex = AppSettings.CurrentlyVisibleMonitor + CurrentHistoricalDataIndex;

        if (AllMonitorData.ContainsKey(displayMonitorIndex) &&
            AllMonitorData[displayMonitorIndex].BoxData.ContainsKey(CurrentBoxName))
        {
            return AllMonitorData[displayMonitorIndex].BoxData[CurrentBoxName];
        }

        return null;
    }

    // Set current box data
    public void SetCurrentBoxData(BoxData boxData)
    {
        int displayMonitorIndex = AppSettings.CurrentlyVisibleMonitor + CurrentHistoricalDataIndex;

        if (!AllMonitorData.ContainsKey(displayMonitorIndex))
        {
            AllMonitorData[displayMonitorIndex] = new MonitorDetails
            {
                BoxData = new Dictionary<string, BoxData>()
            };
        }

        AllMonitorData[displayMonitorIndex].BoxData[CurrentBoxName] = boxData;
        RaiseDataChanged();
    }

    // Navigation
    public bool CanNavigateToNextBox()
    {
        if (BoxNamesAndIndexes == null || !BoxNamesAndIndexes.Any())
            return false;

        int nextIndex = CurrentBoxIndex + 1;
        return BoxNamesAndIndexes.Values.Any(v => v == nextIndex);
    }

    public bool CanNavigateToPreviousBox()
    {
        if (BoxNamesAndIndexes == null || !BoxNamesAndIndexes.Any())
            return false;

        int prevIndex = CurrentBoxIndex - 1;
        return prevIndex >= 1 && BoxNamesAndIndexes.Values.Any(v => v == prevIndex);
    }

    public void NavigateToNextBox()
    {
        if (!CanNavigateToNextBox()) return;

        CurrentBoxIndex++;
        var box = BoxNamesAndIndexes.FirstOrDefault(kvp => kvp.Value == CurrentBoxIndex);
        if (!string.IsNullOrEmpty(box.Key))
        {
            CurrentBoxName = box.Key;
            RaiseBoxChanged(CurrentBoxName);
        }
    }

    public void NavigateToPreviousBox()
    {
        if (!CanNavigateToPreviousBox()) return;

        CurrentBoxIndex--;
        var box = BoxNamesAndIndexes.FirstOrDefault(kvp => kvp.Value == CurrentBoxIndex);
        if (!string.IsNullOrEmpty(box.Key))
        {
            CurrentBoxName = box.Key;
            RaiseBoxChanged(CurrentBoxName);
        }
    }

    // Clear current box data
    public void ClearCurrentBox()
    {
        int displayMonitorIndex = AppSettings.CurrentlyVisibleMonitor + CurrentHistoricalDataIndex;

        if (AllMonitorData.ContainsKey(displayMonitorIndex) &&
            AllMonitorData[displayMonitorIndex].BoxData.ContainsKey(CurrentBoxName))
        {
            AllMonitorData[displayMonitorIndex].BoxData.Remove(CurrentBoxName);
            RaiseDataChanged();
        }
    }

    /// <summary>
    /// Populates BoxNamesAndIndexes from the current box set settings.
    /// Supports numeric ranges (1-150), alphanumeric ranges (AA-AC, N1-N6), and single values.
    /// </summary>
    public void PopulateBoxNames()
    {
        string setString;
        try
        {
            setString = AppSettings.BoxSetString?.ToLower() == "all"
                ? AppSettings.AllBoxSetsString ?? ""
                : AppSettings.BoxSetString ?? "";
        }
        catch
        {
            // AppSettings not yet initialized, use default
            setString = "";
        }

        BoxNamesAndIndexes = new Dictionary<string, int>();

        if (!string.IsNullOrWhiteSpace(setString))
        {
            BoxNamesAndIndexes.Clear();
            int currentIndex = 1;

            foreach (string boxSetString in setString.Split(new string[] { "}{", "},{" }, StringSplitOptions.RemoveEmptyEntries))
            {
                // Remove curly braces
                string cleanedSet = boxSetString.Trim('{', '}');

                foreach (string boxSetPart in cleanedSet.Split(',', StringSplitOptions.RemoveEmptyEntries))
                {
                    string trimmedPart = boxSetPart.Trim();

                    if (trimmedPart.Contains('-'))
                    {
                        // Handle ranges like "1-150", "AA-AC", "N1-N6"
                        var rangeParts = trimmedPart.Split('-');
                        if (rangeParts.Length == 2)
                        {
                            string start = rangeParts[0].Trim();
                            string end = rangeParts[1].Trim();

                            // Check if it's a numeric range (e.g., "1-150")
                            if (int.TryParse(start, out int startNum) && int.TryParse(end, out int endNum))
                            {
                                for (int i = startNum; i <= endNum; i++)
                                {
                                    BoxNamesAndIndexes[i.ToString()] = currentIndex++;
                                }
                            }
                            else
                            {
                                // Handle alphanumeric ranges (e.g., "AA-AC", "N1-N6")
                                var expandedRange = ExpandAlphanumericRange(start, end);
                                foreach (string boxName in expandedRange)
                                {
                                    BoxNamesAndIndexes[boxName.ToUpper()] = currentIndex++;
                                }
                            }
                        }
                    }
                    else
                    {
                        // Single box name/number
                        BoxNamesAndIndexes[trimmedPart.ToUpper()] = currentIndex++;
                    }
                }
            }
        }

        // Limit to 1000 boxes
        if (BoxNamesAndIndexes.Count > 1000)
            BoxNamesAndIndexes = BoxNamesAndIndexes.Take(1000).ToDictionary(kvp => kvp.Key, kvp => kvp.Value);

        // Ensure boxes exist - use default 1-150 if nothing was parsed
        if (BoxNamesAndIndexes.Count == 0)
        {
            for (int i = 1; i <= 150; i++)
            {
                BoxNamesAndIndexes[i.ToString()] = i;
            }
        }

        // Reset current box to first if needed
        if (!BoxNamesAndIndexes.ContainsKey(CurrentBoxName))
        {
            var firstBox = BoxNamesAndIndexes.FirstOrDefault();
            CurrentBoxName = firstBox.Key;
            CurrentBoxIndex = firstBox.Value;
        }
    }

    /// <summary>
    /// Expands alphanumeric ranges like "AA-AC" or "N1-N6"
    /// </summary>
    private List<string> ExpandAlphanumericRange(string start, string end)
    {
        var result = new List<string>();

        // Extract prefix and numeric suffix
        var startMatch = Regex.Match(start, @"^([A-Za-z]*)(\d*)$");
        var endMatch = Regex.Match(end, @"^([A-Za-z]*)(\d*)$");

        if (!startMatch.Success || !endMatch.Success)
        {
            // If pattern doesn't match, just add both as individual items
            result.Add(start);
            result.Add(end);
            return result;
        }

        string startPrefix = startMatch.Groups[1].Value;
        string endPrefix = endMatch.Groups[1].Value;
        string startNumStr = startMatch.Groups[2].Value;
        string endNumStr = endMatch.Groups[2].Value;

        // Case 1: Pure alphabetic range (e.g., "AA-AC")
        if (string.IsNullOrEmpty(startNumStr) && string.IsNullOrEmpty(endNumStr) &&
            startPrefix.Length == endPrefix.Length)
        {
            result.AddRange(ExpandAlphabeticRange(startPrefix, endPrefix));
        }
        // Case 2: Same prefix with numeric range (e.g., "N1-N6")
        else if (startPrefix == endPrefix &&
                 int.TryParse(startNumStr, out int startNum) &&
                 int.TryParse(endNumStr, out int endNum))
        {
            for (int i = startNum; i <= endNum; i++)
            {
                result.Add(startPrefix + i.ToString());
            }
        }
        else
        {
            // Fallback: add both as individual items
            result.Add(start);
            result.Add(end);
        }

        return result;
    }

    /// <summary>
    /// Expands purely alphabetic ranges like "AA-AC"
    /// </summary>
    private List<string> ExpandAlphabeticRange(string start, string end)
    {
        var result = new List<string>();

        if (start.Length != end.Length)
        {
            result.Add(start);
            result.Add(end);
            return result;
        }

        // Convert to base-26 numbers for easier iteration
        int startValue = AlphaToNumber(start);
        int endValue = AlphaToNumber(end);

        for (int i = startValue; i <= endValue; i++)
        {
            result.Add(NumberToAlpha(i, start.Length));
        }

        return result;
    }

    /// <summary>
    /// Convert alphabetic string to number (A=0, B=1, ..., Z=25, AA=26, etc.)
    /// </summary>
    private int AlphaToNumber(string alpha)
    {
        int result = 0;
        for (int i = 0; i < alpha.Length; i++)
        {
            result = result * 26 + (char.ToUpper(alpha[i]) - 'A');
        }
        return result;
    }

    /// <summary>
    /// Convert number back to alphabetic string of specified length
    /// </summary>
    private string NumberToAlpha(int number, int length)
    {
        string result = "";
        for (int i = 0; i < length; i++)
        {
            result = (char)('A' + (number % 26)) + result;
            number /= 26;
        }
        return result;
    }
}
