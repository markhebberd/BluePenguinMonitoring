using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows.Input;
using PenguinMonitor.Models;
using PenguinMonitor.Services;

namespace PenguinMonitor.ViewModels;

public class SettingsViewModel : INotifyPropertyChanged
{
    private readonly DataManager _dataManager = DataManager.Instance;
    private string _statusText = "Bluetooth Disabled";
    private Color _statusColor = Color.FromArgb("#757575");

    public event PropertyChangedEventHandler PropertyChanged;

    public AppSettings AppSettings => _dataManager.AppSettings;

    public string VersionText => $"Version: 37.25 (MAUI)";

    public string StatusText
    {
        get => _statusText;
        set
        {
            if (_statusText != value)
            {
                _statusText = value;
                OnPropertyChanged();
            }
        }
    }

    public Color StatusColor
    {
        get => _statusColor;
        set
        {
            if (_statusColor != value)
            {
                _statusColor = value;
                OnPropertyChanged();
            }
        }
    }

    public string TimeStampText =>
        $"Set time for monitor: {AppSettings.ActiveSessionLocalTimeStamp:HH:mm, d MMM yyyy}";

    // Date and Time picker bindings
    public DateTime SessionDate
    {
        get => AppSettings.ActiveSessionLocalTimeStamp.Date;
        set
        {
            if (AppSettings.ActiveSessionLocalTimeStamp.Date != value.Date)
            {
                AppSettings.ActiveSessionLocalTimeStamp = value.Date + AppSettings.ActiveSessionLocalTimeStamp.TimeOfDay;
                OnPropertyChanged();
                OnPropertyChanged(nameof(TimeStampText));
            }
        }
    }

    public TimeSpan SessionTime
    {
        get => AppSettings.ActiveSessionLocalTimeStamp.TimeOfDay;
        set
        {
            if (AppSettings.ActiveSessionLocalTimeStamp.TimeOfDay != value)
            {
                AppSettings.ActiveSessionLocalTimeStamp = AppSettings.ActiveSessionLocalTimeStamp.Date + value;
                OnPropertyChanged();
                OnPropertyChanged(nameof(TimeStampText));
            }
        }
    }

    // Selected box set with two-way binding
    private string _selectedBoxSet;
    public string SelectedBoxSet
    {
        get => _selectedBoxSet ?? AppSettings.BoxSetString ?? "All";
        set
        {
            if (_selectedBoxSet != value)
            {
                _selectedBoxSet = value;
                AppSettings.BoxSetString = value ?? "All";
                OnPropertyChanged();
                // Re-populate box names when selection changes
                _dataManager.PopulateBoxNames();
            }
        }
    }

    public ObservableCollection<string> BoxSetOptions { get; set; }

    public ICommand ApplyBoxSetsCommand { get; }

    public SettingsViewModel()
    {
        // Initialize AppSettings if not already set
        if (string.IsNullOrEmpty(AppSettings.filesDir))
        {
            AppSettings.filesDir = FileSystem.AppDataDirectory;
            AppSettings.IsBlueToothEnabled = false;
            AppSettings.ActiveSessionTimeStampActive = false;
            AppSettings.ActiveSessionLocalTimeStamp = DateTime.Now;
            AppSettings.ShowBoxTagDeleteButton = false;
            AppSettings.ShowDifferencesWithPreviousMonitor = false;
            AppSettings.AllBoxSetsString = "{1-150,AA-AC}";
            AppSettings.BoxSetString = "All";
        }

        BoxSetOptions = new ObservableCollection<string>();
        UpdateBoxSetOptions();

        // Initialize selected box set from AppSettings
        _selectedBoxSet = AppSettings.BoxSetString ?? "All";

        ApplyBoxSetsCommand = new Command(ApplyBoxSets);

        // Subscribe to status changes from DataManager
        _dataManager.StatusChanged += OnStatusChanged;

        // Start GPS monitoring
        StartGpsMonitoring();

        // Set initial status
        UpdateStatusFromBluetoothState();
    }

    private async void StartGpsMonitoring()
    {
        try
        {
            var status = await Permissions.CheckStatusAsync<Permissions.LocationWhenInUse>();
            if (status != PermissionStatus.Granted)
            {
                status = await Permissions.RequestAsync<Permissions.LocationWhenInUse>();
            }

            if (status == PermissionStatus.Granted)
            {
                // Start continuous location updates
                _ = Task.Run(async () =>
                {
                    while (true)
                    {
                        try
                        {
                            var location = await Geolocation.GetLocationAsync(new GeolocationRequest
                            {
                                DesiredAccuracy = GeolocationAccuracy.Best,
                                Timeout = TimeSpan.FromSeconds(10)
                            });

                            if (location != null && location.Accuracy.HasValue)
                            {
                                _dataManager.UpdateGpsAccuracy((float)location.Accuracy.Value);
                            }
                        }
                        catch (Exception)
                        {
                            // GPS not available, update with no signal
                            _dataManager.UpdateGpsAccuracy(-1);
                        }

                        await Task.Delay(5000); // Update every 5 seconds
                    }
                });
            }
        }
        catch (Exception)
        {
            // Permission denied or GPS not available
        }
    }

    private void OnStatusChanged(object sender, string status)
    {
        // Update on main thread
        MainThread.BeginInvokeOnMainThread(() =>
        {
            StatusText = status;
            UpdateStatusColor(status);
        });
    }

    private void UpdateStatusFromBluetoothState()
    {
        // Use the combined status text from DataManager (includes GPS)
        StatusText = _dataManager.GetFullStatusText();
        UpdateStatusColor(StatusText);
    }

    private void UpdateStatusColor(string status)
    {
        if (status.Contains("Connected") || status.Contains("✅"))
        {
            StatusColor = Color.FromArgb("#4CAF50"); // Green
        }
        else if (status.Contains("Connecting") || status.Contains("🔗") || status.Contains("🔄"))
        {
            StatusColor = Color.FromArgb("#FF9800"); // Orange/Yellow
        }
        else if (status.Contains("❌") || status.Contains("failed") || status.Contains("error"))
        {
            StatusColor = Color.FromArgb("#F44336"); // Red
        }
        else if (status.Contains("⚠️"))
        {
            StatusColor = Color.FromArgb("#FF9800"); // Orange/Yellow
        }
        else
        {
            StatusColor = Color.FromArgb("#757575"); // Gray
        }
    }

    private void ApplyBoxSets()
    {
        UpdateBoxSetOptions();
        // Re-populate box names with the new settings
        _dataManager.PopulateBoxNames();
    }

    private void UpdateBoxSetOptions()
    {
        BoxSetOptions.Clear();

        if (!string.IsNullOrWhiteSpace(AppSettings.AllBoxSetsString))
        {
            var boxSets = AppSettings.AllBoxSetsString
                .Split(new[] { "},{", "{", "}" }, StringSplitOptions.RemoveEmptyEntries)
                .ToList();

            foreach (var set in boxSets)
            {
                BoxSetOptions.Add(set);
            }
        }

        BoxSetOptions.Add("All");

        // Ensure selected box set is valid
        if (!BoxSetOptions.Contains(SelectedBoxSet))
        {
            SelectedBoxSet = "All";
        }
        OnPropertyChanged(nameof(SelectedBoxSet));
    }

    protected void OnPropertyChanged([CallerMemberName] string propertyName = null)
    {
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }
}
