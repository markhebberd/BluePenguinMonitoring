using PenguinMonitor.ViewModels;

namespace PenguinMonitor.Pages;

public partial class OverviewPage : ContentPage
{
	private readonly OverviewViewModel _viewModel;

	public OverviewPage()
	{
		InitializeComponent();
		_viewModel = new OverviewViewModel();
		BindingContext = _viewModel;
	}

	protected override void OnAppearing()
	{
		base.OnAppearing();
		// Refresh data when page appears
		_viewModel.RefreshData();
	}
}
