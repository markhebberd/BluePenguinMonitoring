namespace PenguinMonitor;

public partial class App : Application
{
	public App()
	{
		InitializeComponent();

		// Force light theme to ensure consistent text visibility
		UserAppTheme = AppTheme.Light;
	}

	protected override Window CreateWindow(IActivationState? activationState)
	{
		return new Window(new AppShell());
	}
}