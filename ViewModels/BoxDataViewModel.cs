using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows.Input;
using PenguinMonitor.Models;
using PenguinMonitor.Services;

namespace PenguinMonitor.ViewModels;

public class ScanRecordDisplay : INotifyPropertyChanged
{
    public string BirdId { get; set; } = "";
    public DateTime Timestamp { get; set; }
    public double Latitude { get; set; }
    public double Longitude { get; set; }
    public float Accuracy { get; set; }
    public string SexLabel { get; set; } = "";
    public string LifeStageLabel { get; set; } = "";
    public string BackgroundColor { get; set; } = "#FAFAFA";
    public string TimestampDisplay => Timestamp.ToLocalTime().ToString("HH:mm, d MMM");
    public string GpsInfo => Accuracy > 0 ? $"±{Accuracy:F0}m" : "";

    public event PropertyChangedEventHandler? PropertyChanged;

    public static ScanRecordDisplay FromScanRecord(ScanRecord scan, Dictionary<string, PenguinData>? penguinData)
    {
        var display = new ScanRecordDisplay
        {
            BirdId = scan.BirdId,
            Timestamp = scan.Timestamp,
            Latitude = scan.Latitude,
            Longitude = scan.Longitude,
            Accuracy = scan.Accuracy
        };

        if (penguinData != null && penguinData.TryGetValue(scan.BirdId, out var penguin))
        {
            // Set sex label
            if (penguin.Sex.Equals("F", StringComparison.OrdinalIgnoreCase))
            {
                display.SexLabel = "♀";
                display.BackgroundColor = "#FFE4E1"; // Light pink for female
            }
            else if (penguin.Sex.Equals("M", StringComparison.OrdinalIgnoreCase))
            {
                display.SexLabel = "♂";
                display.BackgroundColor = "#E6F3FF"; // Light blue for male
            }

            // Set life stage label - prioritize chick status
            if (penguin.LastKnownLifeStage == LifeStage.Chick)
            {
                // Check if chick is now old enough to be considered adult
                if (penguin.ChipDate > DateTime.Today.AddYears(-20) && DateTime.Today > penguin.ChipDate.AddMonths(3))
                {
                    display.LifeStageLabel = "(Returnee)";
                }
                else
                {
                    display.LifeStageLabel = "(Chick)";
                    display.BackgroundColor = "#FFFFE6"; // Light yellow for chick
                }
            }
            else if (penguin.LastKnownLifeStage == LifeStage.Returnee)
            {
                display.LifeStageLabel = "(Returnee)";
            }
            else if (penguin.LastKnownLifeStage == LifeStage.Dead)
            {
                display.LifeStageLabel = "(Dead!)";
                display.BackgroundColor = "#FFCCCC"; // Light red for dead
            }
        }
        else
        {
            display.LifeStageLabel = "(Unknown)";
            display.BackgroundColor = "#FFFACD"; // Light yellow for unknown
        }

        return display;
    }

    public ScanRecord ToScanRecord()
    {
        return new ScanRecord
        {
            BirdId = BirdId,
            Timestamp = Timestamp,
            Latitude = Latitude,
            Longitude = Longitude,
            Accuracy = Accuracy
        };
    }
}

public class BoxDataViewModel : INotifyPropertyChanged
{
    private readonly DataManager _dataManager = DataManager.Instance;
    private readonly DataStorageService _dataStorageService = new DataStorageService();
    private BoxData? _currentBoxData;
    private string _manualScanInput = "";

    public event PropertyChangedEventHandler? PropertyChanged;

    public BoxDataViewModel()
    {
        // Subscribe to data manager events
        _dataManager.DataChanged += OnDataManagerChanged;
        _dataManager.BoxChanged += OnBoxChanged;

        // Initialize box names ONLY if not already done (lazy)
        if (_dataManager.BoxNamesAndIndexes.Count == 0)
        {
            for (int i = 1; i <= 150; i++)
            {
                _dataManager.BoxNamesAndIndexes[i.ToString()] = i;
            }
        }

        if (string.IsNullOrEmpty(_dataManager.CurrentBoxName))
        {
            _dataManager.CurrentBoxName = "1";
            _dataManager.CurrentBoxIndex = 1;
        }

        // Initialize commands
        PrevBoxCommand = new Command(OnPreviousBox);
        NextBoxCommand = new Command(OnNextBox);
        SelectBoxCommand = new Command(OnSelectBox);
        ClearBoxCommand = new Command(OnClearBox);
        ToggleLockCommand = new Command(OnToggleLock);
        CancelEditCommand = new Command(OnCancelEdit);
        DeleteScanCommand = new Command<ScanRecordDisplay>(OnDeleteScan);
        MoveScanCommand = new Command<ScanRecordDisplay>(OnMoveScan);
        AddManualScanCommand = new Command(OnAddManualScan);
        ViewOlderDataCommand = new Command(OnViewOlderData);
        ViewNewerDataCommand = new Command(OnViewNewerData);

        // Load initial data
        RefreshView();
    }

    // Properties bound to UI
    public string CurrentBoxName => _dataManager.CurrentBoxName;
    public string BoxTitle => $"Box {CurrentBoxName}";
    public bool IsLocked => _dataManager.IsBoxLocked;
    public string LockIcon => IsLocked ? "🔒" : "🔓";

    // Lock color based on state: Green (locked with data), Yellow (locked no data), Orange (saved empty), Red (unlocked)
    public string LockColor
    {
        get
        {
            if (!IsLocked)
                return "#F44336"; // Red - unlocked
            else if (CurrentBoxData == null)
                return "#FF9800"; // Yellow - no data at all
            else if (!HasAnyData() && CurrentBoxData.whenDataCollectedUtc != DateTime.MinValue)
                return "#FF5722"; // Orange - explicitly saved as empty
            else if (!HasAnyData())
                return "#FF9800"; // Yellow - locked but no data
            else
                return "#4CAF50"; // Green - locked with data
        }
    }

    // Status text to show under the lock icon
    public string BoxStatusText
    {
        get
        {
            if (!IsLocked)
                return "Editing";
            else if (CurrentBoxData == null)
                return "No data";
            else if (!HasAnyData() && CurrentBoxData.whenDataCollectedUtc != DateTime.MinValue)
                return "Empty ✓";
            else if (!HasAnyData())
                return "No data";
            else
                return "Saved";
        }
    }

    // Title color - red when viewing historical data
    public string TitleColor => _dataManager.CurrentHistoricalDataIndex > 0 ? "#F44336" : "#212121";

    // Historical data navigation
    public bool HasHistoricalData => _dataManager.AllMonitorData.Count > 1;
    public bool IsViewingHistoricalData => _dataManager.CurrentHistoricalDataIndex > 0;

    // Show navigation when there's older data available or when viewing historical data
    public bool ShowHistoricalNavigation => CanViewOlderData || IsViewingHistoricalData;

    public bool CanViewOlderData
    {
        get
        {
            int maxHistoricalIndex = _dataManager.AllMonitorData.Count - 1;
            if (_dataManager.CurrentHistoricalDataIndex >= maxHistoricalIndex) return false;

            // Check if there's older data with this box
            for (int i = _dataManager.CurrentHistoricalDataIndex + 1; i <= maxHistoricalIndex; i++)
            {
                int displayMonitorIndex = _dataManager.AppSettings.CurrentlyVisibleMonitor + i;
                if (_dataManager.AllMonitorData.ContainsKey(displayMonitorIndex) &&
                    _dataManager.AllMonitorData[displayMonitorIndex].BoxData.ContainsKey(_dataManager.CurrentBoxName))
                {
                    return true;
                }
            }
            return false;
        }
    }

    public bool CanViewNewerData => _dataManager.CurrentHistoricalDataIndex > 0;

    public double OlderButtonOpacity => CanViewOlderData ? 1.0 : 0.5;
    public double NewerButtonOpacity => CanViewNewerData ? 1.0 : 0.5;

    public string HistoricalDataLabel
    {
        get
        {
            if (_dataManager.CurrentHistoricalDataIndex == 0)
                return "Current Data";

            int displayMonitorIndex = _dataManager.AppSettings.CurrentlyVisibleMonitor + _dataManager.CurrentHistoricalDataIndex;
            if (_dataManager.AllMonitorData.ContainsKey(displayMonitorIndex))
            {
                var monitor = _dataManager.AllMonitorData[displayMonitorIndex];
                if (!string.IsNullOrEmpty(monitor.filename))
                    return $"📜 {monitor.filename}";
                return $"📜 Historical #{_dataManager.CurrentHistoricalDataIndex}";
            }
            return $"📜 Historical #{_dataManager.CurrentHistoricalDataIndex}";
        }
    }

    // Historical indicator shows when viewing past data
    public string HistoricalIndicator => _dataManager.CurrentHistoricalDataIndex > 0
        ? $"📜 {_dataManager.CurrentHistoricalDataIndex}"
        : "";

    // Data saved time display
    public string DataSavedTime
    {
        get
        {
            if (CurrentBoxData != null && CurrentBoxData.whenDataCollectedUtc != DateTime.MinValue)
            {
                return CurrentBoxData.whenDataCollectedUtc.ToLocalTime().ToString("d MMM yyyy\nHH:mm");
            }
            return "";
        }
    }

    // Sticky notes from historical data
    public bool HasStickyNotes => !string.IsNullOrWhiteSpace(StickyNotes);
    public string StickyNotes
    {
        get
        {
            var notes = DataStorageService.getStickyNotes(
                DataStorageService.getOlderBoxDatas(
                    _dataManager.AllMonitorData,
                    _dataManager.AppSettings.CurrentlyVisibleMonitor + _dataManager.CurrentHistoricalDataIndex,
                    _dataManager.CurrentBoxName));
            return string.IsNullOrWhiteSpace(notes) ? "" : $"💡 Note: {notes}";
        }
    }

    public BoxData? CurrentBoxData
    {
        get => _currentBoxData;
        set
        {
            _currentBoxData = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(HasNoScans));
            OnPropertyChanged(nameof(HasScans));
            OnPropertyChanged(nameof(NoScansMessage));
            OnPropertyChanged(nameof(ScannedBirds));
            OnPropertyChanged(nameof(ScannedBirdsHeader));
            OnPropertyChanged(nameof(Adults));
            OnPropertyChanged(nameof(Eggs));
            OnPropertyChanged(nameof(Chicks));
            OnPropertyChanged(nameof(Notes));
            OnPropertyChanged(nameof(GateStatus));
            OnPropertyChanged(nameof(BreedingChance));
            OnPropertyChanged(nameof(DataSavedTime));
            OnPropertyChanged(nameof(LockColor));
            OnPropertyChanged(nameof(CanClearBox));
            OnPropertyChanged(nameof(ClearButtonOpacity));
        }
    }

    public bool HasNoScans => CurrentBoxData == null || !CurrentBoxData.ScannedIds.Any();
    public bool HasScans => !HasNoScans;
    public string NoScansMessage => "No birds scanned yet";
    public string ScannedBirdsHeader => HasScans ? $"🐧 {CurrentBoxData!.ScannedIds.Count} bird{(CurrentBoxData.ScannedIds.Count == 1 ? "" : "s")} scanned:" : "Scanned Bird IDs";

    public ObservableCollection<ScanRecordDisplay> ScannedBirds
    {
        get
        {
            if (CurrentBoxData == null) return new ObservableCollection<ScanRecordDisplay>();

            var displays = CurrentBoxData.ScannedIds
                .Select(s => ScanRecordDisplay.FromScanRecord(s, _dataManager.RemotePenguinData))
                .ToList();
            return new ObservableCollection<ScanRecordDisplay>(displays);
        }
    }

    // Manual scan input
    public string ManualScanInput
    {
        get => _manualScanInput;
        set
        {
            _manualScanInput = value;
            OnPropertyChanged();
        }
    }

    // Can edit based on lock state and not viewing historical data
    public bool CanEdit => !IsLocked && _dataManager.CurrentHistoricalDataIndex == 0;
    public bool CanEditScans => CanEdit;

    public string Adults
    {
        get => CurrentBoxData?.Adults.ToString() ?? "0";
        set
        {
            if (CurrentBoxData != null && int.TryParse(value, out int adults))
            {
                CurrentBoxData.Adults = adults;
                OnPropertyChanged();
                SaveCurrentBoxData();
            }
        }
    }

    public string Eggs
    {
        get => CurrentBoxData?.Eggs.ToString() ?? "0";
        set
        {
            if (CurrentBoxData != null && int.TryParse(value, out int eggs))
            {
                CurrentBoxData.Eggs = eggs;
                OnPropertyChanged();
                SaveCurrentBoxData();
            }
        }
    }

    public string Chicks
    {
        get => CurrentBoxData?.Chicks.ToString() ?? "0";
        set
        {
            if (CurrentBoxData != null && int.TryParse(value, out int chicks))
            {
                CurrentBoxData.Chicks = chicks;
                OnPropertyChanged();
                SaveCurrentBoxData();
            }
        }
    }

    public string Notes
    {
        get => CurrentBoxData?.Notes ?? "";
        set
        {
            if (CurrentBoxData != null)
            {
                CurrentBoxData.Notes = value;
                OnPropertyChanged();
                SaveCurrentBoxData();
            }
        }
    }

    public string? GateStatus
    {
        get => CurrentBoxData?.GateStatus ?? "";
        set
        {
            if (CurrentBoxData != null)
            {
                CurrentBoxData.GateStatus = value;
                OnPropertyChanged();
                SaveCurrentBoxData();

                // Auto-lock when gate status is set to Gate up or Regate
                if (value == "Gate up" || value == "Regate")
                {
                    _dataManager.IsBoxLocked = true;
                    RefreshLockState();
                }
            }
        }
    }

    public string? BreedingChance
    {
        get => CurrentBoxData?.BreedingChance ?? "";
        set
        {
            if (CurrentBoxData != null)
            {
                CurrentBoxData.BreedingChance = value;
                OnPropertyChanged();
                SaveCurrentBoxData();
            }
        }
    }

    // Gate status options matching main branch: empty, Gate up, Regate
    public ObservableCollection<string> GateStatusOptions { get; } = new()
    {
        "", "Gate up", "Regate"
    };

    // Breeding chance options - short codes matching main branch
    public ObservableCollection<string> BreedingChanceOptions { get; } = new()
    {
        "", "NO", "UNL", "POT", "CON", "BR", "DCM"
    };

    // Navigation state
    public bool CanNavigatePrev => IsLocked && _dataManager.CanNavigateToPreviousBox();
    public bool CanNavigateNext => IsLocked && _dataManager.CanNavigateToNextBox();
    public double PrevButtonOpacity => CanNavigatePrev ? 1.0 : 0.5;
    public double NextButtonOpacity => CanNavigateNext ? 1.0 : 0.5;

    // Action button state - shows "Clear Box" when locked with data, "Cancel" when unlocked
    public bool ShowActionButton => !IsLocked || (IsLocked && HasAnyData());
    public string ActionButtonText => IsLocked ? "Clear Box" : "Cancel";
    public string ActionButtonColor => IsLocked ? "#FFC107" : "#9E9E9E"; // Yellow for clear, Gray for cancel
    public ICommand ActionButtonCommand => IsLocked ? ClearBoxCommand : CancelEditCommand;

    // Legacy properties for compatibility
    public bool CanClearBox => IsLocked && CurrentBoxData != null && HasAnyData();
    public double ClearButtonOpacity => CanClearBox ? 1.0 : 0.5;

    // Commands
    public ICommand PrevBoxCommand { get; }
    public ICommand NextBoxCommand { get; }
    public ICommand SelectBoxCommand { get; }
    public ICommand ClearBoxCommand { get; }
    public ICommand ToggleLockCommand { get; }
    public ICommand CancelEditCommand { get; }
    public ICommand DeleteScanCommand { get; }
    public ICommand MoveScanCommand { get; }
    public ICommand AddManualScanCommand { get; }
    public ICommand ViewOlderDataCommand { get; }
    public ICommand ViewNewerDataCommand { get; }

    private bool HasAnyData()
    {
        if (CurrentBoxData == null) return false;
        return CurrentBoxData.Adults > 0 ||
               CurrentBoxData.Eggs > 0 ||
               CurrentBoxData.Chicks > 0 ||
               !string.IsNullOrEmpty(CurrentBoxData.GateStatus) ||
               !string.IsNullOrWhiteSpace(CurrentBoxData.Notes) ||
               CurrentBoxData.ScannedIds.Any();
    }

    private void OnPreviousBox()
    {
        if (!IsLocked) return;
        _dataManager.NavigateToPreviousBox();
        RefreshView();
    }

    private void OnNextBox()
    {
        if (!IsLocked) return;
        _dataManager.NavigateToNextBox();
        RefreshView();
    }

    private async void OnSelectBox()
    {
        if (!IsLocked) return;

        var boxName = await Application.Current!.MainPage!.DisplayPromptAsync(
            "Select Box",
            "Enter box name or number:",
            initialValue: CurrentBoxName);

        if (!string.IsNullOrEmpty(boxName) && _dataManager.BoxNamesAndIndexes.ContainsKey(boxName))
        {
            _dataManager.CurrentBoxName = boxName;
            _dataManager.CurrentBoxIndex = _dataManager.BoxNamesAndIndexes[boxName];
            RefreshView();
        }
        else if (!string.IsNullOrEmpty(boxName))
        {
            await Application.Current.MainPage.DisplayAlert("Invalid Box", $"Box '{boxName}' not found in current box set.", "OK");
        }
    }

    private async void OnClearBox()
    {
        if (!IsLocked || CurrentBoxData == null) return;

        var confirm = await Application.Current!.MainPage!.DisplayAlert(
            "Clear Box",
            $"Are you sure you want to clear all data for Box {CurrentBoxName}?",
            "Yes", "No");

        if (confirm)
        {
            _dataManager.ClearCurrentBox();
            RefreshView();
        }
    }

    private async void OnToggleLock()
    {
        if (!IsLocked)
        {
            // Locking - save and lock
            // Don't save when viewing historical data
            if (_dataManager.CurrentHistoricalDataIndex == 0)
            {
                // Check if we're saving empty data
                if (!HasAnyData())
                {
                    var confirm = await Application.Current!.MainPage!.DisplayAlert(
                        "Save Empty Box?",
                        $"Box {CurrentBoxName} has no data. Save as empty?",
                        "Save Empty", "Cancel");

                    if (!confirm)
                    {
                        return; // Don't lock if user cancels
                    }
                }
                SaveCurrentBoxData();
            }

            _dataManager.IsBoxLocked = true;
        }
        else
        {
            // Unlocking - enable editing
            _dataManager.IsBoxLocked = false;
        }

        RefreshLockState();
    }

    private void OnViewOlderData()
    {
        int maxHistoricalIndex = _dataManager.AllMonitorData.Count - 1;
        if (_dataManager.CurrentHistoricalDataIndex >= maxHistoricalIndex) return;

        // Find next older data with this box
        for (int i = _dataManager.CurrentHistoricalDataIndex + 1; i <= maxHistoricalIndex; i++)
        {
            int displayMonitorIndex = _dataManager.AppSettings.CurrentlyVisibleMonitor + i;
            if (_dataManager.AllMonitorData.ContainsKey(displayMonitorIndex) &&
                _dataManager.AllMonitorData[displayMonitorIndex].BoxData.ContainsKey(_dataManager.CurrentBoxName))
            {
                _dataManager.CurrentHistoricalDataIndex = i;
                RefreshView();
                RefreshHistoricalDataState();
                return;
            }
        }

        Application.Current?.MainPage?.DisplayAlert("No Data", "No older data available for this box", "OK");
    }

    private void OnViewNewerData()
    {
        if (_dataManager.CurrentHistoricalDataIndex <= 0)
        {
            Application.Current?.MainPage?.DisplayAlert("Current", "Already viewing current data", "OK");
            return;
        }

        // Find next newer data with this box (or go to current)
        for (int i = _dataManager.CurrentHistoricalDataIndex - 1; i >= 0; i--)
        {
            if (i == 0)
            {
                // Go to current data
                _dataManager.CurrentHistoricalDataIndex = 0;
                RefreshView();
                RefreshHistoricalDataState();
                return;
            }

            int displayMonitorIndex = _dataManager.AppSettings.CurrentlyVisibleMonitor + i;
            if (_dataManager.AllMonitorData.ContainsKey(displayMonitorIndex) &&
                _dataManager.AllMonitorData[displayMonitorIndex].BoxData.ContainsKey(_dataManager.CurrentBoxName))
            {
                _dataManager.CurrentHistoricalDataIndex = i;
                RefreshView();
                RefreshHistoricalDataState();
                return;
            }
        }

        // Default to current
        _dataManager.CurrentHistoricalDataIndex = 0;
        RefreshView();
        RefreshHistoricalDataState();
    }

    private void RefreshHistoricalDataState()
    {
        OnPropertyChanged(nameof(HasHistoricalData));
        OnPropertyChanged(nameof(IsViewingHistoricalData));
        OnPropertyChanged(nameof(ShowHistoricalNavigation));
        OnPropertyChanged(nameof(CanViewOlderData));
        OnPropertyChanged(nameof(CanViewNewerData));
        OnPropertyChanged(nameof(OlderButtonOpacity));
        OnPropertyChanged(nameof(NewerButtonOpacity));
        OnPropertyChanged(nameof(HistoricalDataLabel));
        OnPropertyChanged(nameof(HistoricalIndicator));
        OnPropertyChanged(nameof(TitleColor));
        OnPropertyChanged(nameof(CanEdit));
        OnPropertyChanged(nameof(CanEditScans));
    }

    private async void OnDeleteScan(ScanRecordDisplay? scanDisplay)
    {
        if (scanDisplay == null || CurrentBoxData == null) return;

        var confirm = await Application.Current!.MainPage!.DisplayAlert(
            "Delete Scan",
            $"Delete bird {scanDisplay.BirdId} from Box {CurrentBoxName}?",
            "Yes", "No");

        if (confirm)
        {
            var scanToRemove = CurrentBoxData.ScannedIds.FirstOrDefault(s =>
                s.BirdId == scanDisplay.BirdId && s.Timestamp == scanDisplay.Timestamp);

            if (scanToRemove != null)
            {
                CurrentBoxData.ScannedIds.Remove(scanToRemove);

                // Decrement adult/chick count based on penguin data
                if (_dataManager.RemotePenguinData != null &&
                    _dataManager.RemotePenguinData.TryGetValue(scanToRemove.BirdId, out var penguinData))
                {
                    if (penguinData.LastKnownLifeStage == LifeStage.Adult ||
                        penguinData.LastKnownLifeStage == LifeStage.Returnee ||
                        (penguinData.LastKnownLifeStage == LifeStage.Chick && DateTime.Today > penguinData.ChipDate.AddMonths(3)))
                    {
                        CurrentBoxData.Adults = Math.Max(0, CurrentBoxData.Adults - 1);
                    }
                    else if (penguinData.LastKnownLifeStage == LifeStage.Chick)
                    {
                        CurrentBoxData.Chicks = Math.Max(0, CurrentBoxData.Chicks - 1);
                    }
                }

                SaveCurrentBoxData();
                RefreshView();
            }
        }
    }

    private async void OnMoveScan(ScanRecordDisplay? scanDisplay)
    {
        if (scanDisplay == null || CurrentBoxData == null) return;

        var targetBoxName = await Application.Current!.MainPage!.DisplayPromptAsync(
            $"Move Bird {scanDisplay.BirdId}",
            $"Move from Box {CurrentBoxName} to:",
            placeholder: "Enter box name");

        if (string.IsNullOrEmpty(targetBoxName)) return;

        if (!_dataManager.BoxNamesAndIndexes.ContainsKey(targetBoxName))
        {
            await Application.Current.MainPage.DisplayAlert("Invalid Box", $"Box '{targetBoxName}' not found.", "OK");
            return;
        }

        if (targetBoxName == CurrentBoxName)
        {
            await Application.Current.MainPage.DisplayAlert("Same Box", "Bird is already in this box.", "OK");
            return;
        }

        var confirm = await Application.Current.MainPage.DisplayAlert(
            "Move Bird",
            $"Move bird {scanDisplay.BirdId} from Box {CurrentBoxName} to Box {targetBoxName}?",
            "Yes, Move", "Cancel");

        if (confirm)
        {
            MoveScanToBox(scanDisplay, targetBoxName);
        }
    }

    private void MoveScanToBox(ScanRecordDisplay scanDisplay, string targetBoxName)
    {
        if (CurrentBoxData == null) return;

        var scanToMove = CurrentBoxData.ScannedIds.FirstOrDefault(s =>
            s.BirdId == scanDisplay.BirdId && s.Timestamp == scanDisplay.Timestamp);

        if (scanToMove == null) return;

        int displayMonitorIndex = _dataManager.AppSettings.CurrentlyVisibleMonitor + _dataManager.CurrentHistoricalDataIndex;

        // Check if target box already has this bird
        if (_dataManager.AllMonitorData.ContainsKey(displayMonitorIndex) &&
            _dataManager.AllMonitorData[displayMonitorIndex].BoxData.ContainsKey(targetBoxName) &&
            _dataManager.AllMonitorData[displayMonitorIndex].BoxData[targetBoxName].ScannedIds.Any(s => s.BirdId == scanToMove.BirdId))
        {
            Application.Current?.MainPage?.DisplayAlert("Duplicate", $"Bird {scanToMove.BirdId} already exists in Box {targetBoxName}.", "OK");
            return;
        }

        // Remove from current box
        CurrentBoxData.ScannedIds.Remove(scanToMove);

        // Update adult/chick count in current box
        if (_dataManager.RemotePenguinData != null &&
            _dataManager.RemotePenguinData.TryGetValue(scanToMove.BirdId, out var penguinData))
        {
            if (penguinData.LastKnownLifeStage == LifeStage.Adult ||
                penguinData.LastKnownLifeStage == LifeStage.Returnee ||
                (penguinData.LastKnownLifeStage == LifeStage.Chick && DateTime.Today > penguinData.ChipDate.AddMonths(3)))
            {
                CurrentBoxData.Adults = Math.Max(0, CurrentBoxData.Adults - 1);
            }
            else if (penguinData.LastKnownLifeStage == LifeStage.Chick)
            {
                CurrentBoxData.Chicks = Math.Max(0, CurrentBoxData.Chicks - 1);
            }
        }

        // Add to target box
        if (!_dataManager.AllMonitorData.ContainsKey(displayMonitorIndex))
        {
            _dataManager.AllMonitorData[displayMonitorIndex] = new MonitorDetails
            {
                BoxData = new Dictionary<string, BoxData>()
            };
        }

        if (!_dataManager.AllMonitorData[displayMonitorIndex].BoxData.ContainsKey(targetBoxName))
        {
            _dataManager.AllMonitorData[displayMonitorIndex].BoxData[targetBoxName] = new BoxData();
        }

        var targetBoxData = _dataManager.AllMonitorData[displayMonitorIndex].BoxData[targetBoxName];
        targetBoxData.ScannedIds.Add(scanToMove);

        // Update adult/chick count in target box
        if (_dataManager.RemotePenguinData != null &&
            _dataManager.RemotePenguinData.TryGetValue(scanToMove.BirdId, out penguinData))
        {
            if (penguinData.LastKnownLifeStage == LifeStage.Adult ||
                penguinData.LastKnownLifeStage == LifeStage.Returnee ||
                (penguinData.LastKnownLifeStage == LifeStage.Chick && DateTime.Today > penguinData.ChipDate.AddMonths(3)))
            {
                targetBoxData.Adults++;
            }
            else if (penguinData.LastKnownLifeStage == LifeStage.Chick)
            {
                targetBoxData.Chicks++;
            }
        }

        SaveCurrentBoxData();
        RefreshView();

        Application.Current?.MainPage?.DisplayAlert("Moved", $"Bird {scanToMove.BirdId} moved to Box {targetBoxName}.", "OK");
    }

    private void OnAddManualScan()
    {
        if (string.IsNullOrWhiteSpace(ManualScanInput)) return;

        var cleanInput = new string(ManualScanInput.Where(char.IsLetterOrDigit).ToArray()).ToUpper();

        if (cleanInput.Length < 4)
        {
            Application.Current?.MainPage?.DisplayAlert("Invalid", "Please enter at least 4 characters.", "OK");
            return;
        }

        // Ensure we have box data
        if (CurrentBoxData == null)
        {
            CurrentBoxData = new BoxData();
        }

        // Check for duplicates
        if (CurrentBoxData.ScannedIds.Any(s => s.BirdId == cleanInput))
        {
            Application.Current?.MainPage?.DisplayAlert("Duplicate", $"Bird {cleanInput} is already in this box.", "OK");
            return;
        }

        var scanRecord = new ScanRecord
        {
            BirdId = cleanInput,
            Timestamp = DateTime.UtcNow,
            Latitude = 0,
            Longitude = 0,
            Accuracy = -1
        };

        CurrentBoxData.ScannedIds.Add(scanRecord);

        // Update adult/chick count based on penguin data
        if (_dataManager.RemotePenguinData != null &&
            _dataManager.RemotePenguinData.TryGetValue(cleanInput, out var penguinData))
        {
            if (penguinData.LastKnownLifeStage == LifeStage.Adult ||
                penguinData.LastKnownLifeStage == LifeStage.Returnee ||
                (penguinData.LastKnownLifeStage == LifeStage.Chick && DateTime.Today > penguinData.ChipDate.AddMonths(3)))
            {
                CurrentBoxData.Adults++;
            }
            else if (penguinData.LastKnownLifeStage == LifeStage.Chick)
            {
                CurrentBoxData.Chicks++;
            }
        }

        ManualScanInput = "";
        SaveCurrentBoxData();
        RefreshView();
    }

    private void OnCancelEdit()
    {
        // Cancel editing - discard changes and re-lock
        _dataManager.IsBoxLocked = true;
        RefreshView(); // Reload data from storage, discarding any unsaved changes
        RefreshLockState();
    }

    private void SaveCurrentBoxData()
    {
        if (CurrentBoxData != null)
        {
            CurrentBoxData.whenDataCollectedUtc = DateTime.UtcNow;
            _dataManager.SetCurrentBoxData(CurrentBoxData);
        }
    }

    private void RefreshLockState()
    {
        OnPropertyChanged(nameof(IsLocked));
        OnPropertyChanged(nameof(LockIcon));
        OnPropertyChanged(nameof(LockColor));
        OnPropertyChanged(nameof(BoxStatusText));
        OnPropertyChanged(nameof(CanEdit));
        OnPropertyChanged(nameof(CanEditScans));
        OnPropertyChanged(nameof(CanNavigatePrev));
        OnPropertyChanged(nameof(CanNavigateNext));
        OnPropertyChanged(nameof(PrevButtonOpacity));
        OnPropertyChanged(nameof(NextButtonOpacity));
        OnPropertyChanged(nameof(CanClearBox));
        OnPropertyChanged(nameof(ClearButtonOpacity));
        OnPropertyChanged(nameof(ShowActionButton));
        OnPropertyChanged(nameof(ActionButtonText));
        OnPropertyChanged(nameof(ActionButtonColor));
        OnPropertyChanged(nameof(ActionButtonCommand));
    }

    private void RefreshView()
    {
        CurrentBoxData = _dataManager.GetCurrentBoxData() ?? new BoxData
        {
            ScannedIds = new List<ScanRecord>(),
            Adults = 0,
            Eggs = 0,
            Chicks = 0,
            Notes = "",
            GateStatus = "",
            BreedingChance = "",
            whenDataCollectedUtc = DateTime.UtcNow
        };

        // If no breeding chance set, try to get from historical data
        if (string.IsNullOrEmpty(CurrentBoxData.BreedingChance))
        {
            var olderBoxDatas = DataStorageService.getOlderBoxDatas(
                _dataManager.AllMonitorData,
                _dataManager.AppSettings.CurrentlyVisibleMonitor + _dataManager.CurrentHistoricalDataIndex,
                _dataManager.CurrentBoxName);

            foreach (var oldData in olderBoxDatas)
            {
                if (!string.IsNullOrEmpty(oldData.BreedingChance))
                {
                    CurrentBoxData.BreedingChance = oldData.BreedingChance;
                    break;
                }
            }
        }

        OnPropertyChanged(nameof(CurrentBoxName));
        OnPropertyChanged(nameof(BoxTitle));
        OnPropertyChanged(nameof(TitleColor));
        OnPropertyChanged(nameof(StickyNotes));
        OnPropertyChanged(nameof(HasStickyNotes));

        RefreshLockState();
        RefreshHistoricalDataState();
    }

    private void OnDataManagerChanged(object? sender, EventArgs e)
    {
        RefreshView();
    }

    private void OnBoxChanged(object? sender, string boxName)
    {
        RefreshView();
    }

    protected void OnPropertyChanged([CallerMemberName] string? propertyName = null)
    {
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }
}
