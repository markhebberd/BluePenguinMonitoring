using PenguinMonitor.ViewModels;

namespace PenguinMonitor.Pages;

public partial class BoxDataPage : ContentPage
{
	private readonly BoxDataViewModel _viewModel;

	public BoxDataPage()
	{
		InitializeComponent();
		_viewModel = new BoxDataViewModel();
		BindingContext = _viewModel;
	}

	protected override void OnAppearing()
	{
		base.OnAppearing();
		// Data is automatically loaded in ViewModel constructor
	}
}
