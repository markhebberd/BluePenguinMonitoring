using PenguinMonitor.Services;
using PenguinMonitor.ViewModels;

namespace PenguinMonitor.Pages;

public partial class SettingsPage : ContentPage
{
	private readonly SettingsViewModel _viewModel;
	private readonly DataManager _dataManager = DataManager.Instance;

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
			// Initialize and start Bluetooth connection
			await _dataManager.EnableBluetoothAsync();
		}
		else
		{
			// Disable Bluetooth
			_dataManager.DisableBluetooth();
		}
	}
}
