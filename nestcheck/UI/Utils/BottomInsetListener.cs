using Android.Views;

namespace PenguinMonitor.UI.Utils
{
    /// <summary>
    /// Pads a bottom-anchored bar clear of the system navigation bar. Unlike
    /// ViewInsetsListener this only touches the bottom edge, so a floating bar keeps
    /// its own left/right/top padding.
    /// </summary>
    public class BottomInsetListener : Java.Lang.Object, View.IOnApplyWindowInsetsListener
    {
        private readonly int _extraPx;

        public BottomInsetListener(int extraPx)
        {
            _extraPx = extraPx;
        }

        public WindowInsets OnApplyWindowInsets(View v, WindowInsets insets)
        {
            int bottomInset = 0;
            if (OperatingSystem.IsAndroidVersionAtLeast(21))
                bottomInset = insets.SystemWindowInsetBottom;

            v.SetPadding(v.PaddingLeft, v.PaddingTop, v.PaddingRight, bottomInset + _extraPx);

            return insets;
        }
    }
}
