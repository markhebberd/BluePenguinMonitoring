using System;
using System.Threading.Tasks;

#if ANDROID
using Android.Content;
using Android.Media;
using Android.OS;
#endif

namespace PenguinMonitor.Services
{
    /// <summary>
    /// Provides haptic feedback and sound alerts for scan events
    /// </summary>
    public class FeedbackService
    {
        private static FeedbackService? _instance;
        public static FeedbackService Instance => _instance ??= new FeedbackService();

#if ANDROID
        private Vibrator? _vibrator;
        private MediaPlayer? _alertMediaPlayer;
#endif

        public void Initialize()
        {
#if ANDROID
            try
            {
                var context = Platform.CurrentActivity;
                if (context == null) return;

                // Initialize vibrator
                if (OperatingSystem.IsAndroidVersionAtLeast(31))
                {
                    var vibratorManager = (VibratorManager?)context.GetSystemService(Context.VibratorManagerService);
                    _vibrator = vibratorManager?.DefaultVibrator;
                }
                else
                {
                    _vibrator = (Vibrator?)context.GetSystemService(Context.VibratorService);
                }

                // Initialize alert sound (using system notification sound)
                var notificationUri = RingtoneManager.GetDefaultUri(RingtoneType.Notification);
                if (notificationUri != null)
                {
                    var audioAttributesBuilder = new AudioAttributes.Builder();
                    var audioAttributes = audioAttributesBuilder?.SetUsage(AudioUsageKind.Alarm)
                                                                ?.SetContentType(AudioContentType.Sonification)
                                                                ?.Build();

                    _alertMediaPlayer = MediaPlayer.Create(context, notificationUri);
                    if (_alertMediaPlayer != null && audioAttributes != null)
                    {
                        _alertMediaPlayer.SetAudioAttributes(audioAttributes);
                    }
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to initialize vibration/sound: {ex.Message}");
            }
#endif
        }

        /// <summary>
        /// Short vibration for successful scan
        /// </summary>
        public void VibrateShort()
        {
#if ANDROID
            try
            {
                if (_vibrator?.HasVibrator == true)
                {
                    if (OperatingSystem.IsAndroidVersionAtLeast(26))
                    {
                        _vibrator.Vibrate(VibrationEffect.CreateOneShot(50, VibrationEffect.DefaultAmplitude));
                    }
                    else
                    {
                        _vibrator.Vibrate(50);
                    }
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Vibration failed: {ex.Message}");
            }
#endif
        }

        /// <summary>
        /// Medium vibration for navigation/confirmation
        /// </summary>
        public void VibrateMedium()
        {
#if ANDROID
            try
            {
                if (_vibrator?.HasVibrator == true)
                {
                    if (OperatingSystem.IsAndroidVersionAtLeast(26))
                    {
                        _vibrator.Vibrate(VibrationEffect.CreateOneShot(100, VibrationEffect.DefaultAmplitude));
                    }
                    else
                    {
                        _vibrator.Vibrate(100);
                    }
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Vibration failed: {ex.Message}");
            }
#endif
        }

        /// <summary>
        /// Long vibration pattern for alert (e.g., dead bird scanned)
        /// </summary>
        public void VibrateAlert()
        {
#if ANDROID
            try
            {
                if (_vibrator?.HasVibrator == true)
                {
                    // Pattern: pause, vibrate, pause, vibrate, pause, vibrate
                    long[] pattern = { 0, 200, 100, 200, 100, 200 };
                    if (OperatingSystem.IsAndroidVersionAtLeast(26))
                    {
                        _vibrator.Vibrate(VibrationEffect.CreateWaveform(pattern, -1));
                    }
                    else
                    {
                        _vibrator.Vibrate(pattern, -1);
                    }
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Vibration failed: {ex.Message}");
            }
#endif
        }

        /// <summary>
        /// Play notification sound
        /// </summary>
        public void PlayAlertSound()
        {
#if ANDROID
            try
            {
                if (_alertMediaPlayer != null)
                {
                    if (_alertMediaPlayer.IsPlaying)
                    {
                        _alertMediaPlayer.Stop();
                        _alertMediaPlayer.Prepare();
                    }
                    _alertMediaPlayer.Start();
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Sound playback failed: {ex.Message}");
            }
#endif
        }

        /// <summary>
        /// Combined feedback for successful scan
        /// </summary>
        public void OnScanSuccess()
        {
            VibrateShort();
        }

        /// <summary>
        /// Combined feedback for box tag scan
        /// </summary>
        public void OnBoxTagScan()
        {
            VibrateMedium();
        }

        /// <summary>
        /// Combined feedback for alert (dead bird, etc.)
        /// </summary>
        public void OnAlertScan()
        {
            VibrateAlert();
            PlayAlertSound();
        }

        public void Dispose()
        {
#if ANDROID
            try
            {
                _alertMediaPlayer?.Release();
                _alertMediaPlayer?.Dispose();
                _alertMediaPlayer = null;
            }
            catch { }
#endif
        }
    }
}
