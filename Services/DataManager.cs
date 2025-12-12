using PenguinMonitor.Models;
using System.Collections.ObjectModel;

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
}
