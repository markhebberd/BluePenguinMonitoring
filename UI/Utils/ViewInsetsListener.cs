using Android.OS;
using Android.Views;

namespace BluePenguinMonitoring.UI.Utils
{
    public class ViewInsetsListener : Java.Lang.Object, View.IOnApplyWindowInsetsListener
    {
        public WindowInsets OnApplyWindowInsets(View v, WindowInsets insets)
        {
            int topInset = insets.SystemWindowInsetTop;
            int bottomInset = insets.SystemWindowInsetBottom;
            
            if (Build.VERSION.SdkInt >= BuildVersionCodes.P && insets.DisplayCutout != null)
            {
                topInset = System.Math.Max(topInset, insets.DisplayCutout.SafeInsetTop);
            }

            // Apply padding to avoid content being hidden behind system UI
            v.SetPadding(20, topInset + 20, 20, bottomInset + 20);

            return insets;
        }
    }
}