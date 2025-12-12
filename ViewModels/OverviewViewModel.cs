using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows.Input;
using PenguinMonitor.Models;
using PenguinMonitor.Services;
using Newtonsoft.Json;
using SmtpAuthenticator;

namespace PenguinMonitor.ViewModels;

public class OverviewViewModel : INotifyPropertyChanged
{
    private readonly DataManager _dataManager = DataManager.Instance;
    private readonly DataStorageService _dataStorageService = new DataStorageService();
    private string _summaryText = "";
    private string _dataSourceText = "";
    private string _dataTimestampText = "";
    private string _filterTextRepresentation = "";
    private bool _showFiltersCard = false;
    private bool _showFiltersVisible = false;
    private bool _hideFiltersVisible = false;
    private bool _isDownloadingBirdStats = false;
    private string _birdStatsButtonText = "Bird Stats";
    private Color _birdStatsButtonColor = Color.FromArgb("#2196F3");

    public event PropertyChangedEventHandler? PropertyChanged;

    public ObservableCollection<BoxOverviewItem> FilteredBoxes { get; set; } = new();

    // Commands
    public ICommand ToggleFiltersCommand { get; }
    public ICommand ToggleShowFiltersCommand { get; }
    public ICommand ToggleHideFiltersCommand { get; }
    public ICommand PreviousMonitorCommand { get; }
    public ICommand NextMonitorCommand { get; }
    public ICommand LatestMonitorCommand { get; }
    public ICommand ClearAllCommand { get; }
    public ICommand BirdStatsCommand { get; }
    public ICommand SaveLoadCommand { get; }

    public OverviewViewModel()
    {
        ToggleFiltersCommand = new Command(() =>
        {
            ShowFiltersCard = !ShowFiltersCard;
            OnPropertyChanged(nameof(FiltersExpandButtonText));
        });

        ToggleShowFiltersCommand = new Command(() =>
        {
            ShowFiltersVisible = !ShowFiltersVisible;
            HideFiltersVisible = false;
            OnPropertyChanged(nameof(ShowFiltersButtonText));
            OnPropertyChanged(nameof(HideFiltersButtonText));
        });

        ToggleHideFiltersCommand = new Command(() =>
        {
            HideFiltersVisible = !HideFiltersVisible;
            ShowFiltersVisible = false;
            OnPropertyChanged(nameof(ShowFiltersButtonText));
            OnPropertyChanged(nameof(HideFiltersButtonText));
        });

        PreviousMonitorCommand = new Command(() =>
        {
            if (_dataManager.AppSettings.CurrentlyVisibleMonitor < _dataManager.AllMonitorData.Count - 1)
            {
                _dataManager.AppSettings.CurrentlyVisibleMonitor++;
                _dataManager.AppSettings.ActiveSessionTimeStampActive = true;
                if (_dataManager.AllMonitorData.ContainsKey(_dataManager.AppSettings.CurrentlyVisibleMonitor))
                {
                    _dataManager.AppSettings.ActiveSessionLocalTimeStamp = GetLocalDateTime(_dataManager.AllMonitorData[_dataManager.AppSettings.CurrentlyVisibleMonitor]);
                }
                RefreshData();
            }
        });

        NextMonitorCommand = new Command(() =>
        {
            if (_dataManager.AppSettings.CurrentlyVisibleMonitor > 0)
            {
                _dataManager.AppSettings.CurrentlyVisibleMonitor--;
                if (_dataManager.AppSettings.CurrentlyVisibleMonitor == 0)
                {
                    _dataManager.AppSettings.ActiveSessionTimeStampActive = false;
                }
                else if (_dataManager.AllMonitorData.ContainsKey(_dataManager.AppSettings.CurrentlyVisibleMonitor))
                {
                    _dataManager.AppSettings.ActiveSessionLocalTimeStamp = GetLocalDateTime(_dataManager.AllMonitorData[_dataManager.AppSettings.CurrentlyVisibleMonitor]);
                }
                RefreshData();
            }
        });

        LatestMonitorCommand = new Command(() =>
        {
            _dataManager.AppSettings.CurrentlyVisibleMonitor = 0;
            _dataManager.AppSettings.ActiveSessionTimeStampActive = false;
            RefreshData();
        });

        ClearAllCommand = new Command(async () => await OnClearAllAsync());
        BirdStatsCommand = new Command(async () => await OnBirdStatsAsync());
        SaveLoadCommand = new Command(async () => await OnSaveLoadAsync());

        // Set default to show all boxes
        if (!_dataManager.AppSettings.ShowAllBoxesInMultiBoxView &&
            !_dataManager.AppSettings.ShowBoxesWithDataInMultiBoxView)
        {
            _dataManager.AppSettings.ShowAllBoxesInMultiBoxView = true;
        }

        RefreshData();
    }

    private DateTime GetLocalDateTime(MonitorDetails monitor)
    {
        foreach (BoxData box in monitor.BoxData.Values)
        {
            foreach (ScanRecord sc in box.ScannedIds)
            {
                return sc.Timestamp.ToLocalTime();
            }
            if (box.whenDataCollectedUtc.Year > 2015)
            {
                return box.whenDataCollectedUtc.ToLocalTime();
            }
        }
        return DateTime.Now;
    }

    #region Properties

    public string SummaryText
    {
        get => _summaryText;
        set { _summaryText = value; OnPropertyChanged(); }
    }

    public string DataSourceText
    {
        get => _dataSourceText;
        set { _dataSourceText = value; OnPropertyChanged(); }
    }

    public string DataTimestampText
    {
        get => _dataTimestampText;
        set { _dataTimestampText = value; OnPropertyChanged(); }
    }

    public string FilterTextRepresentation
    {
        get => _filterTextRepresentation;
        set { _filterTextRepresentation = value; OnPropertyChanged(); }
    }

    public bool ShowFiltersCard
    {
        get => _showFiltersCard;
        set { _showFiltersCard = value; OnPropertyChanged(); }
    }

    public bool ShowFiltersVisible
    {
        get => _showFiltersVisible;
        set { _showFiltersVisible = value; OnPropertyChanged(); }
    }

    public bool HideFiltersVisible
    {
        get => _hideFiltersVisible;
        set { _hideFiltersVisible = value; OnPropertyChanged(); }
    }

    public string FiltersExpandButtonText => ShowFiltersCard ? "[-]" : "[+]";
    public string ShowFiltersButtonText => ShowFiltersVisible ? "Hide show filters" : "Show filters";
    public string HideFiltersButtonText => HideFiltersVisible ? "Hide hide filters" : "Hide filters";

    // Header styling based on active session
    public int HeaderBorderThickness => _dataManager.AppSettings.ActiveSessionTimeStampActive ? 6 : 4;
    public Color HeaderBorderColor => _dataManager.AppSettings.ActiveSessionTimeStampActive ? Colors.Red : Color.FromArgb("#2196F3");

    // Monitor navigation
    public bool CanGoToPreviousMonitor => _dataManager.AllMonitorData.Count > _dataManager.AppSettings.CurrentlyVisibleMonitor + 1;
    public bool CanGoToNextMonitor => _dataManager.AppSettings.CurrentlyVisibleMonitor > 0;

    // Action button properties
    public string ClearAllButtonText => "Clear All";
    public string BirdStatsButtonText
    {
        get => _birdStatsButtonText;
        set { _birdStatsButtonText = value; OnPropertyChanged(); }
    }
    public Color BirdStatsButtonColor
    {
        get => _birdStatsButtonColor;
        set { _birdStatsButtonColor = value; OnPropertyChanged(); }
    }
    public bool CanDownloadBirdStats => !_isDownloadingBirdStats;

    #region Show Filter Properties
    public bool ShowAllBoxes
    {
        get => _dataManager.AppSettings.ShowAllBoxesInMultiBoxView;
        set
        {
            _dataManager.AppSettings.ShowAllBoxesInMultiBoxView = value;
            if (value)
            {
                // Clear other show filters when "All" is selected
                _dataManager.AppSettings.ShowBoxesWithDataInMultiBoxView = false;
                _dataManager.AppSettings.ShowNoBoxesInMultiBoxView = false;
                _dataManager.AppSettings.ShowUnlikleyBoxesInMultiBoxView = false;
                _dataManager.AppSettings.ShowPotentialBoxesInMultiBoxView = false;
                _dataManager.AppSettings.ShowConfidentBoxesInMultiBoxView = false;
                _dataManager.AppSettings.ShowBreedingBoxesInMultiBoxView = false;
                _dataManager.AppSettings.ShowDCMBoxesInMultiboxView = false;
                _dataManager.AppSettings.ShowBoxesWithNotesInMultiboxView = false;
                _dataManager.AppSettings.ShowInterestingBoxesInMultiBoxView = false;
                _dataManager.AppSettings.ShowSingleEggBoxesInMultiboxView = false;
                _dataManager.AppSettings.ShowDoubleEggBoxesInMultiboxView = false;
                // Notify all show filter properties
                OnPropertyChanged(nameof(ShowBoxesWithData));
                OnPropertyChanged(nameof(ShowNoBoxes));
                OnPropertyChanged(nameof(ShowUnlikelyBoxes));
                OnPropertyChanged(nameof(ShowPotentialBoxes));
                OnPropertyChanged(nameof(ShowConfidentBoxes));
                OnPropertyChanged(nameof(ShowBreedingBoxes));
                OnPropertyChanged(nameof(ShowDCMBoxes));
                OnPropertyChanged(nameof(ShowBoxesWithNotes));
                OnPropertyChanged(nameof(ShowInterestingBoxes));
                OnPropertyChanged(nameof(ShowSingleEggBoxes));
                OnPropertyChanged(nameof(ShowDoubleEggBoxes));
            }
            OnPropertyChanged();
            RefreshData();
        }
    }

    public bool ShowBoxesWithData
    {
        get => _dataManager.AppSettings.ShowBoxesWithDataInMultiBoxView;
        set
        {
            _dataManager.AppSettings.ShowBoxesWithDataInMultiBoxView = value;
            if (value) _dataManager.AppSettings.HideBoxesWithDataInMultiBoxView = false;
            OnPropertyChanged();
            OnPropertyChanged(nameof(HideBoxesWithData));
            RefreshData();
        }
    }

    public bool ShowNoBoxes
    {
        get => _dataManager.AppSettings.ShowNoBoxesInMultiBoxView;
        set
        {
            _dataManager.AppSettings.ShowNoBoxesInMultiBoxView = value;
            if (value) _dataManager.AppSettings.ShowAllBoxesInMultiBoxView = false;
            OnPropertyChanged();
            OnPropertyChanged(nameof(ShowAllBoxes));
            RefreshData();
        }
    }

    public bool ShowUnlikelyBoxes
    {
        get => _dataManager.AppSettings.ShowUnlikleyBoxesInMultiBoxView;
        set
        {
            _dataManager.AppSettings.ShowUnlikleyBoxesInMultiBoxView = value;
            if (value) _dataManager.AppSettings.ShowAllBoxesInMultiBoxView = false;
            OnPropertyChanged();
            OnPropertyChanged(nameof(ShowAllBoxes));
            RefreshData();
        }
    }

    public bool ShowPotentialBoxes
    {
        get => _dataManager.AppSettings.ShowPotentialBoxesInMultiBoxView;
        set
        {
            _dataManager.AppSettings.ShowPotentialBoxesInMultiBoxView = value;
            if (value) _dataManager.AppSettings.ShowAllBoxesInMultiBoxView = false;
            OnPropertyChanged();
            OnPropertyChanged(nameof(ShowAllBoxes));
            RefreshData();
        }
    }

    public bool ShowConfidentBoxes
    {
        get => _dataManager.AppSettings.ShowConfidentBoxesInMultiBoxView;
        set
        {
            _dataManager.AppSettings.ShowConfidentBoxesInMultiBoxView = value;
            if (value) _dataManager.AppSettings.ShowAllBoxesInMultiBoxView = false;
            OnPropertyChanged();
            OnPropertyChanged(nameof(ShowAllBoxes));
            RefreshData();
        }
    }

    public bool ShowBreedingBoxes
    {
        get => _dataManager.AppSettings.ShowBreedingBoxesInMultiBoxView;
        set
        {
            _dataManager.AppSettings.ShowBreedingBoxesInMultiBoxView = value;
            if (value) _dataManager.AppSettings.ShowAllBoxesInMultiBoxView = false;
            OnPropertyChanged();
            OnPropertyChanged(nameof(ShowAllBoxes));
            RefreshData();
        }
    }

    public bool ShowDCMBoxes
    {
        get => _dataManager.AppSettings.ShowDCMBoxesInMultiboxView;
        set
        {
            _dataManager.AppSettings.ShowDCMBoxesInMultiboxView = value;
            if (value) _dataManager.AppSettings.ShowAllBoxesInMultiBoxView = false;
            OnPropertyChanged();
            OnPropertyChanged(nameof(ShowAllBoxes));
            RefreshData();
        }
    }

    public bool ShowBoxesWithNotes
    {
        get => _dataManager.AppSettings.ShowBoxesWithNotesInMultiboxView;
        set
        {
            _dataManager.AppSettings.ShowBoxesWithNotesInMultiboxView = value;
            if (value) _dataManager.AppSettings.ShowAllBoxesInMultiBoxView = false;
            OnPropertyChanged();
            OnPropertyChanged(nameof(ShowAllBoxes));
            RefreshData();
        }
    }

    public bool ShowInterestingBoxes
    {
        get => _dataManager.AppSettings.ShowInterestingBoxesInMultiBoxView;
        set
        {
            _dataManager.AppSettings.ShowInterestingBoxesInMultiBoxView = value;
            if (value) _dataManager.AppSettings.ShowAllBoxesInMultiBoxView = false;
            OnPropertyChanged();
            OnPropertyChanged(nameof(ShowAllBoxes));
            RefreshData();
        }
    }

    public bool ShowSingleEggBoxes
    {
        get => _dataManager.AppSettings.ShowSingleEggBoxesInMultiboxView;
        set
        {
            _dataManager.AppSettings.ShowSingleEggBoxesInMultiboxView = value;
            if (value) _dataManager.AppSettings.ShowAllBoxesInMultiBoxView = false;
            OnPropertyChanged();
            OnPropertyChanged(nameof(ShowAllBoxes));
            RefreshData();
        }
    }

    public bool ShowDoubleEggBoxes
    {
        get => _dataManager.AppSettings.ShowDoubleEggBoxesInMultiboxView;
        set
        {
            _dataManager.AppSettings.ShowDoubleEggBoxesInMultiboxView = value;
            if (value) _dataManager.AppSettings.ShowAllBoxesInMultiBoxView = false;
            OnPropertyChanged();
            OnPropertyChanged(nameof(ShowAllBoxes));
            RefreshData();
        }
    }
    #endregion

    #region Hide Filter Properties
    public bool HideBoxesWithData
    {
        get => _dataManager.AppSettings.HideBoxesWithDataInMultiBoxView;
        set
        {
            _dataManager.AppSettings.HideBoxesWithDataInMultiBoxView = value;
            if (value) _dataManager.AppSettings.ShowBoxesWithDataInMultiBoxView = false;
            OnPropertyChanged();
            OnPropertyChanged(nameof(ShowBoxesWithData));
            RefreshData();
        }
    }

    public bool HideNoBoxes
    {
        get => _dataManager.AppSettings.HideNoBoxesInMultiBoxView;
        set { _dataManager.AppSettings.HideNoBoxesInMultiBoxView = value; OnPropertyChanged(); RefreshData(); }
    }

    public bool HideUnlikelyBoxes
    {
        get => _dataManager.AppSettings.HideUnlikelyBoxesInMultiBoxView;
        set { _dataManager.AppSettings.HideUnlikelyBoxesInMultiBoxView = value; OnPropertyChanged(); RefreshData(); }
    }

    public bool HidePotentialBoxes
    {
        get => _dataManager.AppSettings.HidePotentialBoxesInMultiBoxView;
        set { _dataManager.AppSettings.HidePotentialBoxesInMultiBoxView = value; OnPropertyChanged(); RefreshData(); }
    }

    public bool HideConfidentBoxes
    {
        get => _dataManager.AppSettings.HideConfidentBoxesInMultiBoxView;
        set { _dataManager.AppSettings.HideConfidentBoxesInMultiBoxView = value; OnPropertyChanged(); RefreshData(); }
    }

    public bool HideBreedingBoxes
    {
        get => _dataManager.AppSettings.HideBreedingBoxesInMultiBoxView;
        set { _dataManager.AppSettings.HideBreedingBoxesInMultiBoxView = value; OnPropertyChanged(); RefreshData(); }
    }

    public bool HideDCMBoxes
    {
        get => _dataManager.AppSettings.HideDCMInMultiBoxView;
        set { _dataManager.AppSettings.HideDCMInMultiBoxView = value; OnPropertyChanged(); RefreshData(); }
    }

    public bool HideBoxesWithNotes
    {
        get => _dataManager.AppSettings.HideBoxesWithNotesInMultiboxView;
        set { _dataManager.AppSettings.HideBoxesWithNotesInMultiboxView = value; OnPropertyChanged(); RefreshData(); }
    }

    public bool HideInterestingBoxes
    {
        get => _dataManager.AppSettings.HideInterestingBoxesInMultiBoxView;
        set { _dataManager.AppSettings.HideInterestingBoxesInMultiBoxView = value; OnPropertyChanged(); RefreshData(); }
    }

    public bool HideSingleEggBoxes
    {
        get => _dataManager.AppSettings.HideSingleEggBoxesInMultiboxView;
        set { _dataManager.AppSettings.HideSingleEggBoxesInMultiboxView = value; OnPropertyChanged(); RefreshData(); }
    }

    public bool HideDoubleEggBoxes
    {
        get => _dataManager.AppSettings.HideDoubleEggBoxesInMultiboxView;
        set { _dataManager.AppSettings.HideDoubleEggBoxesInMultiboxView = value; OnPropertyChanged(); RefreshData(); }
    }

    public bool HideBeforeCurrent
    {
        get => _dataManager.AppSettings.HideBeforeCurrentInMultiBoxView;
        set { _dataManager.AppSettings.HideBeforeCurrentInMultiBoxView = value; OnPropertyChanged(); RefreshData(); }
    }
    #endregion

    #endregion

    public void RefreshData()
    {
        int currentlyVisibleMonitor = _dataManager.AppSettings.CurrentlyVisibleMonitor;

        // Update data source text
        if (currentlyVisibleMonitor == 0)
        {
            DataSourceText = "Data is local only";
        }
        else if (_dataManager.AllMonitorData.ContainsKey(currentlyVisibleMonitor))
        {
            DataSourceText = _dataManager.AllMonitorData[currentlyVisibleMonitor].filename?.Replace("PenguinMonitor", "").Trim() ?? "";
        }
        else
        {
            DataSourceText = "";
        }

        // Update timestamp text
        DataTimestampText = GetTimestampText(currentlyVisibleMonitor);

        // Update navigation button states
        OnPropertyChanged(nameof(CanGoToPreviousMonitor));
        OnPropertyChanged(nameof(CanGoToNextMonitor));
        OnPropertyChanged(nameof(HeaderBorderThickness));
        OnPropertyChanged(nameof(HeaderBorderColor));

        // Update filter text (always, even if no data)
        UpdateFilterTextRepresentation();

        if (!_dataManager.AllMonitorData.ContainsKey(currentlyVisibleMonitor))
        {
            SummaryText = "No data available. Load data from file or server.";
            FilteredBoxes = new ObservableCollection<BoxOverviewItem>();
            OnPropertyChanged(nameof(FilteredBoxes));
            return;
        }

        var currentMonitor = _dataManager.AllMonitorData[currentlyVisibleMonitor];
        var boxData = currentMonitor.BoxData;

        // Calculate summary
        UpdateSummary(boxData, currentlyVisibleMonitor);

        // Build filtered box grid - collect all items first, then update UI once
        var settings = _dataManager.AppSettings;
        var newBoxItems = new List<BoxOverviewItem>();

        foreach (var boxName in _dataManager.BoxNamesAndIndexes.Keys.OrderBy(k => int.TryParse(k, out int n) ? n : 999))
        {
            var olderBoxDatas = DataStorageService.getOlderBoxDatas(_dataManager.AllMonitorData, currentlyVisibleMonitor, boxName);
            string nrfPercentageString = olderBoxDatas.Count > 0 && olderBoxDatas.First().Eggs > 0
                ? olderBoxDatas.Count(x => x.Adults == 0 && x.Eggs > 0) + "/" + olderBoxDatas.Count(x => x.Eggs > 0)
                : "0";

            BoxData mostRecentBoxData = new BoxData();
            if (olderBoxDatas.Count > 0)
                mostRecentBoxData = olderBoxDatas.First();

            bool currentBoxDataFound = boxData.TryGetValue(boxName, out BoxData? currentBoxData);
            if (currentBoxDataFound && currentBoxData != null)
                mostRecentBoxData = currentBoxData;

            string stickyNotes = DataStorageService.getStickyNotes(olderBoxDatas);

            // Determine if box should be shown
            bool showBox = settings.ShowAllBoxesInMultiBoxView
                || (settings.ShowBoxesWithDataInMultiBoxView && boxData.ContainsKey(boxName))
                || (settings.ShowBreedingBoxesInMultiBoxView && mostRecentBoxData.BreedingChance == "BR")
                || (settings.ShowConfidentBoxesInMultiBoxView && mostRecentBoxData.BreedingChance == "CON")
                || (settings.ShowPotentialBoxesInMultiBoxView && mostRecentBoxData.BreedingChance == "POT")
                || (settings.ShowUnlikleyBoxesInMultiBoxView && mostRecentBoxData.BreedingChance == "UNL")
                || (settings.ShowNoBoxesInMultiBoxView && mostRecentBoxData.BreedingChance == "NO")
                || (settings.ShowBoxesWithNotesInMultiboxView && !string.IsNullOrWhiteSpace(mostRecentBoxData.Notes))
                || (settings.ShowInterestingBoxesInMultiBoxView && (mostRecentBoxData.Eggs > 0 && !nrfPercentageString.StartsWith("0") || !string.IsNullOrWhiteSpace(stickyNotes)))
                || (settings.ShowSingleEggBoxesInMultiboxView && mostRecentBoxData.Eggs == 1)
                || (settings.ShowDoubleEggBoxesInMultiboxView && mostRecentBoxData.Eggs == 2)
                || (settings.ShowDCMBoxesInMultiboxView && mostRecentBoxData.BreedingChance == "DCM");

            // Determine if box should be hidden
            bool hideBox =
                (settings.HideBoxesWithDataInMultiBoxView && boxData.ContainsKey(boxName))
                || (settings.HideDCMInMultiBoxView && mostRecentBoxData.BreedingChance == "DCM")
                || (settings.HideBeforeCurrentInMultiBoxView && _dataManager.CurrentBoxIndex > _dataManager.BoxNamesAndIndexes[boxName])
                || (settings.HideNoBoxesInMultiBoxView && mostRecentBoxData.BreedingChance == "NO")
                || (settings.HideUnlikelyBoxesInMultiBoxView && mostRecentBoxData.BreedingChance == "UNL")
                || (settings.HidePotentialBoxesInMultiBoxView && mostRecentBoxData.BreedingChance == "POT")
                || (settings.HideConfidentBoxesInMultiBoxView && mostRecentBoxData.BreedingChance == "CON")
                || (settings.HideBreedingBoxesInMultiBoxView && mostRecentBoxData.BreedingChance == "BR")
                || (settings.HideBoxesWithNotesInMultiboxView && !string.IsNullOrWhiteSpace(mostRecentBoxData.Notes))
                || (settings.HideInterestingBoxesInMultiBoxView && (mostRecentBoxData.Eggs > 0 && !nrfPercentageString.StartsWith("0") || !string.IsNullOrWhiteSpace(stickyNotes)))
                || (settings.HideSingleEggBoxesInMultiboxView && mostRecentBoxData.Eggs == 1)
                || (settings.HideDoubleEggBoxesInMultiboxView && mostRecentBoxData.Eggs == 2);

            if (!showBox || hideBox)
                continue;

            // Create box item with visual styling
            var boxItem = CreateBoxOverviewItem(boxName, currentBoxDataFound, currentBoxData, mostRecentBoxData, olderBoxDatas, nrfPercentageString, stickyNotes);
            newBoxItems.Add(boxItem);
        }

        // Update UI once with all items
        FilteredBoxes = new ObservableCollection<BoxOverviewItem>(newBoxItems);
        OnPropertyChanged(nameof(FilteredBoxes));
    }

    private string GetTimestampText(int currentlyVisibleMonitor)
    {
        if (!_dataManager.AllMonitorData.ContainsKey(currentlyVisibleMonitor))
            return "No date in data";

        foreach (BoxData box in _dataManager.AllMonitorData[currentlyVisibleMonitor].BoxData.Values)
        {
            foreach (ScanRecord sc in box.ScannedIds)
            {
                return sc.Timestamp.ToLocalTime().ToString("d MMM yyyy, HH:mm");
            }
            if (box.whenDataCollectedUtc.Year > 2015)
            {
                return box.whenDataCollectedUtc.ToLocalTime().ToString("d MMM yyyy, HH:mm");
            }
        }
        return "No date in data";
    }

    private void UpdateSummary(Dictionary<string, BoxData> boxData, int currentlyVisibleMonitor)
    {
        var totalBoxes = boxData.Count;
        var totalScannedBirds = boxData.Values.Sum(box => box.ScannedIds.Count);
        var totalAdults = boxData.Values.Sum(box => box.Adults);
        var totalEggs = boxData.Values.Sum(box => box.Eggs);
        var totalChicks = boxData.Values.Sum(box => box.Chicks);
        var gateUpCount = boxData.Values.Count(box => box.GateStatus == "Gate up");
        var regateCount = boxData.Values.Count(box => box.GateStatus == "Regate");

        // Count females and males if remote data available
        int totalFemales = 0;
        int totalMales = 0;
        if (_dataManager.RemotePenguinData != null)
        {
            totalFemales = boxData.Values.Sum(box => box.ScannedIds.Count(id =>
                _dataManager.RemotePenguinData.ContainsKey(id.BirdId) &&
                _dataManager.RemotePenguinData[id.BirdId].Sex.Equals("F", StringComparison.OrdinalIgnoreCase)));
            totalMales = boxData.Values.Sum(box => box.ScannedIds.Count(id =>
                _dataManager.RemotePenguinData.ContainsKey(id.BirdId) &&
                _dataManager.RemotePenguinData[id.BirdId].Sex.Equals("M", StringComparison.OrdinalIgnoreCase)));
        }

        // Count new eggs and chicks
        int newEggs = 0;
        int newChicks = 0;
        foreach (var boxEntry in boxData)
        {
            string boxName = boxEntry.Key;
            BoxData currentBox = boxEntry.Value;

            BoxData? previousBox = null;
            for (int i = currentlyVisibleMonitor + 1; i < _dataManager.AllMonitorData.Count; i++)
            {
                if (_dataManager.AllMonitorData[i].BoxData.ContainsKey(boxName))
                {
                    previousBox = _dataManager.AllMonitorData[i].BoxData[boxName];
                    break;
                }
            }

            if (previousBox != null)
            {
                int previousEggs = previousBox.Eggs;
                int previousChicks = previousBox.Chicks;
                int currentEggs = currentBox.Eggs;
                int currentChicks = currentBox.Chicks;

                if (currentChicks > previousChicks)
                {
                    int chickIncrease = currentChicks - previousChicks;
                    newChicks += chickIncrease;
                    int expectedEggs = Math.Max(0, previousEggs - chickIncrease);
                    if (currentEggs > expectedEggs)
                    {
                        newEggs += currentEggs - expectedEggs;
                    }
                }
                else if (currentEggs > previousEggs)
                {
                    newEggs += currentEggs - previousEggs;
                }
            }
        }

        string percentFemale = totalFemales + totalMales > 0
            ? $", {100 * totalFemales / (totalFemales + totalMales)}% female"
            : "";

        string newEggsChicksLine = "";
        if (newEggs > 0 || newChicks > 0)
        {
            newEggsChicksLine = $"\n* NEW: {newEggs} eggs, {newChicks} chicks";
        }

        string boxRange = boxData.Keys.Any()
            ? $"\nBox range: {boxData.Keys.Min()} - {boxData.Keys.Max()}"
            : "";

        SummaryText = $"{totalBoxes} boxes with data\n" +
                      $"{totalScannedBirds} bird scans{percentFemale}\n" +
                      $"{totalAdults} adults\n" +
                      $"{totalEggs} eggs\n" +
                      $"{totalChicks} chicks" +
                      newEggsChicksLine +
                      $"\nGate: {gateUpCount} up, {regateCount} regate" +
                      boxRange;
    }

    private void UpdateFilterTextRepresentation()
    {
        FilterTextRepresentation = DataStorageService.GetFilterTextRepresentation(_dataManager.AppSettings);
    }

    private BoxOverviewItem CreateBoxOverviewItem(string boxName, bool currentExists, BoxData? currentBoxData,
        BoxData mostRecentBoxData, List<BoxData> olderBoxDatas, string nrfPercentageString, string stickyNotes)
    {
        bool isSelected = boxName == _dataManager.CurrentBoxName;
        BoxData thisBoxData = currentBoxData ?? mostRecentBoxData;

        // Determine border color and thickness based on data state
        Color borderColor = Colors.Gray;
        int borderThickness = 3;
        Color backgroundColor = isSelected ? Color.FromArgb("#FFF9C4") : Colors.White;

        // Check for differences with previous monitor if that setting is enabled
        int currentlyVisibleMonitor = _dataManager.AppSettings.CurrentlyVisibleMonitor;
        BoxData? secondMostRecentBoxData = null;
        if (_dataManager.AppSettings.ShowDifferencesWithPreviousMonitor
            && _dataManager.AllMonitorData.Count > currentlyVisibleMonitor + 1
            && _dataManager.AllMonitorData[currentlyVisibleMonitor + 1].BoxData.ContainsKey(boxName))
        {
            secondMostRecentBoxData = _dataManager.AllMonitorData[currentlyVisibleMonitor + 1].BoxData[boxName];
        }

        bool showDiffFromPrevious = false;
        if (_dataManager.AppSettings.ShowDifferencesWithPreviousMonitor && secondMostRecentBoxData != null)
        {
            showDiffFromPrevious =
                thisBoxData.Adults != secondMostRecentBoxData.Adults ||
                thisBoxData.Eggs != secondMostRecentBoxData.Eggs ||
                thisBoxData.Chicks != secondMostRecentBoxData.Chicks ||
                thisBoxData.GateStatus != secondMostRecentBoxData.GateStatus ||
                thisBoxData.BreedingChance != secondMostRecentBoxData.BreedingChance ||
                thisBoxData.Notes != secondMostRecentBoxData.Notes;
        }

        // Check for differences with previous data
        bool differenceFound = false;

        // ShowDifferencesWithPreviousMonitor mode - highlight boxes with any changes from previous monitor
        if (_dataManager.AppSettings.ShowDifferencesWithPreviousMonitor && currentExists
            && (showDiffFromPrevious
                || _dataManager.AllMonitorData.Count == currentlyVisibleMonitor + 1
                || !_dataManager.AllMonitorData[currentlyVisibleMonitor + 1].BoxData.ContainsKey(boxName)))
        {
            borderColor = Colors.Red;
            borderThickness = 8;
        }
        else if (!currentExists)
        {
            // No current data but has older data - yellow border
            borderColor = Color.FromArgb("#FFC107");
            borderThickness = 8;
        }
        else if (olderBoxDatas.Count > 0
            && thisBoxData.Eggs + thisBoxData.Chicks < olderBoxDatas.First().Eggs + olderBoxDatas.First().Chicks)
        {
            // Offspring decreased - red border
            differenceFound = true;
            borderColor = Colors.Red;
            borderThickness = 8;
        }
        else if (thisBoxData.BreedingChance != "BR" && thisBoxData.Eggs + thisBoxData.Chicks > 0)
        {
            // Breeding chance doesn't match offspring - red border
            borderColor = Colors.Red;
            borderThickness = 8;
        }
        else if (olderBoxDatas.Count > 0
            && (thisBoxData.Eggs != olderBoxDatas.First().Eggs || thisBoxData.Chicks != olderBoxDatas.First().Chicks))
        {
            // Offspring changed (but not decreased) - blue border
            differenceFound = true;
            borderColor = Color.FromArgb("#2196F3");
            borderThickness = 8;
        }

        // Build emoji summary
        string emojiSummary = "";
        if (thisBoxData.Adults > 0 || thisBoxData.Eggs > 0 || thisBoxData.Chicks > 0)
        {
            emojiSummary = string.Concat(Enumerable.Repeat("A", thisBoxData.Adults)) +
                           string.Concat(Enumerable.Repeat("E", thisBoxData.Eggs)) +
                           string.Concat(Enumerable.Repeat("C", thisBoxData.Chicks));

            // Show previous if different
            if (differenceFound && olderBoxDatas.Count > 0)
            {
                var prev = olderBoxDatas.First();
                if (prev.Eggs + prev.Chicks > 0)
                {
                    emojiSummary += $"({string.Concat(Enumerable.Repeat("E", prev.Eggs))}{string.Concat(Enumerable.Repeat("C", prev.Chicks))})";
                }
            }
        }

        // Add breeding chance if not BR or if BR without offspring
        if (thisBoxData.BreedingChance != null &&
            (thisBoxData.BreedingChance != "BR" || (thisBoxData.BreedingChance == "BR" && thisBoxData.Chicks + thisBoxData.Eggs == 0)))
        {
            emojiSummary += thisBoxData.BreedingChance;
        }

        // Get breeding status string
        string breedingStatus = DataStorageService.GetBoxBreedingStatusString(boxName, currentExists ? currentBoxData : null, olderBoxDatas);
        if (string.IsNullOrWhiteSpace(breedingStatus) && _dataManager.RemoteBreedingDates != null &&
            _dataManager.RemoteBreedingDates.ContainsKey(boxName))
        {
            breedingStatus = "B:" + _dataManager.RemoteBreedingDates[boxName].breedingDateStatus();
        }

        // Build gate and notes string
        string gateStatus = thisBoxData.GateStatus ?? "";
        string notes = string.IsNullOrWhiteSpace(thisBoxData.Notes) ? "" : "notes";
        notes += !string.IsNullOrEmpty(stickyNotes) ? $" ({stickyNotes})" : "";
        notes += !nrfPercentageString.StartsWith("0") ? $" (NRF:{nrfPercentageString})" : "";

        string gateAndNotes = "";
        if (!string.IsNullOrWhiteSpace(gateStatus) && !string.IsNullOrWhiteSpace(notes))
            gateAndNotes = gateStatus + " & " + notes;
        else
            gateAndNotes = gateStatus + notes;

        return new BoxOverviewItem
        {
            BoxName = boxName,
            BoxTitle = $"Box {boxName}",
            EmojiSummary = emojiSummary,
            BreedingStatus = breedingStatus,
            HasBreedingStatus = !string.IsNullOrWhiteSpace(breedingStatus),
            GateAndNotes = gateAndNotes,
            HasGateOrNotes = !string.IsNullOrWhiteSpace(gateAndNotes),
            BorderColor = borderColor,
            BorderThickness = borderThickness,
            BackgroundColor = backgroundColor,
            SelectCommand = new Command(() => SelectBox(boxName))
        };
    }

    private void SelectBox(string boxName)
    {
        _dataManager.CurrentBoxName = boxName;
        _dataManager.CurrentBoxIndex = _dataManager.BoxNamesAndIndexes[boxName];
        _dataManager.RaiseBoxChanged(boxName);

        // Navigate to Box Data tab
        Shell.Current.GoToAsync("//BoxDataPage");
    }

    #region Action Button Commands

    private async Task OnClearAllAsync()
    {
        bool confirmed = await Application.Current!.MainPage!.DisplayAlert(
            "Clear All Data",
            "Are you sure you want to clear ALL box data for the current monitor? This cannot be undone.",
            "Clear All",
            "Cancel");

        if (!confirmed)
            return;

        // Clear all box data in monitor 0 (current/local data)
        if (_dataManager.AllMonitorData.ContainsKey(0))
        {
            _dataManager.AllMonitorData[0].BoxData.Clear();
            _dataManager.RaiseDataChanged();

            // Save the cleared data
#if ANDROID
            var context = Platform.CurrentActivity;
            if (context != null)
            {
                await DataStorageService.SaveAllMonitorDataToDisk(context, _dataManager.AllMonitorData, reportHome: false);
            }
#endif
        }

        RefreshData();
        await Application.Current?.MainPage?.DisplayAlert("Cleared", "All box data has been cleared.", "OK");
    }

    private async Task OnBirdStatsAsync()
    {
        if (_isDownloadingBirdStats)
            return;

        _isDownloadingBirdStats = true;
        BirdStatsButtonText = "Loading...";
        BirdStatsButtonColor = Color.FromArgb("#FFC107"); // Yellow while loading
        OnPropertyChanged(nameof(CanDownloadBirdStats));

        try
        {
#if ANDROID
            var context = Platform.CurrentActivity;
            if (context != null)
            {
                await _dataStorageService.DownloadRemoteData(context, _dataManager.AllMonitorData);

                // Reload data
                var loadedData = _dataStorageService.LoadAllMonitorDataFromDisk(context);
                if (loadedData != null)
                {
                    _dataManager.AllMonitorData = loadedData;
                }

                // Load remote penguin info
                var remotePenguinData = await _dataStorageService.loadRemotePengInfoFromAppDataDir(context);
                if (remotePenguinData != null)
                {
                    _dataManager.RemotePenguinData = remotePenguinData;
                }

                RefreshData();
                _dataManager.RaiseDataChanged();
            }
#endif
        }
        catch (Exception ex)
        {
            await Application.Current?.MainPage?.DisplayAlert("Error", $"Failed to download bird stats: {ex.Message}", "OK");
        }
        finally
        {
            _isDownloadingBirdStats = false;
            BirdStatsButtonText = "Bird Stats";
            BirdStatsButtonColor = Color.FromArgb("#2196F3"); // Blue
            OnPropertyChanged(nameof(CanDownloadBirdStats));
        }
    }

    private async Task OnSaveLoadAsync()
    {
        string action = await Application.Current?.MainPage?.DisplayActionSheet(
            "Data Options",
            "Cancel",
            null,
            "💾 Save to file",
            "📂 Load from device",
            "🌐 Load from server",
            "📤 Upload to server") ?? "Cancel";

        switch (action)
        {
            case "💾 Save to file":
                await SaveToFileAsync();
                break;
            case "📂 Load from device":
                await LoadFromDeviceAsync();
                break;
            case "🌐 Load from server":
                await LoadFromServerAsync();
                break;
            case "📤 Upload to server":
                await UploadToServerAsync();
                break;
        }
    }

    private async Task SaveToFileAsync()
    {
        try
        {
            if (!_dataManager.AllMonitorData.ContainsKey(0) || _dataManager.AllMonitorData[0].BoxData.Count == 0)
            {
                await Application.Current?.MainPage?.DisplayAlert("No Data", "There is no data to save.", "OK");
                return;
            }

            var monitorData = _dataManager.AllMonitorData[0];
            var json = JsonConvert.SerializeObject(monitorData, Formatting.Indented);

            // Generate filename with timestamp
            var timestamp = DateTime.Now.ToString("yyyy-MM-dd_HHmm");
            var filename = $"PenguinMonitor_{timestamp}.json";

            // Save to Downloads folder
            var downloadsPath = Android.OS.Environment.GetExternalStoragePublicDirectory(
                Android.OS.Environment.DirectoryDownloads)?.AbsolutePath;

            if (!string.IsNullOrEmpty(downloadsPath))
            {
                var filePath = Path.Combine(downloadsPath, filename);
                File.WriteAllText(filePath, json);
                await Application.Current?.MainPage?.DisplayAlert("Saved", $"Data saved to Downloads/{filename}", "OK");
            }
            else
            {
                await Application.Current?.MainPage?.DisplayAlert("Error", "Could not access Downloads folder.", "OK");
            }
        }
        catch (Exception ex)
        {
            await Application.Current?.MainPage?.DisplayAlert("Error", $"Failed to save: {ex.Message}", "OK");
        }
    }

    private async Task LoadFromDeviceAsync()
    {
        try
        {
            var result = await FilePicker.PickAsync(new PickOptions
            {
                PickerTitle = "Select monitor data file",
                FileTypes = new FilePickerFileType(new Dictionary<DevicePlatform, IEnumerable<string>>
                {
                    { DevicePlatform.Android, new[] { "application/json", "text/plain" } }
                })
            });

            if (result == null)
                return;

            using var stream = await result.OpenReadAsync();
            using var reader = new StreamReader(stream);
            var json = await reader.ReadToEndAsync();

            var loadedMonitor = JsonConvert.DeserializeObject<MonitorDetails>(json);
            if (loadedMonitor != null)
            {
                // Add as a new historical monitor
                int newIndex = _dataManager.AllMonitorData.Count;
                loadedMonitor.filename = result.FileName;
                _dataManager.AllMonitorData[newIndex] = loadedMonitor;

                // Save updated data
#if ANDROID
                var context = Platform.CurrentActivity;
                if (context != null)
                {
                    await DataStorageService.SaveAllMonitorDataToDisk(context, _dataManager.AllMonitorData, reportHome: false);
                }
#endif

                RefreshData();
                await Application.Current?.MainPage?.DisplayAlert("Loaded", $"Loaded data from {result.FileName}", "OK");
            }
        }
        catch (Exception ex)
        {
            await Application.Current?.MainPage?.DisplayAlert("Error", $"Failed to load: {ex.Message}", "OK");
        }
    }

    private async Task LoadFromServerAsync()
    {
        try
        {
#if ANDROID
            var context = Platform.CurrentActivity;
            if (context != null)
            {
                // Download remote data (which includes server monitor data)
                await _dataStorageService.DownloadRemoteData(context, _dataManager.AllMonitorData);

                // Reload all data from disk
                var loadedData = _dataStorageService.LoadAllMonitorDataFromDisk(context);
                if (loadedData != null)
                {
                    _dataManager.AllMonitorData = loadedData;
                    RefreshData();
                    _dataManager.RaiseDataChanged();
                    await Application.Current?.MainPage?.DisplayAlert("Loaded", "Data loaded from server.", "OK");
                }
                else
                {
                    await Application.Current?.MainPage?.DisplayAlert("Error", "No data received from server.", "OK");
                }
            }
#endif
        }
        catch (Exception ex)
        {
            await Application.Current?.MainPage?.DisplayAlert("Error", $"Failed to load from server: {ex.Message}", "OK");
        }
    }

    private async Task UploadToServerAsync()
    {
        try
        {
            if (!_dataManager.AllMonitorData.ContainsKey(0) || _dataManager.AllMonitorData[0].BoxData.Count == 0)
            {
                await Application.Current?.MainPage?.DisplayAlert("No Data", "There is no data to upload.", "OK");
                return;
            }

            var monitorData = _dataManager.AllMonitorData[0];
            var json = JsonConvert.SerializeObject(monitorData, Formatting.Indented);

            // Upload to server using Backend
            string response = await Task.Run(() => Backend.RequestServerResponse("PenguinReport:" + json));

            if (response == "fail" || string.IsNullOrEmpty(response))
            {
                await Application.Current?.MainPage?.DisplayAlert("Error", "Failed to upload to server.", "OK");
            }
            else
            {
                await Application.Current?.MainPage?.DisplayAlert("Uploaded", "Data uploaded to server successfully.", "OK");
            }
        }
        catch (Exception ex)
        {
            await Application.Current?.MainPage?.DisplayAlert("Error", $"Failed to upload: {ex.Message}", "OK");
        }
    }

    #endregion

    protected void OnPropertyChanged([CallerMemberName] string? propertyName = null)
    {
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }
}

public class BoxOverviewItem
{
    public string BoxName { get; set; } = "";
    public string BoxTitle { get; set; } = "";
    public string EmojiSummary { get; set; } = "";
    public string BreedingStatus { get; set; } = "";
    public bool HasBreedingStatus { get; set; }
    public string GateAndNotes { get; set; } = "";
    public bool HasGateOrNotes { get; set; }
    public Color BorderColor { get; set; } = Colors.Gray;
    public int BorderThickness { get; set; } = 3;
    public Color BackgroundColor { get; set; } = Colors.Transparent;
    public ICommand? SelectCommand { get; set; }
}
