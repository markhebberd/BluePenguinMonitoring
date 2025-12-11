using PenguinMonitor.ViewModels;

namespace PenguinMonitor.Pages;

public partial class SettingsPage : ContentPage
{
	private readonly SettingsViewModel _viewModel;

	public SettingsPage()
	{
		InitializeComponent();
		_viewModel = new SettingsViewModel();
		BindingContext = _viewModel;
	}

	private async void OnBluetoothChanged(object sender, CheckedChangedEventArgs e)
	{
		if (e.Value)
		{
			// Initialize Bluetooth
			await DisplayAlert("Bluetooth", "Bluetooth enabled - initialization code needed", "OK");
		}
		else
		{
			// Disable Bluetooth
			await DisplayAlert("Bluetooth", "Bluetooth disabled", "OK");
		}
	}
}
