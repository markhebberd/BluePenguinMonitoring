using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows.Input;
using PenguinMonitor.Models;

namespace PenguinMonitor.ViewModels;

public class BoxDataViewModel : INotifyPropertyChanged
{
    private BoxData _boxData;
    private string _currentBoxName = "1";
    private bool _isLocked = false;
    private Dictionary<string, int> _boxNamesAndIndexes;

    public event PropertyChangedEventHandler PropertyChanged;

    public BoxData BoxData
    {
        get => _boxData;
        set
        {
            _boxData = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(ScannedBirds));
            OnPropertyChanged(nameof(HasNoScans));
        }
    }

    public string CurrentBoxName
    {
        get => _currentBoxName;
        set
        {
            _currentBoxName = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(BoxTitle));
        }
    }

    public string BoxTitle => $"Box {CurrentBoxName}";

    public string LockIcon => _isLocked ? "lock_closed" : "lock_open";

    public bool HasNoScans => !BoxData.ScannedIds.Any();

    public string NoScansMessage => "No birds scanned yet. Enable Bluetooth in Settings to scan.";

    public ObservableCollection<ScanRecord> ScannedBirds { get; set; }

    public ObservableCollection<string> GateStatusOptions { get; } = new()
    {
        "Open", "Closed", "Half", "None"
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

    public ICommand PrevBoxCommand { get; }
    public ICommand NextBoxCommand { get; }
    public ICommand SelectBoxCommand { get; }
    public ICommand ToggleLockCommand { get; }
    public ICommand ClearBoxCommand { get; }
    public ICommand SaveBoxCommand { get; }

    public BoxDataViewModel()
    {
        _boxData = new BoxData();
        ScannedBirds = new ObservableCollection<ScanRecord>();

        // Initialize box navigation (simple 1-150 for demo)
        _boxNamesAndIndexes = new Dictionary<string, int>();
        for (int i = 1; i <= 150; i++)
        {
            _boxNamesAndIndexes[i.ToString()] = i;
        }

        PrevBoxCommand = new Command(NavigatePreviousBox);
        NextBoxCommand = new Command(NavigateNextBox);
        SelectBoxCommand = new Command(async () => await SelectBox());
        ToggleLockCommand = new Command(ToggleLock);
        ClearBoxCommand = new Command(ClearBox);
        SaveBoxCommand = new Command(SaveBox);

        LoadCurrentBox();
    }

    public void LoadCurrentBox()
    {
        // In full implementation, load from DataStorageService
        // For now, just reset to empty box
        BoxData = new BoxData
        {
            Adults = 0,
            Eggs = 0,
            Chicks = 0,
            GateStatus = "Open",
            BreedingChance = "UNL - Unlikely to breed",
            Notes = ""
        };

        ScannedBirds.Clear();
        foreach (var scan in BoxData.ScannedIds)
        {
            ScannedBirds.Add(scan);
        }

        OnPropertyChanged(nameof(CurrentBoxName));
        OnPropertyChanged(nameof(BoxTitle));
    }

    private void NavigatePreviousBox()
    {
        var currentIndex = _boxNamesAndIndexes[CurrentBoxName];
        if (currentIndex > 1)
        {
            var prevBox = _boxNamesAndIndexes.FirstOrDefault(x => x.Value == currentIndex - 1).Key;
            if (prevBox != null)
            {
                CurrentBoxName = prevBox;
                LoadCurrentBox();
            }
        }
    }

    private void NavigateNextBox()
    {
        var currentIndex = _boxNamesAndIndexes[CurrentBoxName];
        if (currentIndex < _boxNamesAndIndexes.Count)
        {
            var nextBox = _boxNamesAndIndexes.FirstOrDefault(x => x.Value == currentIndex + 1).Key;
            if (nextBox != null)
            {
                CurrentBoxName = nextBox;
                LoadCurrentBox();
            }
        }
    }

    private async Task SelectBox()
    {
        var boxName = await Application.Current.MainPage.DisplayPromptAsync(
            "Select Box",
            "Enter box name or number:",
            initialValue: CurrentBoxName);

        if (!string.IsNullOrEmpty(boxName) && _boxNamesAndIndexes.ContainsKey(boxName))
        {
            CurrentBoxName = boxName;
            LoadCurrentBox();
        }
    }

    private void ToggleLock()
    {
        _isLocked = !_isLocked;
        if (_isLocked)
        {
            SaveBox();
        }
        OnPropertyChanged(nameof(LockIcon));
    }

    private void ClearBox()
    {
        BoxData = new BoxData
        {
            Adults = 0,
            Eggs = 0,
            Chicks = 0,
            GateStatus = "Open",
            BreedingChance = "UNL - Unlikely to breed",
            Notes = ""
        };
        ScannedBirds.Clear();
    }

    private void SaveBox()
    {
        // In full implementation, save to DataStorageService
        Application.Current.MainPage.DisplayAlert("Saved", $"Box {CurrentBoxName} data saved", "OK");
    }

    protected void OnPropertyChanged([CallerMemberName] string propertyName = null)
    {
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }
}
