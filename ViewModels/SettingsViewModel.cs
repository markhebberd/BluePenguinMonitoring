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

    public event PropertyChangedEventHandler PropertyChanged;

    public AppSettings AppSettings => _dataManager.AppSettings;

    public string VersionText => $"Version: 37.25 (MAUI)";

    public string TimeStampText =>
        $"Set time for monitor: {AppSettings.ActiveSessionLocalTimeStamp:HH:mm, d MMM yyyy}";

    public ObservableCollection<string> BoxSetOptions { get; set; }

    public ICommand SetTimeCommand { get; }
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

        BoxSetOptions = new ObservableCollection<string> { "All" };
        UpdateBoxSetOptions();

        SetTimeCommand = new Command(async () => await SetDateTime());
        ApplyBoxSetsCommand = new Command(ApplyBoxSets);
    }

    private async Task SetDateTime()
    {
        // Show date picker
        var date = await Application.Current.MainPage.DisplayPromptAsync(
            "Set Date",
            "Enter date (yyyy-MM-dd):",
            initialValue: AppSettings.ActiveSessionLocalTimeStamp.ToString("yyyy-MM-dd"));

        if (date != null && DateTime.TryParse(date, out var parsedDate))
        {
            // Show time picker
            var time = await Application.Current.MainPage.DisplayPromptAsync(
                "Set Time",
                "Enter time (HH:mm):",
                initialValue: AppSettings.ActiveSessionLocalTimeStamp.ToString("HH:mm"));

            if (time != null && TimeSpan.TryParse(time, out var parsedTime))
            {
                AppSettings.ActiveSessionLocalTimeStamp = parsedDate.Date + parsedTime;
                OnPropertyChanged(nameof(TimeStampText));
            }
        }
    }

    private void ApplyBoxSets()
    {
        UpdateBoxSetOptions();
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
    }

    protected void OnPropertyChanged([CallerMemberName] string propertyName = null)
    {
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }
}
