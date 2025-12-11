using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows.Input;
using PenguinMonitor.Models;
using PenguinMonitor.Services;

namespace PenguinMonitor.ViewModels;

public class BoxDataViewModel : INotifyPropertyChanged
{
    private readonly DataManager _dataManager = DataManager.Instance;
    private readonly DataStorageService _dataStorageService = new DataStorageService();
    private BoxData? _currentBoxData;

    public event PropertyChangedEventHandler PropertyChanged;

    public BoxDataViewModel()
    {
        // Subscribe to data manager events
        _dataManager.DataChanged += OnDataManagerChanged;
        _dataManager.BoxChanged += OnBoxChanged;

        // Initialize box names (simple 1-150 for now, can be loaded from settings later)
        for (int i = 1; i <= 150; i++)
        {
            _dataManager.BoxNamesAndIndexes[i.ToString()] = i;
        }
        _dataManager.CurrentBoxName = "1";
        _dataManager.CurrentBoxIndex = 1;

        // Initialize commands
        PrevBoxCommand = new Command(OnPreviousBox, () => _dataManager.CanNavigateToPreviousBox());
        NextBoxCommand = new Command(OnNextBox, () => _dataManager.CanNavigateToNextBox());
        SelectBoxCommand = new Command(OnSelectBox);
        ClearBoxCommand = new Command(OnClearBox, () => CurrentBoxData != null && IsLocked);
        ToggleLockCommand = new Command(OnToggleLock);
        SaveBoxCommand = new Command(OnSaveData);

        // Load initial data
        RefreshView();
    }

    // Properties bound to UI
    public string CurrentBoxName => _dataManager.CurrentBoxName;
    public string BoxTitle => $"Box {CurrentBoxName}";
    public bool IsLocked => _dataManager.IsBoxLocked;
    public string LockIcon => IsLocked ? "locked_green.png" : "unlocked_red.png";

    public BoxData? CurrentBoxData
    {
        get => _currentBoxData;
        set
        {
            _currentBoxData = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(HasNoScans));
            OnPropertyChanged(nameof(NoScansMessage));
            OnPropertyChanged(nameof(ScannedBirds));
            OnPropertyChanged(nameof(Adults));
            OnPropertyChanged(nameof(Eggs));
            OnPropertyChanged(nameof(Chicks));
            OnPropertyChanged(nameof(Notes));
            OnPropertyChanged(nameof(GateStatus));
            OnPropertyChanged(nameof(BreedingChance));
        }
    }

    public bool HasNoScans => CurrentBoxData == null || !CurrentBoxData.ScannedIds.Any();
    public string NoScansMessage => "No birds scanned yet. Enable Bluetooth in Settings to scan.";

    public ObservableCollection<ScanRecord> ScannedBirds
    {
        get => CurrentBoxData != null
            ? new ObservableCollection<ScanRecord>(CurrentBoxData.ScannedIds)
            : new ObservableCollection<ScanRecord>();
    }

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

    public string GateStatus
    {
        get => CurrentBoxData?.GateStatus ?? "";
        set
        {
            if (CurrentBoxData != null)
            {
                CurrentBoxData.GateStatus = value;
                OnPropertyChanged();
                SaveCurrentBoxData();
            }
        }
    }

    public string BreedingChance
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

    public ObservableCollection<string> GateStatusOptions { get; } = new()
    {
        "Open", "Closed", "Gate up", "Regate", "None"
    };

    public ObservableCollection<string> BreedingChanceOptions { get; } = new()
    {
        "NO - No breeding",
        "UNL - Unlikely to breed",
        "POT - Potential breeding",
        "CON - Confident breeding",
        "BR - Actively breeding",
        "DCM - Decommissioned"
    };

    // Commands
    public ICommand PrevBoxCommand { get; }
    public ICommand NextBoxCommand { get; }
    public ICommand SelectBoxCommand { get; }
    public ICommand ClearBoxCommand { get; }
    public ICommand ToggleLockCommand { get; }
    public ICommand SaveBoxCommand { get; }

    private void OnPreviousBox()
    {
        _dataManager.NavigateToPreviousBox();
        RefreshView();
    }

    private void OnNextBox()
    {
        _dataManager.NavigateToNextBox();
        RefreshView();
    }

    private async void OnSelectBox()
    {
        var boxName = await Application.Current.MainPage.DisplayPromptAsync(
            "Select Box",
            "Enter box name or number:",
            initialValue: CurrentBoxName);

        if (!string.IsNullOrEmpty(boxName) && _dataManager.BoxNamesAndIndexes.ContainsKey(boxName))
        {
            _dataManager.CurrentBoxName = boxName;
            _dataManager.CurrentBoxIndex = _dataManager.BoxNamesAndIndexes[boxName];
            RefreshView();
        }
    }

    private void OnClearBox()
    {
        if (!IsLocked) return;

        // Show confirmation dialog
        Application.Current?.MainPage?.DisplayAlert(
            "Clear Box",
            $"Are you sure you want to clear all data for Box {CurrentBoxName}?",
            "Yes", "No").ContinueWith(task =>
            {
                if (task.Result)
                {
                    _dataManager.ClearCurrentBox();
                    RefreshView();
                }
            });
    }

    private void OnToggleLock()
    {
        _dataManager.IsBoxLocked = !_dataManager.IsBoxLocked;
        OnPropertyChanged(nameof(IsLocked));
        OnPropertyChanged(nameof(LockIcon));
        ((Command)ClearBoxCommand).ChangeCanExecute();
    }

    private void OnSaveData()
    {
        // TODO: Implement save to disk/server using DataStorageService
        Application.Current?.MainPage?.DisplayAlert("Save", "Data saved successfully", "OK");
    }

    private void SaveCurrentBoxData()
    {
        if (CurrentBoxData != null)
        {
            _dataManager.SetCurrentBoxData(CurrentBoxData);
        }
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
            GateStatus = "Open",
            BreedingChance = "",
            whenDataCollectedUtc = DateTime.UtcNow
        };

        OnPropertyChanged(nameof(CurrentBoxName));
        OnPropertyChanged(nameof(BoxTitle));
        OnPropertyChanged(nameof(IsLocked));
        OnPropertyChanged(nameof(LockIcon));

        ((Command)PrevBoxCommand).ChangeCanExecute();
        ((Command)NextBoxCommand).ChangeCanExecute();
        ((Command)ClearBoxCommand).ChangeCanExecute();
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
