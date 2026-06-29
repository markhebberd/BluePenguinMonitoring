using Android.Animation;
using Android.Content;
using Android.Content.PM;
using Android.Graphics;
using Android.Locations;
using Android.Media;
using Android.OS;
using Android.Text;
using Android.Views;
using Android.Views.Animations;
using Android.Views.InputMethods;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using PenguinMonitor.Models;
using PenguinMonitor.Services;
using PenguinMonitor.UI.Factories;
using PenguinMonitor.UI.Gestures;
using PenguinMonitor.UI.Utils;
using System.ComponentModel;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace PenguinMonitor
{
    [Activity(
        Label = "@string/app_name",
        MainLauncher = true,
        Theme = "@android:style/Theme.NoTitleBar",
        ScreenOrientation = Android.Content.PM.ScreenOrientation.Portrait,
        WindowSoftInputMode = SoftInput.AdjustResize
    )]
    [IntentFilter(new[] { Android.Content.Intent.ActionView },
        Categories = new[] { Android.Content.Intent.CategoryDefault, Android.Content.Intent.CategoryBrowsable },
        DataMimeType = "application/json")]
    [IntentFilter(new[] { Android.Content.Intent.ActionView },
        Categories = new[] { Android.Content.Intent.CategoryDefault, Android.Content.Intent.CategoryBrowsable },
        DataMimeType = "*/*",
        DataPathPattern = ".*\\.json")]
    [IntentFilter(new[] { Android.Content.Intent.ActionView },
        Categories = new[] { Android.Content.Intent.CategoryDefault, Android.Content.Intent.CategoryBrowsable },
        DataScheme = "nestcheck", DataHost = "auth")]
    public class MainActivity : Activity, ILocationListener
    {
        private string? _versionCache;
        private string version => _versionCache ??= PackageManager!.GetPackageInfo(PackageName!, 0)!.VersionName!;
        private static readonly TimeZoneInfo NzTimeZone = TimeZoneInfo.FindSystemTimeZoneById("Pacific/Auckland");
        internal static DateTime ToNzTime(DateTime dt) => TimeZoneInfo.ConvertTimeFromUtc(
            dt.Kind == DateTimeKind.Utc ? dt : DateTime.SpecifyKind(dt, DateTimeKind.Utc), NzTimeZone);
        internal static DateTime NzNow => ToNzTime(DateTime.UtcNow);
        internal static DateTime NzToday => NzNow.Date;
        // Bluetooth manager
        private BluetoothManager? _bluetoothManager;

        // GPS components
        private LocationManager? _locationManager;
        private Location? _currentLocation;
        private float _gpsAccuracy = -1;

        // Held scans — penguin chips scanned while no box is unlocked
        private readonly List<ScanRecord> _heldScans = new();
        private AlertDialog? _heldScansDialog;
        // Set when the user scans another box's tag before locking the current box.
        // Penguin scans are recorded into _heldScans and replayed into this box once the current box is locked.
        private string? _pendingBoxTagNavigation;
        // Once a pending navigation exists, scanning a different box tag freezes the recording:
        // the destination is fixed (first tag wins) and no further scans are queued.
        private bool _pendingScanQueueFrozen;

        // Suppress ALL sync while data-entry dialogs are open
        private bool _dialogActive;
        private void SetDialogActive(bool active)
        {
            _dialogActive = active;
            if (active)
                _dataStorageService.StopBackgroundPolling();
            else
            {
                var token = _appSettings?.AuthToken;
                if (!string.IsNullOrEmpty(token))
                    _dataStorageService.StartBackgroundPolling(token, () => DoSilentSync(token), () => { _lastSyncCheckUtc = DateTime.UtcNow; RunOnUiThread(() => { UpdateStatusText(); }); }, async () => { if (_colonyState?.PendingUploadCount > 0) { RunOnUiThread(() => TryBackgroundUpload()); } });
            }
        }

        // Status refresh (updates "sync:Xs ago" display)
        private Handler? _statusRefreshHandler;
        private Java.Lang.Runnable? _statusRefreshRunnable;
        private DateTime _lastSyncCheckUtc = DateTime.MinValue;

        // UI Components
        private ScrollView? _rootScrollView;
        private TextView? _statusText; // scanner and GPS status

        private LinearLayout? _topButtonLayout; //Clear, bird stats and save/load. 

        private Button? _prevBoxButton;
        private Button? _selectBoxButton;
        private Button? _nextBoxButton;

        private LinearLayout? _settingsCard;
        private LinearLayout _overviewFiltersLayout;
        private CheckBox? _isBluetoothEnabledCheckBox;
        private Button? _syncButton;
        private TextView? _interestingBoxTextView;
        private TextView? _dupPenguinWarningView;
        private TextView? _stickyBulb1;
        private TextView? _stickyBulb2;
        private LinearLayout? _stickyNoteBar;
        private CheckBox _setTimeActiveSessionCheckBox;
        private TextView _boxSavedTimeTextView;
        private Spinner _boxSetSelector;

        // Single box data 
        private bool _isBoxLocked;
        private bool _dataChangedSinceUnlock;
        private bool _suppressDataChanged;
        // Track server observation IDs that user already confirmed locally (fallback for non-optimistic paths)
        private Dictionary<string, int> _confirmedAgainstServerObsId = new();
        private bool _highOffspringCountConfirmed;
        private LinearLayout? _singleBoxDataOuterLayout;
        private LinearLayout? _singleBoxDataTitleLayout;
        private LinearLayout _singleBoxDataContentLayout;
        private LinearLayout _boxNavigationButtonsLayout;
        private TextView? _dataCardTitleText;
        private ImageView? _dataCardLockIconView;
        private TextView? _discardButton;
        private Button? _deleteBoxTagButton;

        private TextView? _standaloneDailyLabelWarning;
        private ImageButton? _expandButton;
        private LinearLayout? _prevObsSummaryLayout;
        private TextView? _todayMiniView;
        private TextView? _prevObsHeaderText;
        private LinearLayout? _prevObsDetailLayout;
        private LinearLayout? _tagModeContentLayout;
        private TextView? _tagModeInstructionText;
        private LinearLayout? _tagModeTodayCard;

        private List<LinearLayout?> _scannedIdsLayout;
        private EditText? _manualScanEditText;

        private List<EditText?> _adultsEditText;
        private List<EditText?> _eggsEditText;
        private List<EditText?> _chicksEditText;
        private List<Spinner?> _breedingChanceSpinner;
        private List<Spinner?> _gateStatusSpinner;
        private List<EditText?> _notesEditText;
        private bool _shouldAutoDownloadBirdStats;
        private bool _isHistoricalView;
        private string _historicalFilename = "";
        private Dictionary<string, BoxObservation> _historicalBoxes = new();
        private TextView? _appTitleText;
        private Button? _exitHistoricalButton;
        private LinearLayout? _titleCard;
        private ImageButton? _expandSettingsButton;
        private Dictionary<string, BoxNoteData> _boxNotes = new Dictionary<string, BoxNoteData>();

        public UIFactory.selectedPage selectedPage;
        private readonly (string Text, UIFactory.selectedPage Page)[] _menuItems = new[]
        {
            ("⚙️ Settings",      UIFactory.selectedPage.Settings),
            ("📦 Single box data",  UIFactory.selectedPage.BoxDataSingle),
            ("📊 Today's statistics", UIFactory.selectedPage.BoxOverview),
         };

        // Add gesture detection components
        private GestureDetector? _gestureDetector;
        private float _lastTouchDownY = 0;
        private bool _isAnimating = false;

        // Services
        public UIFactory? _uiFactory;
        private DataStorageService _dataStorageService = new DataStorageService();

        // Data storage
        private int _currentBoxIndex = 1;
        private string _currentBoxName = "";
        private Dictionary<string, int> _boxNamesAndIndexes;
        private ColonyState _colonyState = new ColonyState();
        private AppSettings _appSettings;
        private Dictionary<string, PenguinData>? _remotePenguinData;
        private Dictionary<string, BoxPredictedDates>? _remoteBreedingDates;
        private Dictionary<string, BoxTag> _boxTags;

        // High value confirmation tracking - reset on each entry
        private DateTime doNotDisplayBefore;

        // Vibration and sound components
        private Vibrator? _vibrator;
        private MediaPlayer? _alertMediaPlayer;

        //multibox View
        private LinearLayout? _multiBoxViewCard;
        private LinearLayout? _breedingDatesCard;

        protected override void OnCreate(Bundle? savedInstanceState)
        {
            base.OnCreate(savedInstanceState);
            RequestPermissions();
            LoadFromAppDataDir();
            HandleAuthDeepLink(Intent);
            CreateUI();
            UpdateStatusText();
            _statusRefreshHandler = new Handler(Looper.MainLooper);
            _statusRefreshRunnable = new Java.Lang.Runnable(() =>
            {
                UpdateStatusText();
                _statusRefreshHandler?.PostDelayed(_statusRefreshRunnable, 1000);
            });
            _statusRefreshHandler.PostDelayed(_statusRefreshRunnable, 1000);
            HandleIncomingJsonIntent();
            if (_shouldAutoDownloadBirdStats)
            {
                new Handler(Looper.MainLooper).PostDelayed(() =>
                {
                    try { StartSync(silent: true); } catch { }
                }, 1500);
            }
        }
        protected override void OnResume()
        {
            base.OnResume();
            _statusRefreshHandler?.PostDelayed(_statusRefreshRunnable, 1000);
            var token = _appSettings?.AuthToken;
            if (!string.IsNullOrEmpty(token) && _colonyState?.LastSyncedUtc > DateTime.MinValue)
            {
                _dataStorageService.StartBackgroundPolling(token, () => DoSilentSync(token), () => { _lastSyncCheckUtc = DateTime.UtcNow; RunOnUiThread(() => { UpdateStatusText(); }); }, async () => { if (_colonyState?.PendingUploadCount > 0) { RunOnUiThread(() => TryBackgroundUpload()); } });
                _ = Task.Run(async () =>
                {
                    try
                    {
                        var result = await _dataStorageService.CheckForChangesAsync(token);
                        if (result != DataStorageService.PollResult.Failed)
                        {
                            _lastSyncCheckUtc = DateTime.UtcNow;
                            RunOnUiThread(() => { UpdateStatusText(); DrawPageLayouts(); });
                        }
                        if (result == DataStorageService.PollResult.Changed) await DoSilentSync(token);
                    }
                    catch { }
                });
            }
            UpdateStatusText();
        }

        protected override void OnPause()
        {
            base.OnPause();
            _statusRefreshHandler?.RemoveCallbacks(_statusRefreshRunnable);
            _dataStorageService.StopBackgroundPolling();
        }

        /// <summary>
        /// Silent background sync — download only, no UI dialogs, no upload.
        /// </summary>
        private async Task ApplyPostSync(DataStorageService.SyncResult result)
        {
            _remotePenguinData = await _dataStorageService.loadRemotePengInfoFromAppDataDir(this);
            _boxNotes = _dataStorageService.LoadBoxNotesFromDisk(this);
            if (result.BoxTags != null) _boxTags = result.BoxTags;
            _lastSyncCheckUtc = DateTime.UtcNow;
        }

        private async Task DoSilentSync(string token)
        {
            if (_dialogActive || !_isBoxLocked) return;
            try
            {
                var result = await _dataStorageService.SyncWithServer(this, _colonyState, _appSettings, _boxTags, _boxNamesAndIndexes?.Keys);
                await ApplyPostSync(result);
                new Handler(Looper.MainLooper).Post(() =>
                {
                    CreateBoxSetsDictionary();
                    if (_isBoxLocked)
                        DrawPageLayouts();
                    UpdateStatusText();
                });
            }
            catch (Exception ex)
            {
                new Handler(Looper.MainLooper).Post(() =>
                    Toast.MakeText(this, $"Background sync error: {ex.Message}", ToastLength.Short)?.Show());
            }
        }

        private void RequestPermissions()
        {
            InitializeVibrationAndSound();
            var permissions = new List<string>();

            // Always request READ_EXTERNAL_STORAGE for Android 6-12 (API 23-32)
            if (Android.OS.Build.VERSION.SdkInt >= Android.OS.BuildVersionCodes.M && 
                Android.OS.Build.VERSION.SdkInt <= Android.OS.BuildVersionCodes.S) // Changed from < R to <= S
            {
                permissions.Add(Android.Manifest.Permission.ReadExternalStorage);
            }

            if (OperatingSystem.IsAndroidVersionAtLeast(31))
            {
                permissions.AddRange(new[]
                {
                    Android.Manifest.Permission.BluetoothConnect,
                    Android.Manifest.Permission.BluetoothScan
                });
            }

            if (Android.OS.Build.VERSION.SdkInt >= Android.OS.BuildVersionCodes.Tiramisu)
            {
                // Android 13+ doesn't need WRITE_EXTERNAL_STORAGE for Downloads folder
            }
            else
            {
                permissions.Add(Android.Manifest.Permission.WriteExternalStorage);
            }

            permissions.AddRange(new[]
            {
                Android.Manifest.Permission.AccessFineLocation,
                Android.Manifest.Permission.AccessCoarseLocation,
                Android.Manifest.Permission.Internet
            });

            if (OperatingSystem.IsAndroidVersionAtLeast(23) && permissions.Count > 0)
            {
                // Check which permissions are not granted using native .NET Android API
                var permissionsToRequest = permissions.Where(p => 
                    CheckSelfPermission(p) != Android.Content.PM.Permission.Granted).ToArray();

                if (permissionsToRequest.Length > 0)
                {
                    System.Diagnostics.Debug.WriteLine($"Requesting permissions: {string.Join(", ", permissionsToRequest)}");
                    // Use native .NET Android API instead of AndroidX
                    RequestPermissions(permissionsToRequest, 1);
                }
                else
                {
                    // All permissions already granted
                    System.Diagnostics.Debug.WriteLine("All permissions already granted");
                    if (_appSettings?.IsBlueToothEnabled == true) InitializeGPS();
                }
            }
            else
            {
                // Pre-Android 6 or no permissions needed
                if (_appSettings?.IsBlueToothEnabled == true) InitializeGPS();
            }
        }
        private void InitializeVibrationAndSound()
        {
            try
            {
                // Initialize vibrator
                _vibrator = (Vibrator?)GetSystemService(VibratorService);

                // Initialize alert sound (using system notification sound)
                var notificationUri = Android.Media.RingtoneManager.GetDefaultUri(Android.Media.RingtoneType.Notification);
                if (notificationUri != null)
                {
                    var audioAttributesBuilder = new AudioAttributes.Builder();
                    var audioAttributes = audioAttributesBuilder?.SetUsage(AudioUsageKind.Alarm)
                                                                ?.SetContentType(AudioContentType.Sonification)
                                                                ?.Build();

                    _alertMediaPlayer = MediaPlayer.Create(this, notificationUri);
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
        }
        private void InitializeGPS()
        {
            _locationManager = (LocationManager?)GetSystemService(LocationService);
            if (_locationManager?.IsProviderEnabled(LocationManager.GpsProvider) != true &&
                _locationManager?.IsProviderEnabled(LocationManager.NetworkProvider) != true)
            {
                Toast.MakeText(this, "Please enable location services for accurate positioning", ToastLength.Short)?.Show();
                return;
            }
            if (CheckSelfPermission(Android.Manifest.Permission.AccessFineLocation) == Android.Content.PM.Permission.Granted)
            {
                _locationManager?.RequestLocationUpdates(LocationManager.GpsProvider, 1000, 1, this);
                _locationManager?.RequestLocationUpdates(LocationManager.NetworkProvider, 1000, 1, this);
            }
        }
        public void OnLocationChanged(Location location) // required by ILocationListener
        {
            // Only accept if more accurate than current fix (avoids Network provider overwriting GPS)
            if (_currentLocation == null || location.Accuracy <= _currentLocation.Accuracy
                || (DateTime.UtcNow - DateTimeOffset.FromUnixTimeMilliseconds(_currentLocation.Time).UtcDateTime).TotalSeconds > 10)
            {
                _currentLocation = location;
                _gpsAccuracy = location.Accuracy;
                UpdateStatusText();
            }
        }
        public void OnStatusChanged(string? provider, Availability status, Bundle? extras) { } // required by ILocationListener
        public void OnProviderDisabled(string provider) { } // required by ILocationListener
        public void OnProviderEnabled(string provider) { } // required by ILocationListener
        private void InitializeBluetooth()
        {
            var address = _appSettings.SelectedBluetoothDevice;
            if (string.IsNullOrEmpty(address))
            {
                UpdateStatusText("No scanner selected — choose one in Settings");
                return;
            }
            _bluetoothManager = new BluetoothManager();
            _bluetoothManager.StatusChanged += OnBluetoothStatusChanged;
            _bluetoothManager.EidDataReceived += OnEidDataReceived;
            if (_isBluetoothEnabledCheckBox.Checked)
                _ = _bluetoothManager.ConnectAsync(address);
        }
        private void OnBluetoothStatusChanged(string status)
        {
            RunOnUiThread(() => UpdateStatusText(status));
        }
        public void OnSwipePrevious()
        {
            // If viewing single box data, navigate to newer historical data
            // Navigate to previous box
            if (!_isBoxLocked)
            {
                Toast.MakeText(this, "Please lock the current box before navigating", ToastLength.Short)?.Show();
                return;
            }
            if (_currentBoxIndex > 1)
            {
                NavigateToBox(_currentBoxIndex - 1, () => _currentBoxIndex > 1);
            }
            else
            {
                Toast.MakeText(this, "Already at first box", ToastLength.Short)?.Show();
            }
        }
        public void OnSwipeNext()
        {
            // Navigate to next box
            if (!_isBoxLocked)
            {
                Toast.MakeText(this, "Please lock the current box before navigating", ToastLength.Short)?.Show();
                return;
            }
            if (_currentBoxIndex < _boxNamesAndIndexes.Count)
            {
                NavigateToBox(_currentBoxIndex + 1, () => _currentBoxIndex < _boxNamesAndIndexes.Count);
            }
            else
            {
                Toast.MakeText(this, "Already at last box", ToastLength.Short)?.Show();
            }
        }
        private void OnEidDataReceived(string eidData)
        {
            RunOnUiThread(() => HandleEidData(eidData));
        }

        private void HandleEidData(string eidData)
        {
            var cleanEid = new String(eidData.Where(char.IsLetterOrDigit).ToArray());

            // Box tag mode: route all scans to HandleBoxTagScan
            if (_appSettings.EditBoxTagsMode)
            {
                HandleBoxTagScan(cleanEid);
                return;
            }

            bool isBoxTag = BoxTagService.IsBoxTag(cleanEid);

            if (isBoxTag)
            {
                // Box tag scanned — navigate to box and flush any held scans
                HandleBoxTagScan(cleanEid);
                // Don't flush while a "forgot to lock" navigation is pending — those held scans
                // belong to the pending box and are replayed once the current box is locked.
                if (_heldScans.Count > 0 && _pendingBoxTagNavigation == null)
                    FlushHeldScansToCurrentBox();
                return;
            }

            if (_pendingBoxTagNavigation != null)
            {
                // The user scanned another box's tag before locking the current box.
                // Record penguin scans so they can be replayed into the pending box once it's locked —
                // unless the queue was frozen by a further box-tag scan, in which case ignore them.
                if (_pendingScanQueueFrozen)
                {
                    TriggerAlert();
                    Toast.MakeText(this, $"⚠️ Scan ignored — lock Box {_currentBoxName} first", ToastLength.Short)?.Show();
                    return;
                }
                if (!_heldScans.Any(s => s.BirdId == cleanEid))
                {
                    _heldScans.Add(new ScanRecord
                    {
                        BirdId = cleanEid,
                        Timestamp = DateTime.UtcNow,
                        Latitude = _currentLocation?.Latitude ?? 0,
                        Longitude = _currentLocation?.Longitude ?? 0,
                        Accuracy = _currentLocation?.Accuracy ?? -1
                    });
                }
                Toast.MakeText(this, $"Held — lock Box {_currentBoxName} to continue to Box {_pendingBoxTagNavigation}", ToastLength.Short)?.Show();
                return;
            }

            if (_isBoxLocked)
            {
                // Penguin chip scanned while locked — hold it, don't add to any box
                if (_heldScans.Any(s => s.BirdId == cleanEid))
                {
                    Toast.MakeText(this, $"Already held — {cleanEid}", ToastLength.Short)?.Show();
                    return;
                }
                var scanRecord = new ScanRecord
                {
                    BirdId = cleanEid,
                    Timestamp = DateTime.UtcNow,
                    Latitude = _currentLocation?.Latitude ?? 0,
                    Longitude = _currentLocation?.Longitude ?? 0,
                    Accuracy = _currentLocation?.Accuracy ?? -1
                };
                _heldScans.Add(scanRecord);
                TriggerAlert();
                ShowHeldScansDialog();
                return;
            }

            // Box is unlocked — normal scan flow
            if (selectedPage != UIFactory.selectedPage.BoxDataSingle)
                selectedPage = UIFactory.selectedPage.BoxDataSingle;

            AddScannedId(eidData, 0);
            _dataChangedSinceUnlock = true;
            DrawPageLayouts();
        }

        private void FlushHeldScansToCurrentBox()
        {
            if (_heldScans.Count == 0) return;

            _isBoxLocked = false;
            selectedPage = UIFactory.selectedPage.BoxDataSingle;
            if (_singleBoxDataContentLayout != null)
                _singleBoxDataContentLayout.Visibility = ViewStates.Visible;
            if (_boxNavigationButtonsLayout != null)
                _boxNavigationButtonsLayout.Visibility = ViewStates.Visible;

            var boxData = _colonyState.GetTodayForBox(_currentBoxName) ?? new BoxObservation { BoxName = _currentBoxName };
            int added = 0;
            foreach (var scan in _heldScans)
            {
                if (!boxData.ScannedIds.Any(s => s.BirdId == scan.BirdId))
                {
                    boxData.ScannedIds.Add(scan);
                    added++;
                }
            }
            if (added > 0)
            {
                boxData.IsPendingUpload = true;
                boxData.PendingUploadSinceUtc ??= DateTime.UtcNow;
                boxData.WhenDataCollectedUtc = DateTime.UtcNow;
                boxData.ObserverName = _appSettings.ObserverName;
                _colonyState.SaveBoxObservation(_currentBoxName, boxData);
                SaveToAppDataDir();
            }

            // Collect unknown scans for new bird dialog
            var unknownScans = new List<(string displayId, string fullId)>();
            foreach (var scan in _heldScans)
            {
                var key = scan.BirdId.ToUpper();
                var shortKey = scan.BirdId.Length >= 8 ? scan.BirdId.Substring(scan.BirdId.Length - 8).ToUpper() : key;
                bool known = _remotePenguinData != null &&
                    (_remotePenguinData.ContainsKey(key) || _remotePenguinData.ContainsKey(shortKey));
                if (!known)
                    unknownScans.Add((shortKey, scan.BirdId));
            }

            Toast.MakeText(this, $"📥 {added} scan{(added != 1 ? "s" : "")} added to Box {_currentBoxName}", ToastLength.Short)?.Show();
            _heldScans.Clear();
            _heldScansDialog?.Dismiss();
            _heldScansDialog = null;
            SetDialogActive(false);
            _dataChangedSinceUnlock = true;
            DrawPageLayouts();

            // Show new bird dialog for unknown scans (deferred to avoid dialog collision)
            if (unknownScans.Count > 0)
            {
                new Handler(Looper.MainLooper).PostDelayed(() =>
                {
                    ShowNewBirdDialog(unknownScans[0].displayId, unknownScans[0].fullId);
                }, 500);
            }
        }

        private void ShowHeldScansDialog()
        {
            try { _heldScansDialog?.Dismiss(); } catch { }
            _heldScansDialog = null;
            SetDialogActive(true);

            var layout = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };
            layout.SetPadding(24, 16, 24, 16);
            layout.SetBackgroundColor(Color.White);

            // Header: "Waiting:" followed by penguin mini badges
            var headerFlow = new PenguinMonitor.UI.FlowLayout(this);
            var density = Resources?.DisplayMetrics?.Density ?? 2;
            headerFlow.HorizontalSpacing = (int)(4 * density);
            headerFlow.VerticalSpacing = (int)(4 * density);
            var waitLabel = new TextView(this) { Text = "Waiting:", TextSize = 30 };
            waitLabel.SetTextColor(Color.Black);
            waitLabel.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            headerFlow.AddView(waitLabel);
            foreach (var scan in _heldScans)
                headerFlow.AddView(CreateScanBadge(scan.BirdId, textSize: 18));
            layout.AddView(headerFlow);

            var info = new TextView(this)
            {
                Text = "Scan a box tag or select a box below.",
                TextSize = 12
            };
            info.SetTextColor(Color.Black);
            info.SetPadding(0, 8, 0, 12);
            layout.AddView(info);

            var boxLabel = new TextView(this) { Text = "Assign to box:", TextSize = 13 };
            boxLabel.SetTextColor(Color.Black);
            boxLabel.SetPadding(0, 16, 0, 8);
            layout.AddView(boxLabel);

            var boxRow = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Horizontal };
            boxRow.SetPadding(0, 0, 0, 0);

            var btnMargin = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1);
            btnMargin.SetMargins((int)(4 * density), 0, (int)(4 * density), 0);

            var currentBtn = _uiFactory.CreateStyledButton($"Box {_currentBoxName}", UIFactory.PRIMARY_BLUE);
            currentBtn.Click += (s, e) =>
            {
                _isBoxLocked = false;
                FlushHeldScansToCurrentBox();
            };
            boxRow.AddView(currentBtn, btnMargin);

            var otherBtn = _uiFactory.CreateStyledButton("Select", UIFactory.PRIMARY_BLUE);
            otherBtn.Click += (s, e) =>
            {
                var input = new EditText(this) { Hint = "Box number", InputType = Android.Text.InputTypes.ClassText };
                new AlertDialog.Builder(this)
                    .SetTitle("Assign to box")
                    .SetView(input)
                    .SetPositiveButton("OK", (s2, e2) =>
                    {
                        var boxName = input.Text?.Trim() ?? "";
                        if (!string.IsNullOrEmpty(boxName) && _boxNamesAndIndexes.ContainsKey(boxName))
                        {
                            _currentBoxIndex = _boxNamesAndIndexes[boxName];
                            _currentBoxName = boxName;
                            _isBoxLocked = false;
                            FlushHeldScansToCurrentBox();
                        }
                        else
                        {
                            Toast.MakeText(this, $"Box {boxName} not found", ToastLength.Short)?.Show();
                        }
                    })
                    .SetNegativeButton("Cancel", (s2, e2) => { })
                    .Show();
            };
            boxRow.AddView(otherBtn, btnMargin);
            layout.AddView(boxRow);

            _heldScansDialog = new AlertDialog.Builder(this)
                .SetView(layout)
                .SetNegativeButton("Discard all", (s, e) =>
                {
                    _heldScans.Clear();
                    _heldScansDialog = null;
                    SetDialogActive(false);
                })
                .SetCancelable(false)
                .Create();

            _heldScansDialog.Show();
        }
        private static string FormatAccuracy(float accuracy)
        {
            if (accuracy >= 100) return $"{(int)accuracy}m";
            if (accuracy >= 10) return $"{accuracy:F0}m";
            return $"{accuracy:F1}m";
        }

        private static string FormatSyncAgo(DateTime lastSyncUtc)
        {
            if (lastSyncUtc <= DateTime.MinValue) return "never";
            var ago = DateTime.UtcNow - lastSyncUtc;
            if (ago.TotalSeconds < 60) return $"{(int)ago.TotalSeconds}s ago";
            if (ago.TotalMinutes < 60) return $"{(int)ago.TotalMinutes}m ago";
            if (ago.TotalHours < 24) return $"{(int)ago.TotalHours}h ago";
            return $"{(int)ago.TotalDays}d ago";
        }

        private void UpdateStatusText(string? bluetoothStatus = null)
        {
            // BT status
            string bt;
            if (_bluetoothManager == null)
                bt = "BT:off";
            else if (_bluetoothManager.IsConnected)
                bt = "BT🔗";
            else if (_bluetoothManager.IsConnecting)
                bt = "BT🔄";
            else
                bt = bluetoothStatus != null && bluetoothStatus.Contains("Retry") ? "BT🔄" : "BT:off";

            // GPS status
            string gps;
            if (_gpsAccuracy > 0)
                gps = $"📍{FormatAccuracy(_gpsAccuracy)}";
            else
                gps = "GPS:off";

            // Sync status — use most recent of full sync or successful poll check
            string sync;
            if (_colonyState != null && _colonyState.PendingUploadCount > 0)
            {
                var pendingNames = string.Join(",", _colonyState.PendingObservations.Where(p => p.IsPendingUpload).Select(p => p.BoxName));
                sync = $"Uploading:{_colonyState.PendingUploadCount} [{pendingNames}]";
            }
            else
            {
                var lastFull = _colonyState?.LastSyncedUtc ?? DateTime.MinValue;
                var mostRecent = _lastSyncCheckUtc > lastFull ? _lastSyncCheckUtc : lastFull;
                sync = $"sync:{FormatSyncAgo(mostRecent)}";
            }

            RunOnUiThread(() =>
            {
                if (_statusText != null)
                {
                    _statusText.Text = $"{bt}  {gps}  {sync}";

                    if (_bluetoothManager?.IsConnected == true && _gpsAccuracy > 0)
                        _statusText.SetTextColor(UIFactory.SUCCESS_GREEN);
                    else if (_bluetoothManager?.IsConnected == true)
                        _statusText.SetTextColor(UIFactory.WARNING_YELLOW);
                    else
                        _statusText.SetTextColor(UIFactory.TEXT_SECONDARY);
                }
            });
        }
        private void LoadJsonDataFromFile()
        {
            try
            {
                // Check permissions first
                if (!CheckExternalStoragePermissions())
                {
                    var sdkVersion = (int)Android.OS.Build.VERSION.SdkInt;

                    if (OperatingSystem.IsAndroidVersionAtLeast(30)) // Android 11+
                    {
                        Toast.MakeText(this, "⚠️ Android 11+ detected!\n\nFor file access, please:\n1. Go to Settings > Apps > PenguinMonitor\n2. Enable 'All files access'", ToastLength.Long)?.Show();

                        // Try to open the manage storage settings
                        try
                        {
                            var intent = new Intent(Android.Provider.Settings.ActionManageAppAllFilesAccessPermission);
                            intent.SetData(Android.Net.Uri.Parse("package:" + PackageName));
                            StartActivity(intent);
                        }
                        catch (Exception ex)
                        {
                            System.Diagnostics.Debug.WriteLine($"Failed to open storage settings: {ex.Message}");
                        }
                        return;
                    }
                    else
                    {
                        Toast.MakeText(this, "Storage permission required to load files. Please grant permission and try again.", ToastLength.Long)?.Show();

                        // Request permission if not granted (Android 6-10)
                        if (OperatingSystem.IsAndroidVersionAtLeast(23))
                        {
                            RequestPermissions(new string[] { Android.Manifest.Permission.ReadExternalStorage }, 2);
                        }
                        return;
                    }
                }
                var downloadsPath = Android.OS.Environment.GetExternalStoragePublicDirectory(Android.OS.Environment.DirectoryDownloads)?.AbsolutePath;
                if (string.IsNullOrEmpty(downloadsPath))
                {
                    Toast.MakeText(this, "Downloads directory not accessible", ToastLength.Long)?.Show();
                    return;
                }

                // Force media scanner to update Downloads folder
                try
                {
                    var intent = new Intent(Intent.ActionMediaScannerScanFile);
                    intent.SetData(Android.Net.Uri.FromFile(new Java.IO.File(downloadsPath)));
                    SendBroadcast(intent);

                    // Also try scanning the entire Downloads directory
                    var mediaScanIntent = new Intent(Intent.ActionMediaMounted);
                    mediaScanIntent.SetData(Android.Net.Uri.FromFile(new Java.IO.File(downloadsPath)));
                    SendBroadcast(mediaScanIntent);

                    // Give it a moment to scan
                    System.Threading.Thread.Sleep(500);
                }
                catch (Exception scanEx)
                {
                    System.Diagnostics.Debug.WriteLine($"Media scanner failed: {scanEx.Message}");
                }

                // Debug: Show what files are actually detected
                var allFiles = Directory.GetFiles(downloadsPath, "*", SearchOption.TopDirectoryOnly);
                System.Diagnostics.Debug.WriteLine($"Downloads path: {downloadsPath}");
                System.Diagnostics.Debug.WriteLine($"Total files found: {allFiles.Length}");

                var debugInfo = new System.Text.StringBuilder();
                debugInfo.AppendLine($"📂 Downloads: {allFiles.Length} files found");
                debugInfo.AppendLine($"🤖 Android API: {(int)Android.OS.Build.VERSION.SdkInt}");

                foreach (var file in allFiles.Take(10)) // Show first 10 files
                {
                    var fileInfo = new FileInfo(file);
                    System.Diagnostics.Debug.WriteLine($"File: {fileInfo.Name}, Size: {fileInfo.Length}, Created: {fileInfo.CreationTime}, LastWrite: {fileInfo.LastWriteTime}");
                    debugInfo.AppendLine($"• {fileInfo.Name} ({fileInfo.Length / 1024}KB)");
                }

                if (allFiles.Length > 10)
                {
                    debugInfo.AppendLine($"... and {allFiles.Length - 10} more files");
                }

                // Check permissions
                var hasReadPermission = CheckExternalStoragePermissions();
                debugInfo.AppendLine($"📋 Read Permission: {(hasReadPermission ? "✅ Granted" : "❌ Denied")}");

                // Toast the debug info to user
                Toast.MakeText(this, debugInfo.ToString(), ToastLength.Long)?.Show();

                // Look for JSON files (try multiple patterns)
                var jsonFiles = allFiles.Where(f => f.EndsWith(".json", StringComparison.OrdinalIgnoreCase)
                                            || f.EndsWith(".txt", StringComparison.OrdinalIgnoreCase)).ToArray();

                var files = jsonFiles
                    .OrderByDescending(f => File.GetLastWriteTime(f)) // Use LastWriteTime instead of CreationTime
                    .ToArray();

                if (files.Length == 0)
                {
                    var message = $"No JSON files found.\n\n" +
                                 $"📂 Total files: {allFiles.Length}\n" +
                                 $"📋 Permissions: {(hasReadPermission ? "✅" : "❌")}\n" +
                                 $"🤖 Android API: {(int)Android.OS.Build.VERSION.SdkInt}\n" +
                                 $"📁 Path: {downloadsPath}";

                    Toast.MakeText(this, message, ToastLength.Long)?.Show();
                    return;
                }
                // Show file selection dialog
                ShowFileSelectionDialog(files);
            }
            catch (Exception ex)
            {
                Toast.MakeText(this, $"❌ Failed to browse files: {ex.Message}", ToastLength.Long)?.Show();
                System.Diagnostics.Debug.WriteLine($"LoadJsonDataFromFile error: {ex}");
            }
        }
        private void ShowFileSelectionDialog(string[] files)
        {
            var fileNames = files.Select(f => 
            {
                var fileName = System.IO.Path.GetFileName(f);
                var fileInfo = new FileInfo(f);
                var fileSize = fileInfo.Length / 1024; // Size in KB
                var creationTime = fileInfo.CreationTime.ToString("MMM dd, HH:mm");
                return $"{fileName}\n{creationTime} • {fileSize} KB";
            }).ToArray();

            var builder = new AlertDialog.Builder(this);
            builder.SetTitle("Select JSON File to Load");
            
            builder.SetItems(fileNames, (sender, args) =>
            {
                var selectedFile = files[args.Which];
                var fileName = System.IO.Path.GetFileName(selectedFile);
                
                LoadJsonFileData(selectedFile);
            });

            builder.SetNegativeButton("Cancel", (sender, args) => { });
            
            var dialog = builder.Create();
            dialog?.Show();
        }
        private void LoadJsonFileData(string filePath)
        {
            var json = File.ReadAllText(filePath);
            LoadJsonData(json, System.IO.Path.GetFileName(filePath));
        }

        private void ExitHistoricalView()
        {
            _isHistoricalView = false;
            _historicalFilename = "";
            _historicalBoxes.Clear();

            // Re-enable bluetooth/GPS if setting is on
            if (_appSettings?.IsBlueToothEnabled == true)
            {
                InitializeBluetooth();
                InitializeGPS();
            }

            _isBoxLocked = true;
            CreateBoxSetsDictionary();
            if (_boxNamesAndIndexes.Count > 0)
                JumpToBox(_boxNamesAndIndexes.First().Key);
            DrawPageLayouts();
            UpdateStatusText();
        }

        /// <summary>
        /// Get the box observation to display for a given box name.
        /// In historical view, returns from _historicalBoxes. Otherwise from colony state.
        /// </summary>
        private BoxObservation? GetDisplayBoxData(string boxName)
        {
            if (_isHistoricalView)
                return _historicalBoxes.TryGetValue(boxName, out var hb) ? hb : null;
            return _colonyState.GetTodayForBox(boxName);
        }

        private void LoadJsonData(string json, string filename="")
        {
            try
            {
                var loadedData = JToken.Parse(json);

                int boxCount = 0;
                int birdCount = 0;

                if (loadedData == null)
                {
                    Toast.MakeText(this, "❌ Invalid JSON file format", ToastLength.Long)?.Show();
                    return;
                }
                if (loadedData["BoxData"] == null)
                {
                    Toast.MakeText(this, "❌ No box data found in JSON file", ToastLength.Long)?.Show();
                    return;
                }

                _historicalFilename = filename.Replace("PenguinMonitor", "").Replace("Nestcheck", "").Trim();
                _isHistoricalView = true;
                _historicalBoxes.Clear();

                // Disable bluetooth/GPS temporarily
                _bluetoothManager?.Dispose();
                _bluetoothManager = null;
                _locationManager?.RemoveUpdates(this);
                _gpsAccuracy = -1;

                var boxDatas = loadedData["BoxData"] as JObject;
                foreach (var boxItem in boxDatas)
                {
                    string boxName = boxItem.Key;
                    var dataNode = boxItem.Value;
                    var boxData = new BoxObservation
                    {
                        Adults = dataNode["Adults"]?.Value<int>() ?? 0,
                        Eggs = dataNode["Eggs"]?.Value<int>() ?? 0,
                        Chicks = dataNode["Chicks"]?.Value<int>() ?? 0,
                        GateStatus = (dataNode["GateStatus"]?.Value<string>() ?? "").Replace("gate up", "Gate up").Replace("regate", "Regate"),
                        BreedingStatus = dataNode["BreedingChance"]?.Value<string>(),
                        Notes = dataNode["Notes"]?.Value<string>() ?? "",
                        WhenDataCollectedUtc = dataNode["whenDataCollectedUtc"]?.Value<DateTime>().ToUniversalTime() ?? DateTime.MinValue.ToUniversalTime(),
                        IsPendingUpload = false,
                        BoxName = boxName,
                    };
                    var scannedIdsNode = dataNode["ScannedIds"];
                    if (scannedIdsNode != null)
                    {
                        foreach (var scanItem in scannedIdsNode)
                        {
                            boxData.ScannedIds.Add(new ScanRecord
                            {
                                BirdId = scanItem?["BirdId"]?.Value<string>() ?? "",
                                Timestamp = scanItem?["Timestamp"]?.Value<DateTime>() ?? DateTime.UtcNow,
                                Latitude = scanItem?["Latitude"]?.Value<double>() ?? 0,
                                Longitude = scanItem?["Longitude"]?.Value<double>() ?? 0,
                                Accuracy = scanItem?["Accuracy"]?.Value<float>() ?? -1
                            });
                            birdCount++;
                        }
                    }
                    _historicalBoxes[boxName] = boxData;
                    boxCount++;
                }

                _isBoxLocked = true;
                DrawPageLayouts();
                UpdateStatusText();

                Toast.MakeText(this, $"📂 Viewing {boxCount} boxes, {birdCount} birds", ToastLength.Short)?.Show();
            }
            catch (Exception ex)
            {
                Toast.MakeText(this, $"❌ Failed to load JSON: {ex.Message}", ToastLength.Long)?.Show();
            }
        }
        private void ShowBoxDataSummary()
        {
            if (_colonyState.TodayBoxes.Count == 0 && _colonyState.PendingObservations.Count == 0 && _colonyState.PreviousBoxes.Count == 0)
                Toast.MakeText(this, "No boxes with data", ToastLength.Short)?.Show();
            else
                ShowConfirmationDialog(
                    "📊 Today's Statistics",
                    GetSummaryText(),
                    ("OK", () => { }),
                    null);
        }
        private string GetSummaryText()
        {
            var todayBoxes = _isHistoricalView
                ? _historicalBoxes
                : new Dictionary<string, BoxObservation>(_colonyState.TodayBoxes);
            if (!_isHistoricalView)
            {
                var nzToday = NzToday;
                foreach (var obs in _colonyState.PendingObservations)
                {
                    if (!string.IsNullOrEmpty(obs.BoxName) && ToNzTime(obs.WhenDataCollectedUtc).Date == nzToday)
                        todayBoxes[obs.BoxName] = obs;
                }
            }

            var totalScannedBirds = todayBoxes.Values.Sum(box => box.ScannedIds.Count(s => !s.BirdId.StartsWith("NOSCAN_")));
            var totalNoScans = todayBoxes.Values.Sum(box => box.ScannedIds.Count(s => s.BirdId.StartsWith("NOSCAN_")));
            var totalAdults = todayBoxes.Values.Sum(box => box.Adults);
            var totalEggs = todayBoxes.Values.Sum(box => box.Eggs);
            var totalChicks = todayBoxes.Values.Sum(box => box.Chicks);
            var gateUpCount = todayBoxes.Values.Count(box => box.GateStatus == "Gate up");
            var regateCount = todayBoxes.Values.Count(box => box.GateStatus == "Regate");
            var adultMismatch = totalAdults - totalNoScans - totalScannedBirds;

            var pending = _colonyState.PendingUploadCount;

            string summary = $"📦 {todayBoxes.Count} boxes today\n" +
                         (pending > 0 ? $"⏳ {pending} boxes pending upload\n" : "") +
                         $"🐧 {totalScannedBirds} bird scans" + (totalNoScans > 0 ? $" + {totalNoScans} no-scan" : "") + "\n" +
                         $"👥 {totalAdults} adults\n" +
                         $"🥚 {totalEggs} eggs\n" +
                         $"🐣 {totalChicks} chicks\n" +
                         $"🚪 Gate: {gateUpCount} up, {regateCount} regate";
            return summary;
        }
        private bool _isDownloadingCsvData = false;
        private void OnSyncClick(object? sender, EventArgs e) => StartSync(silent: false);

        private void StartSync(bool silent = false)
        {
            if (_isDownloadingCsvData)
                return;

            _isDownloadingCsvData = true;
            UpdateStatusText("Syncing...");
            if (_syncButton != null)
            {
                _syncButton.Text = "Sync";
                _syncButton.Background = _uiFactory.CreateRoundedBackground(UIFactory.WARNING_YELLOW, 8);
                _syncButton.Enabled = false;
            }

            // Show sync dialog — transitions from progress to results
            var progressMessages = new[] { "📦 Boxes...", "🐧 Penguins...", "📍 Tags..." };
            var cancelled = false;
            AlertDialog? syncDialog = null;

            if (!silent)
            {
                syncDialog = new AlertDialog.Builder(this)
                    .SetTitle("Syncing")
                    .SetMessage(string.Join("\n", progressMessages))
                    .SetNegativeButton("Cancel", (s, e) => { cancelled = true; })
                    .SetCancelable(false)
                    .Create();
                syncDialog?.Show();
            }

            _ = Task.Run(async () =>
            {
                DataStorageService.SyncResult result;
                try
                {
                    result = await _dataStorageService.SyncWithServer(this, _colonyState, _appSettings, _boxTags, _boxNamesAndIndexes?.Keys,
                        onLineProgress: (lineIndex, status) =>
                        {
                            if (lineIndex >= 0 && lineIndex < progressMessages.Length)
                            {
                                var icon = lineIndex == 0 ? "📦" : lineIndex == 1 ? "🐧" : "📍";
                                progressMessages[lineIndex] = $"{icon} {status}";
                            }
                            RunOnUiThread(() => syncDialog?.SetMessage(string.Join("\n", progressMessages)));
                        },
                        isCancelled: () => cancelled);

                    await ApplyPostSync(result);
                }
                catch (Exception ex)
                {
                    result = new DataStorageService.SyncResult { Error = ex.Message };
                }

                new Handler(Looper.MainLooper).Post(() =>
                {
                    _isDownloadingCsvData = false;
                    if (_syncButton != null)
                    {
                        _syncButton.Text = "Sync";
                        _syncButton.Background = _uiFactory.CreateRoundedBackground(UIFactory.PRIMARY_BLUE, 8);
                        _syncButton.Enabled = true;
                    }
                    CreateBoxSetsDictionary();
                    DrawPageLayouts();

                    if (_colonyState.GetTodayForBox(_currentBoxName) != null)
                        buildScannedIdsLayout(_colonyState.GetTodayForBox(_currentBoxName).ScannedIds);

                    // Start background polling after successful sync
                    if (result.Error == null && !result.AuthFailed)
                    {
                        var token = _appSettings?.AuthToken;
                        if (!string.IsNullOrEmpty(token))
                            _dataStorageService.StartBackgroundPolling(token, () => DoSilentSync(token), () => { _lastSyncCheckUtc = DateTime.UtcNow; RunOnUiThread(() => { UpdateStatusText(); }); }, async () => { if (_colonyState?.PendingUploadCount > 0) { RunOnUiThread(() => TryBackgroundUpload()); } });
                    }

                    if (syncDialog != null)
                    {
                        if (cancelled)
                        {
                            syncDialog.Dismiss();
                        }
                        else
                        {
                            bool hasErrors = !string.IsNullOrEmpty(result.Error) || result.TagSyncResult?.Error != null || result.UploadErrors > 0;
                            syncDialog.SetTitle(hasErrors ? "Sync — Partial" : "Synced");
                            var okBtn = syncDialog.GetButton((int)Android.Content.DialogButtonType.Negative);
                            if (okBtn != null) okBtn.Text = "OK";
                        }
                    }

                    if (result.Conflicts != null && result.Conflicts.Count > 0)
                    {
                        syncDialog?.Dismiss();
                        ShowConflictDialog(result.Conflicts);
                    }

                    if (result.AuthFailed)
                    {
                        syncDialog?.Dismiss();
                        ShowLoginPrompt();
                    }
                });
            });
        }


        /// <summary>
        /// Build a styled comparison dialog with server (orange) and local (black) cards.
        /// Uses app design language: card backgrounds, styled buttons.
        /// </summary>
        private void ShowComparisonDialog(string title, BoxObservation serverObs, BoxObservation localObs, Action onReplace, Action onDiscard)
        {
            SetDialogActive(true);
            var outerCard = _uiFactory.CreateCard(padding: 16);
            outerCard.SetGravity(GravityFlags.Top);

            // Title
            var titleView = new TextView(this) { Text = title, TextSize = 20 };
            titleView.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            titleView.SetTextColor(UIFactory.TEXT_PRIMARY);
            titleView.SetPadding(0, 0, 0, 12);
            outerCard.AddView(titleView);

            // Server version (orange card)
            var serverLabel = new TextView(this) { Text = "Current (server)", TextSize = 12 };
            serverLabel.SetTextColor(UIFactory.TEXT_SECONDARY);
            outerCard.AddView(serverLabel);

            var serverCard = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };
            serverCard.SetPadding(12, 8, 12, 8);
            serverCard.Background = _uiFactory.CreateCardBackground(borderWidth: 4, borderColour: UIFactory.WARNING_YELLOW);
            var serverParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            serverParams.SetMargins(0, 4, 0, 8);
            serverCard.LayoutParameters = serverParams;
            serverCard.AddView(BuildObsDetailView(serverObs, showBoxLink: false));
            outerCard.AddView(serverCard);

            // Arrow
            var arrow = new TextView(this) { Text = "▼", TextSize = 18, Gravity = GravityFlags.Center };
            arrow.SetTextColor(UIFactory.TEXT_SECONDARY);
            arrow.LayoutParameters = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            outerCard.AddView(arrow);

            // Local version (black card)
            var localLabel = new TextView(this) { Text = "Your edit", TextSize = 12 };
            localLabel.SetTextColor(UIFactory.TEXT_SECONDARY);
            localLabel.SetPadding(0, 4, 0, 0);
            outerCard.AddView(localLabel);

            var localCard = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };
            localCard.SetPadding(12, 8, 12, 8);
            localCard.Background = _uiFactory.CreateCardBackground(borderWidth: 4, borderColour: Color.Black);
            var localParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            localParams.SetMargins(0, 4, 0, 16);
            localCard.LayoutParameters = localParams;
            localCard.AddView(BuildObsDetailView(localObs, showBoxLink: false));
            outerCard.AddView(localCard);

            // Button row
            var buttonRow = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Horizontal };
            buttonRow.SetGravity(GravityFlags.Center);
            var buttonRowParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            buttonRow.LayoutParameters = buttonRowParams;

            var discardButton = _uiFactory.CreateStyledButton("Discard", UIFactory.DANGER_RED);
            discardButton.LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1f);
            ((LinearLayout.LayoutParams)discardButton.LayoutParameters).SetMargins(0, 0, 8, 0);

            var replaceButton = _uiFactory.CreateStyledButton("Replace", UIFactory.PRIMARY_BLUE);
            replaceButton.LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1f);
            ((LinearLayout.LayoutParams)replaceButton.LayoutParameters).SetMargins(8, 0, 0, 0);

            buttonRow.AddView(discardButton);
            buttonRow.AddView(replaceButton);
            outerCard.AddView(buttonRow);

            var scrollView = new ScrollView(this);
            scrollView.AddView(outerCard);

            var dialog = new AlertDialog.Builder(this)
                .SetView(scrollView)
                .SetCancelable(false)
                .Create();

            discardButton.Click += (s, e) => { dialog?.Dismiss(); SetDialogActive(false); onDiscard(); };
            replaceButton.Click += (s, e) => { dialog?.Dismiss(); SetDialogActive(false); onReplace(); };
            dialog?.Show();
        }

        private void ShowConflictDialog(List<DataStorageService.SyncConflict> conflicts)
        {
            // Filter out conflicts where server data hasn't changed since local confirmation
            conflicts = conflicts.Where(c =>
            {
                var boxName = c.box_name ?? "";
                if (_confirmedAgainstServerObsId.TryGetValue(boxName, out int confirmedId)
                    && c.server != null && c.server.observation_id == confirmedId)
                {
                    _confirmedAgainstServerObsId.Remove(boxName);
                    return false;
                }
                return true;
            }).ToList();

            // Deduplicate by box name — keep only the latest conflict per box
            var seen = new HashSet<string>();
            conflicts = conflicts.Where(c => seen.Add(c.box_name ?? "")).ToList();

            if (conflicts.Count == 0) return;

            // Show one dialog per conflict (sequential)
            void ShowNext(int idx)
            {
                if (idx >= conflicts.Count) return;
                var conflict = conflicts[idx];
                var boxName = conflict.box_name ?? "?";
                var server = conflict.server;

                BoxObservation serverObs = null;
                if (server != null)
                {
                    serverObs = BoxObservation.FromServerData(
                        server.observation_id, 0, server.observation_time_utc ?? "",
                        server.adults, server.eggs, server.chicks,
                        server.breeding_status, server.gate_status, server.notes ?? "", server.monitor_filename,
                        server.observer_name);
                    serverObs.BoxName = boxName;
                    if (server.scans != null)
                        foreach (var scan in server.scans)
                            serverObs.ScannedIds.Add(new ScanRecord { BirdId = scan.pit_id ?? "" });
                }

                var local = _colonyState.PendingObservations.FirstOrDefault(p => p.BoxName == boxName && p.IsPendingUpload);
                if (serverObs == null || local == null) { ShowNext(idx + 1); return; }

                ShowComparisonDialog($"Confirm edit: Box {boxName}", serverObs, local,
                    onReplace: () =>
                    {
                        _ = Task.Run(async () =>
                        {
                            await _dataStorageService.UploadConfirmedEdits(_colonyState, _appSettings, new List<string> { boxName });
                            new Handler(Looper.MainLooper).Post(() =>
                            {
                                DataStorageService.SaveColonyState(this, _colonyState);
                                UpdateSyncButtonLabel();
                                DrawPageLayouts();
                                ShowNext(idx + 1);
                            });
                        });
                    },
                    onDiscard: () =>
                    {
                        _colonyState.PendingObservations.RemoveAll(p => p.BoxName == boxName && p.IsPendingUpload);
                        if (server != null)
                        {
                            var restored = BoxObservation.FromServerData(
                                server.observation_id, 0, server.observation_time_utc ?? "",
                                server.adults, server.eggs, server.chicks,
                                server.breeding_status, server.gate_status,
                                server.notes ?? "", server.monitor_filename, server.observer_name);
                            restored.BoxName = boxName;
                            if (server.scans != null)
                                foreach (var scan in server.scans)
                                    restored.ScannedIds.Add(new ScanRecord { BirdId = scan.pit_id ?? "" });
                            restored.IsPendingUpload = false;
                            _colonyState.TodayBoxes[boxName] = restored;
                        }
                        DataStorageService.SaveColonyState(this, _colonyState);
                        UpdateSyncButtonLabel();
                        DrawPageLayouts();
                        ShowNext(idx + 1);
                    });
            }
            ShowNext(0);
        }

        private void ShowLoginPrompt()
        {
            new AlertDialog.Builder(this)
                .SetTitle("Login Required")
                .SetMessage("Connect your Wildwatch account to sync data.")
                .SetPositiveButton("Login", (s, e) => {
                    StartActivity(new Android.Content.Intent(Android.Content.Intent.ActionView,
                        Android.Net.Uri.Parse($"{DataStorageService.WILDWATCH_BASE_URL}/auth.php")));
                })
                .SetNegativeButton("Cancel", (s, e) => { })
                .Show();
        }
        private void CreateUI()
        {
            _uiFactory = new UIFactory(this);
            selectedPage = UIFactory.selectedPage.BoxDataSingle;
            _isBoxLocked = true;
            _rootScrollView = new ScrollView(this);
            _rootScrollView.SetBackgroundColor(UIFactory.LIGHT_GRAY);

            // Initialize gesture detector and apply to ScrollView
            _gestureDetector = new GestureDetector(this, new SwipeGestureDetector(this));
            _rootScrollView.Touch += OnScrollViewTouch;

            var parentLinearLayout = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };

            var headerStatusSettingsCard = _uiFactory.CreateCard(padding: 12);
            headerStatusSettingsCard.Background = _uiFactory.CreateCardBackground(borderWidth: 4);            

            _titleCard = _uiFactory.CreateCard(Android.Widget.Orientation.Horizontal, padding: 0, borderWidth: 0);
            var titleCard = _titleCard;
            titleCard.SetGravity(GravityFlags.Center);

            _expandSettingsButton = new ImageButton(this)
            {
                LayoutParameters = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent)
            };
            var expandSettingsImageButton = _expandSettingsButton;
            expandSettingsImageButton.SetImageResource(Resource.Drawable.unfold);
            expandSettingsImageButton.SetBackgroundColor(Color.Transparent);
            expandSettingsImageButton.Click += (s,e) => {
                if (_settingsCard.Visibility == ViewStates.Gone)
                {
                    _settingsCard.Visibility = ViewStates.Visible;
                    expandSettingsImageButton.SetImageResource(Resource.Drawable.fold);
                }
                else
                {
                    _settingsCard.Visibility = ViewStates.Gone;
                    expandSettingsImageButton.SetImageResource(Resource.Drawable.unfold);
                }
            };
            titleCard.AddView(expandSettingsImageButton);

            // Add a spacer that expands to fill available space
            var spacer = new View(this);
            spacer.LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MatchParent, 3f);
            titleCard.AddView(spacer);

            ImageView iconView = new ImageView(this);
            iconView.SetPadding(0, 0, 0, 0);
            iconView.SetImageResource(Resource.Mipmap.appicon);
            iconView.ScaleX = iconView.ScaleY = 0.8f;
            titleCard.AddView(iconView);

            var spacer1 = new View(this);
            spacer1.LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MatchParent, 1f);
            titleCard.AddView(spacer1);

            _appTitleText = new TextView(this)
            {
                Text = "Penguin Nestcheck",
                TextSize = 28,
                Gravity = GravityFlags.Center
            };
            _appTitleText.SetPadding(0, 0, 50, 0);
            _appTitleText.SetTextColor(UIFactory.PRIMARY_BLUE);
            _appTitleText.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            titleCard.AddView(_appTitleText);

            var spacer2 = new View(this);
            spacer2.LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MatchParent, 7f);
            titleCard.AddView(spacer2);

            headerStatusSettingsCard.AddView(titleCard);

            _statusText = new TextView(this)
            {
                TextSize = 14,
                Gravity = GravityFlags.Center
            };
            _statusText.SetTextColor(UIFactory.TEXT_SECONDARY);
            var statusParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            statusParams.SetMargins(0, -12, 0, 0);
            _statusText.LayoutParameters = statusParams;

            headerStatusSettingsCard.AddView(_statusText);

            // Exit historical view button (hidden by default)
            _exitHistoricalButton = new Button(this) { Text = "Exit Historical View", TextSize = 14 };
            _exitHistoricalButton.SetTextColor(Color.Black);
            _exitHistoricalButton.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            _exitHistoricalButton.Background = _uiFactory.CreateRoundedBackground(UIFactory.WARNING_YELLOW, 8);
            _exitHistoricalButton.SetAllCaps(false);
            var exitHistParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            exitHistParams.SetMargins(8, 4, 8, 4);
            _exitHistoricalButton.LayoutParameters = exitHistParams;
            _exitHistoricalButton.Visibility = ViewStates.Gone;
            _exitHistoricalButton.Click += (s, e) => ExitHistoricalView();
            headerStatusSettingsCard.AddView(_exitHistoricalButton);

            //Settings Card
            createSettingsCard();
            headerStatusSettingsCard.AddView(_settingsCard);
            CreateBoxSetsDictionary();

            // Daily label warning (below buttons, visible even when settings collapsed)
            _standaloneDailyLabelWarning = new TextView(this)
            {
                Text = "⚠ Daily label is not set — open Settings to set it",
                TextSize = 13,
            };
            _standaloneDailyLabelWarning.SetTextColor(UIFactory.DANGER_RED);
            _standaloneDailyLabelWarning.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            _standaloneDailyLabelWarning.SetPadding(16, 8, 16, 8);
            _standaloneDailyLabelWarning.Gravity = GravityFlags.Center;
            _standaloneDailyLabelWarning.Visibility = ViewStates.Gone;
            headerStatusSettingsCard.AddView(_standaloneDailyLabelWarning);

            parentLinearLayout.AddView(headerStatusSettingsCard);

           // Data card
            CreateBoxDataCard();

            //Create Multi box view card
            _multiBoxViewCard = _uiFactory.CreateCard();
            _multiBoxViewCard.Visibility = ViewStates.Visible;

            //Create Breeding dates card
            _breedingDatesCard = _uiFactory.CreateCard();
            _breedingDatesCard.Visibility = ViewStates.Visible;

            parentLinearLayout.AddView(_singleBoxDataOuterLayout);
            parentLinearLayout.AddView(_multiBoxViewCard);
            parentLinearLayout.AddView(_breedingDatesCard);

            _rootScrollView.AddView(parentLinearLayout);
            SetContentView(_rootScrollView);

            _rootScrollView.SetOnApplyWindowInsetsListener(new ViewInsetsListener());

           JumpToBox(_boxNamesAndIndexes.First().Key); //Contains DrawPageLayouts()
        }
        /// <summary>
        /// designed to create _boxNamesAndIndexes to map box names to indexes which can be used 
        /// to navigate boxes
        /// 
        /// example 1 BoxSetString value: {1-150,AA-AC}
        /// example 2 BoxSetString value: {N1-N6}
        /// example 3 BoxSetString value: {1-150,AA-AC},{N1-N6}
        /// </summary>
        private void CreateBoxSetsDictionary()
        {
            string setString;
            if (string.IsNullOrWhiteSpace(_appSettings.AllBoxSetsString))
            {
                _appSettings.AllBoxSetsString = "{0-150,AA-AC}";
                _appSettings.BoxSetString = "All";
            }
            setString = string.IsNullOrWhiteSpace(_appSettings.BoxSetString) || _appSettings.BoxSetString.ToLower() == "all"
                ? _appSettings.AllBoxSetsString : _appSettings.BoxSetString;

            _boxNamesAndIndexes = new Dictionary<string, int>();
            if (!string.IsNullOrWhiteSpace(setString))
            {
                _boxNamesAndIndexes.Clear();
                int currentIndex = 1;

                foreach (string boxSetString in setString.Split(new string[] { "}{", "},{" }, StringSplitOptions.RemoveEmptyEntries))
                {
                    // Remove curly braces
                    string cleanedSet = boxSetString.Trim('{', '}');

                    foreach (string boxSetPart in cleanedSet.Split(',', StringSplitOptions.RemoveEmptyEntries))
                    {
                        string trimmedPart = boxSetPart.Trim();

                        if (trimmedPart.Contains('-'))
                        {
                            // Handle ranges like "1-150", "AA-AC", "N1-N6"
                            var rangeParts = trimmedPart.Split('-');
                            if (rangeParts.Length == 2)
                            {
                                string start = rangeParts[0].Trim();
                                string end = rangeParts[1].Trim();

                                // Check if it's a numeric range (e.g., "1-150")
                                if (int.TryParse(start, out int startNum) && int.TryParse(end, out int endNum))
                                {
                                    for (int i = startNum; i <= endNum; i++)
                                    {
                                        _boxNamesAndIndexes[i.ToString()] = currentIndex++;
                                    }
                                }
                                else
                                {
                                    // Handle alphanumeric ranges (e.g., "AA-AC", "N1-N6")
                                    var expandedRange = ExpandAlphanumericRange(start, end);
                                    foreach (string boxName in expandedRange)
                                    {
                                        _boxNamesAndIndexes[boxName.ToUpper()] = currentIndex++;
                                    }
                                }
                            }
                        }
                        else
                        {
                            // Single box name/number
                            _boxNamesAndIndexes[trimmedPart.ToUpper()] = currentIndex++;
                        }
                    }
                }
            }
            if (_boxNamesAndIndexes.Count > 1000)
                _boxNamesAndIndexes = _boxNamesAndIndexes.Take(1000).ToDictionary(kvp => kvp.Key, kvp => kvp.Value);

            if (_boxNamesAndIndexes.Count == 0)
                _boxNamesAndIndexes.Add("fake", 1);
        }

        /// <summary>
        /// Expands alphanumeric ranges like "AA-AC" or "N1-N6"
        /// </summary>
        private List<string> ExpandAlphanumericRange(string start, string end)
        {
            var result = new List<string>();

            // Extract prefix and numeric suffix
            var startMatch = Regex.Match(start, @"^([A-Za-z]*)(\d*)$");
            var endMatch = Regex.Match(end, @"^([A-Za-z]*)(\d*)$");

            if (!startMatch.Success || !endMatch.Success)
            {
                // If pattern doesn't match, just add both as individual items
                result.Add(start);
                result.Add(end);
                return result;
            }

            string startPrefix = startMatch.Groups[1].Value;
            string endPrefix = endMatch.Groups[1].Value;
            string startNumStr = startMatch.Groups[2].Value;
            string endNumStr = endMatch.Groups[2].Value;

            // Case 1: Pure alphabetic range (e.g., "AA-AC")
            if (string.IsNullOrEmpty(startNumStr) && string.IsNullOrEmpty(endNumStr) &&
                startPrefix.Length == endPrefix.Length)
            {
                result.AddRange(ExpandAlphabeticRange(startPrefix, endPrefix));
            }
            // Case 2: Same prefix with numeric range (e.g., "N1-N6")
            else if (startPrefix == endPrefix &&
                     int.TryParse(startNumStr, out int startNum) &&
                     int.TryParse(endNumStr, out int endNum))
            {
                for (int i = startNum; i <= endNum; i++)
                {
                    result.Add(startPrefix + i.ToString());
                }
            }
            else
            {
                // Fallback: add both as individual items
                result.Add(start);
                result.Add(end);
            }

            return result;
        }

        /// <summary>
        /// Expands purely alphabetic ranges like "AA-AC"
        /// </summary>
        private List<string> ExpandAlphabeticRange(string start, string end)
        {
            var result = new List<string>();

            if (start.Length != end.Length)
            {
                result.Add(start);
                result.Add(end);
                return result;
            }

            // Convert to base-26 numbers for easier iteration
            int startValue = AlphaToNumber(start);
            int endValue = AlphaToNumber(end);

            for (int i = startValue; i <= endValue; i++)
            {
                result.Add(NumberToAlpha(i, start.Length));
            }

            return result;
        }

        /// <summary>
        /// Convert alphabetic string to number (A=0, B=1, ..., Z=25, AA=26, etc.)
        /// </summary>
        private int AlphaToNumber(string alpha)
        {
            int result = 0;
            for (int i = 0; i < alpha.Length; i++)
            {
                result = result * 26 + (char.ToUpper(alpha[i]) - 'A');
            }
            return result;
        }

        /// <summary>
        /// Convert number back to alphabetic string of specified length
        /// </summary>
        private string NumberToAlpha(int number, int length)
        {
            string result = "";
            for (int i = 0; i < length; i++)
            {
                result = (char)('A' + (number % 26)) + result;
                number /= 26;
            }
            return result;
        }
        private void createMultiBoxViewCard()
        {
            _multiBoxViewCard.RemoveAllViews();

            var OverviewHeaderCard = _uiFactory.CreateCard(
                Android.Widget.Orientation.Vertical,
                borderWidth: _appSettings.ActiveSessionTimeStampActive ? 6 : 4,
                borderColour: _appSettings.ActiveSessionTimeStampActive ? UIFactory.DANGER_RED : null);
            OverviewHeaderCard.LayoutParameters = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);

            LinearLayout headerTitle = new LinearLayout(this);

            var showFiltersButton = new ImageButton(this);
            showFiltersButton.LayoutParameters = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent);
            showFiltersButton.SetPadding(0, 0, 0, 0);
            showFiltersButton.SetImageResource(_appSettings.ShowMultiboxFilterCard ? Resource.Drawable.fold : Resource.Drawable.unfold);
            showFiltersButton.SetBackgroundColor(Color.Transparent);
            showFiltersButton.Click += (sender, e) =>
            {
                _appSettings.ShowMultiboxFilterCard = !_appSettings.ShowMultiboxFilterCard;
                DrawPageLayouts();
            };
            headerTitle.AddView(showFiltersButton);

            TextView multiBoxTitle = new TextView(this)
            {
                Text = "Overview",
                TextSize = 30,
                Gravity = GravityFlags.Left
            };
            multiBoxTitle.LayoutParameters = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent);
            multiBoxTitle.SetTextColor(Color.Black);
            multiBoxTitle.SetTypeface(Typeface.DefaultBold, TypefaceStyle.Normal);
            multiBoxTitle.SetPadding(0, 0, 0, 0);
            headerTitle.AddView(multiBoxTitle);

            // Add a spacer that expands to fill available space
            var spacer = new View(this);
            spacer.LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MatchParent, 1f);
            headerTitle.AddView(spacer);

            TextView timeTV = new TextView(this)
            {
                TextSize = 14,
            };
            var pending = _colonyState.PendingUploadCount;
            timeTV.Text = !string.IsNullOrEmpty(_colonyState.DailyLabel) ? _colonyState.DailyLabel : "";
            var lastFullSync = _colonyState.LastSyncedUtc;
            var mostRecentCheck = _lastSyncCheckUtc > lastFullSync ? _lastSyncCheckUtc : lastFullSync;
            if (mostRecentCheck > DateTime.MinValue)
            {
                var syncNz = ToNzTime(mostRecentCheck);
                var syncLabel = syncNz.Date == NzToday ? $"{syncNz:HH:mm}" : $"{syncNz:d MMM HH:mm}";
                timeTV.Text += $"\nSynced {syncLabel}";
            }
            if (pending > 0)
                timeTV.Text += $"\n⏳ {pending} pending upload";

            timeTV.Text = timeTV.Text.Trim();
            timeTV.SetTextColor(Color.Black);
            timeTV.SetPadding(0, 0, 0, 0);
            timeTV.Gravity = GravityFlags.Right | GravityFlags.Top;
            timeTV.LayoutParameters = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.MatchParent);
            headerTitle.AddView(timeTV);

            OverviewHeaderCard.AddView(headerTitle);

            // Adult count mismatch warning — right under header
            {
                var todayBoxes2 = new Dictionary<string, BoxObservation>(_colonyState.TodayBoxes);
                var nzToday2 = NzToday;
                foreach (var obs2 in _colonyState.PendingObservations)
                    if (!string.IsNullOrEmpty(obs2.BoxName) && ToNzTime(obs2.WhenDataCollectedUtc).Date == nzToday2)
                        todayBoxes2[obs2.BoxName] = obs2;
                var scanned2 = todayBoxes2.Values.Sum(b => b.ScannedIds.Count(s => !s.BirdId.StartsWith("NOSCAN_")));
                var noScans2 = todayBoxes2.Values.Sum(b => b.ScannedIds.Count(s => s.BirdId.StartsWith("NOSCAN_")));
                var adults2 = todayBoxes2.Values.Sum(b => b.Adults);
                var mismatch2 = adults2 - scanned2 - noScans2;
                if (mismatch2 != 0)
                {
                    var mismatchWarn = new TextView(this)
                    {
                        Text = $"⚠ Adult mismatch: {adults2} adults - {scanned2} scanned - {noScans2} no-scan = {mismatch2}",
                        TextSize = 13
                    };
                    mismatchWarn.SetTextColor(UIFactory.DANGER_RED);
                    mismatchWarn.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
                    mismatchWarn.SetPadding(12, 4, 12, 4);
                    OverviewHeaderCard.AddView(mismatchWarn);
                }
            }

            // Duplicate penguin warnings — right under header
            {
                var penguinBoxes2 = new Dictionary<string, List<string>>();
                foreach (var bn in _boxNamesAndIndexes.Keys)
                {
                    var obs2 = _colonyState.GetTodayForBox(bn);
                    if (obs2 == null) continue;
                    foreach (var scan in obs2.ScannedIds)
                    {
                        if (scan.BirdId.StartsWith("NOSCAN_")) continue;
                        var key = scan.BirdId.ToUpper();
                        if (!penguinBoxes2.ContainsKey(key)) penguinBoxes2[key] = new List<string>();
                        if (!penguinBoxes2[key].Contains(bn)) penguinBoxes2[key].Add(bn);
                    }
                }
                foreach (var dup in penguinBoxes2.Where(kvp => kvp.Value.Count > 1))
                {
                    var (dupLabel, _, _, _) = LookupPenguinLabel(dup.Key);
                    var warn = new TextView(this)
                    {
                        Text = $"⚠ {dupLabel} in Box {string.Join(" & Box ", dup.Value)}",
                        TextSize = 13
                    };
                    warn.SetTextColor(UIFactory.DANGER_RED);
                    warn.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
                    warn.SetPadding(12, 4, 12, 4);
                    OverviewHeaderCard.AddView(warn);
                }
            }

            _overviewFiltersLayout = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };

            // Filter sentence: "Show [all/filters] except [none/filters]"
            var filterSentenceLayout = new LinearLayout(this);
            filterSentenceLayout.SetGravity(GravityFlags.Center);
            var sentenceParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            sentenceParams.SetMargins(8, 12, 8, 12);
            filterSentenceLayout.LayoutParameters = sentenceParams;

            var showLabel = new TextView(this) { Text = "Show ", TextSize = 18 };
            showLabel.SetTextColor(Color.Black);
            filterSentenceLayout.AddView(showLabel);

            string showText = GetShowFilterText();
            var showButton = new TextView(this) { Text = showText, TextSize = 18 };
            showButton.SetTextColor(UIFactory.PRIMARY_BLUE);
            showButton.SetTypeface(null, TypefaceStyle.Bold);
            showButton.PaintFlags = showButton.PaintFlags | Android.Graphics.PaintFlags.UnderlineText;
            showButton.Click += (s, e) =>
            {
                _appSettings.ShowFiltersVisible = !_appSettings.ShowFiltersVisible;
                _appSettings.HideFiltersVisible = false;
                DrawPageLayouts();
            };
            filterSentenceLayout.AddView(showButton);

            if (showText != "none")
            {
                var exceptLabel = new TextView(this) { Text = " except ", TextSize = 18 };
                exceptLabel.SetTextColor(Color.Black);
                filterSentenceLayout.AddView(exceptLabel);

                string hideText = GetHideFilterText();
                var hideButton = new TextView(this) { Text = hideText, TextSize = 18 };
                hideButton.SetTextColor(UIFactory.DANGER_RED);
                hideButton.SetTypeface(null, TypefaceStyle.Bold);
                hideButton.PaintFlags = hideButton.PaintFlags | Android.Graphics.PaintFlags.UnderlineText;
                hideButton.Click += (s, e) =>
                {
                    _appSettings.HideFiltersVisible = !_appSettings.HideFiltersVisible;
                    _appSettings.ShowFiltersVisible = false;
                    DrawPageLayouts();
                };
                filterSentenceLayout.AddView(hideButton);
            }

            _overviewFiltersLayout.AddView(filterSentenceLayout);

            // Show filters checkboxes layout
            var showFiltersCheckboxLayout = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };
            showFiltersCheckboxLayout.Visibility = _appSettings.ShowFiltersVisible ? ViewStates.Visible : ViewStates.Gone;

            TextView showBoxesTitle = new TextView(this)
            {
                Text = "Show boxes matching:",
                TextSize = 14,
                Gravity = GravityFlags.Center,
            };
            showBoxesTitle.SetTextColor(UIFactory.TEXT_SECONDARY);
            showFiltersCheckboxLayout.AddView(showBoxesTitle);

            var showFlow = new PenguinMonitor.UI.FlowLayout(this);
            showFlow.LayoutParameters = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);

            foreach (var (text, getter, setter) in new (string, Func<bool>, Action<bool>)[] {
                ("All", () => _appSettings.ShowAllBoxesInMultiBoxView, v => { _appSettings.ShowAllBoxesInMultiBoxView = v; }),
                ("With data", () => _appSettings.ShowBoxesWithDataInMultiBoxView, v => { _appSettings.ShowBoxesWithDataInMultiBoxView = v; if (v) { _appSettings.ShowAllBoxesInMultiBoxView = false; _appSettings.HideBoxesWithDataInMultiBoxView = false; } }),
                ("NO", () => _appSettings.ShowNoBoxesInMultiBoxView, v => { _appSettings.ShowNoBoxesInMultiBoxView = v; if (v) _appSettings.ShowAllBoxesInMultiBoxView = false; }),
                ("UNL", () => _appSettings.ShowUnlikleyBoxesInMultiBoxView, v => { _appSettings.ShowUnlikleyBoxesInMultiBoxView = v; if (v) _appSettings.ShowAllBoxesInMultiBoxView = false; }),
                ("POT", () => _appSettings.ShowPotentialBoxesInMultiBoxView, v => { _appSettings.ShowPotentialBoxesInMultiBoxView = v; if (v) _appSettings.ShowAllBoxesInMultiBoxView = false; }),
                ("CON", () => _appSettings.ShowConfidentBoxesInMultiBoxView, v => { _appSettings.ShowConfidentBoxesInMultiBoxView = v; if (v) _appSettings.ShowAllBoxesInMultiBoxView = false; }),
                ("BR", () => _appSettings.ShowBreedingBoxesInMultiBoxView, v => { _appSettings.ShowBreedingBoxesInMultiBoxView = v; if (v) _appSettings.ShowAllBoxesInMultiBoxView = false; }),
                ("ABN", () => _appSettings.ShowABNBoxesInMultiboxView, v => { _appSettings.ShowABNBoxesInMultiboxView = v; if (v) _appSettings.ShowAllBoxesInMultiBoxView = false; }),
                ("DCM", () => _appSettings.ShowDCMBoxesInMultiboxView, v => { _appSettings.ShowDCMBoxesInMultiboxView = v; if (v) _appSettings.ShowAllBoxesInMultiBoxView = false; }),
                ("Notes", () => _appSettings.showBoxesWithNotesInMultiboxView, v => { _appSettings.showBoxesWithNotesInMultiboxView = v; if (v) _appSettings.ShowAllBoxesInMultiBoxView = false; }),
                ("Box notes", () => _appSettings.ShowInterestingBoxesInMultiBoxView, v => { _appSettings.ShowInterestingBoxesInMultiBoxView = v; if (v) _appSettings.ShowAllBoxesInMultiBoxView = false; }),
                ("1 egg", () => _appSettings.ShowSingleEggBoxesInMultiboxView, v => { _appSettings.ShowSingleEggBoxesInMultiboxView = v; if (v) _appSettings.ShowAllBoxesInMultiBoxView = false; }),
                ("2 egg", () => _appSettings.ShowDoubleEggBoxesInMultiboxView, v => { _appSettings.ShowDoubleEggBoxesInMultiboxView = v; if (v) _appSettings.ShowAllBoxesInMultiBoxView = false; }),
                ("No scan", () => _appSettings.ShowNoScanBoxesInMultiboxView, v => { _appSettings.ShowNoScanBoxesInMultiboxView = v; if (v) _appSettings.ShowAllBoxesInMultiBoxView = false; }),
            })
            {
                var cb = new CheckBox(this) { Text = text, Checked = getter() };
                cb.SetTextColor(Color.Black);
                cb.Click += (s, e) => { setter(cb.Checked); DrawPageLayouts(); };
                showFlow.AddView(cb);
            }
            showFiltersCheckboxLayout.AddView(showFlow);

            _overviewFiltersLayout.AddView(showFiltersCheckboxLayout);

            // Hide filters checkboxes layout
            var hideFiltersCheckboxLayout = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };
            hideFiltersCheckboxLayout.Visibility = _appSettings.HideFiltersVisible ? ViewStates.Visible : ViewStates.Gone;

            TextView hideBoxesTitle = new TextView(this)
            {
                Text = "Hide boxes matching:",
                TextSize = 14,
                Gravity = GravityFlags.Center,
            };
            hideBoxesTitle.SetTextColor(UIFactory.TEXT_SECONDARY);
            hideFiltersCheckboxLayout.AddView(hideBoxesTitle);

            var hideFlow = new PenguinMonitor.UI.FlowLayout(this);
            hideFlow.LayoutParameters = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);

            foreach (var (text, getter, setter) in new (string, Func<bool>, Action<bool>)[] {
                ("With data", () => _appSettings.HideBoxesWithDataInMultiBoxView, v => { _appSettings.HideBoxesWithDataInMultiBoxView = v; if (v) _appSettings.ShowBoxesWithDataInMultiBoxView = false; }),
                ("NO", () => _appSettings.HideNoBoxesInMultiBoxView, v => _appSettings.HideNoBoxesInMultiBoxView = v),
                ("UNL", () => _appSettings.HideUnlikelyBoxesInMultiBoxView, v => _appSettings.HideUnlikelyBoxesInMultiBoxView = v),
                ("POT", () => _appSettings.HidePotentialBoxesInMultiBoxView, v => _appSettings.HidePotentialBoxesInMultiBoxView = v),
                ("CON", () => _appSettings.HideConfidentBoxesInMultiBoxView, v => _appSettings.HideConfidentBoxesInMultiBoxView = v),
                ("BR", () => _appSettings.HideBreedingBoxesInMultiBoxView, v => _appSettings.HideBreedingBoxesInMultiBoxView = v),
                ("ABN", () => _appSettings.HideABNInMultiBoxView, v => _appSettings.HideABNInMultiBoxView = v),
                ("DCM", () => _appSettings.HideDCMInMultiBoxView, v => _appSettings.HideDCMInMultiBoxView = v),
                ("Notes", () => _appSettings.HideBoxesWithNotesInMultiboxView, v => _appSettings.HideBoxesWithNotesInMultiboxView = v),
                ("Box notes", () => _appSettings.HideInterestingBoxesInMultiBoxView, v => _appSettings.HideInterestingBoxesInMultiBoxView = v),
                ("< current", () => _appSettings.HideBeforeCurrentInMultiBoxView, v => _appSettings.HideBeforeCurrentInMultiBoxView = v),
                ("1 egg", () => _appSettings.HideSingleEggBoxesInMultiboxView, v => _appSettings.HideSingleEggBoxesInMultiboxView = v),
                ("2 egg", () => _appSettings.HideDoubleEggBoxesInMultiboxView, v => _appSettings.HideDoubleEggBoxesInMultiboxView = v),
            })
            {
                var cb = new CheckBox(this) { Text = text, Checked = getter() };
                cb.SetTextColor(Color.Black);
                cb.Click += (s, e) => { setter(cb.Checked); DrawPageLayouts(); };
                hideFlow.AddView(cb);
            }
            hideFiltersCheckboxLayout.AddView(hideFlow);

            _overviewFiltersLayout.AddView(hideFiltersCheckboxLayout);

            // Done button (visible when either filter panel is open)
            if (_appSettings.ShowFiltersVisible || _appSettings.HideFiltersVisible)
            {
                var doneButton = _uiFactory.CreateStyledButton("Done", UIFactory.SUCCESS_GREEN);
                var navDensity = Resources?.DisplayMetrics?.Density ?? 2;
                doneButton.SetPadding((int)(12 * navDensity), (int)(8 * navDensity), (int)(12 * navDensity), (int)(8 * navDensity));
                var doneParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
                doneParams.SetMargins(16, 8, 16, 8);
                doneButton.LayoutParameters = doneParams;
                doneButton.Click += (s, e) =>
                {
                    _appSettings.ShowFiltersVisible = false;
                    _appSettings.HideFiltersVisible = false;
                    DrawPageLayouts();
                };
                _overviewFiltersLayout.AddView(doneButton);
            }

            // Today's statistics summary
            var statsText = new TextView(this) { Text = GetSummaryText(), TextSize = 14 };
            statsText.SetTextColor(Color.Black);
            statsText.SetPadding(12, 8, 12, 8);
            _overviewFiltersLayout.AddView(statsText);

            OverviewHeaderCard.AddView(_overviewFiltersLayout);
            _multiBoxViewCard.AddView(OverviewHeaderCard);

            _overviewFiltersLayout.Visibility = _appSettings.ShowMultiboxFilterCard ? ViewStates.Visible : ViewStates.Gone;

            int boxesPerRow = 3;
            LinearLayout? currentRow = null;

            int visibleBoxCount = 0;
            foreach (string boxName in _boxNamesAndIndexes.Keys)
            {
                if (visibleBoxCount % boxesPerRow == 0)
                {
                    currentRow = new LinearLayout(this);
                    currentRow.SetPadding(0, 0, 0, 0);

                    var rowParams = new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MatchParent,
                        ViewGroup.LayoutParams.WrapContent);
                    currentRow.LayoutParameters = rowParams;
                    currentRow.SetGravity(GravityFlags.Center);

                    _multiBoxViewCard.AddView(currentRow);
                }
                // Get the most recent data for this box
                BoxObservation mostRecentBoxData = new BoxObservation();
                BoxObservation? previousBoxData = null;
                if (!_isHistoricalView)
                    _colonyState.PreviousBoxes.TryGetValue(boxName, out previousBoxData);
                if (previousBoxData != null)
                    mostRecentBoxData = previousBoxData;

                var currentBoxData = GetDisplayBoxData(boxName);
                bool currentBoxDataFound = currentBoxData != null;
                if (currentBoxDataFound && currentBoxData != null)
                    mostRecentBoxData = currentBoxData;

                bool hasBoxNotes = _boxNotes.TryGetValue(boxName, out var boxNoteForFilter) && !string.IsNullOrWhiteSpace(boxNoteForFilter.PersistentNotes);
                bool showBox = _appSettings.ShowAllBoxesInMultiBoxView
                            || _appSettings.ShowBoxesWithDataInMultiBoxView && (GetDisplayBoxData(boxName) != null)
                            || _appSettings.ShowBreedingBoxesInMultiBoxView && mostRecentBoxData.BreedingStatus != null && mostRecentBoxData.BreedingStatus.Equals("BR")
                            || _appSettings.ShowConfidentBoxesInMultiBoxView && mostRecentBoxData.BreedingStatus != null && mostRecentBoxData.BreedingStatus.Equals("CON")
                            || _appSettings.ShowPotentialBoxesInMultiBoxView && mostRecentBoxData.BreedingStatus != null && mostRecentBoxData.BreedingStatus.Equals("POT")
                            || _appSettings.ShowUnlikleyBoxesInMultiBoxView && mostRecentBoxData.BreedingStatus != null && mostRecentBoxData.BreedingStatus.Equals("UNL")
                            || _appSettings.ShowNoBoxesInMultiBoxView && mostRecentBoxData.BreedingStatus != null && mostRecentBoxData.BreedingStatus.Equals("NO")
                            || _appSettings.ShowBoxesWithNotesInMultiboxView && mostRecentBoxData != null && !String.IsNullOrWhiteSpace(mostRecentBoxData.Notes)
                            || _appSettings.ShowInterestingBoxesInMultiBoxView && hasBoxNotes
                            || _appSettings.ShowSingleEggBoxesInMultiboxView && (mostRecentBoxData.Eggs == 1)
                            || _appSettings.ShowDoubleEggBoxesInMultiboxView && (mostRecentBoxData.Eggs == 2)
                            || _appSettings.ShowDCMBoxesInMultiboxView && mostRecentBoxData.BreedingStatus != null && mostRecentBoxData.BreedingStatus.Equals("DCM")
                            || _appSettings.ShowABNBoxesInMultiboxView && mostRecentBoxData.BreedingStatus != null && mostRecentBoxData.BreedingStatus.Equals("ABN")
                            || _appSettings.ShowNoScanBoxesInMultiboxView && currentBoxData != null && currentBoxData.ScannedIds.Any(s => s.BirdId.StartsWith("NOSCAN_"));

                bool hideBoxWithData = _appSettings.HideBoxesWithDataInMultiBoxView && (GetDisplayBoxData(boxName) != null);
                bool hideDCM = _appSettings.HideDCMInMultiBoxView && ((mostRecentBoxData.BreedingStatus != null && mostRecentBoxData.BreedingStatus == "DCM"));
                bool hideABN = _appSettings.HideABNInMultiBoxView && mostRecentBoxData.BreedingStatus != null && mostRecentBoxData.BreedingStatus.Equals("ABN");
                bool hideBeforeCurrent = _appSettings.HideBeforeCurrentInMultiBoxView && _currentBoxIndex > _boxNamesAndIndexes[boxName];
                bool hideNo = _appSettings.HideNoBoxesInMultiBoxView && mostRecentBoxData.BreedingStatus != null && mostRecentBoxData.BreedingStatus.Equals("NO");
                bool hideUnlikely = _appSettings.HideUnlikelyBoxesInMultiBoxView && mostRecentBoxData.BreedingStatus != null && mostRecentBoxData.BreedingStatus.Equals("UNL");
                bool hidePotential = _appSettings.HidePotentialBoxesInMultiBoxView && mostRecentBoxData.BreedingStatus != null && mostRecentBoxData.BreedingStatus.Equals("POT");
                bool hideConfident = _appSettings.HideConfidentBoxesInMultiBoxView && mostRecentBoxData.BreedingStatus != null && mostRecentBoxData.BreedingStatus.Equals("CON");
                bool hideBreeding = _appSettings.HideBreedingBoxesInMultiBoxView && mostRecentBoxData.BreedingStatus != null && mostRecentBoxData.BreedingStatus.Equals("BR");
                bool hideNotes = _appSettings.HideBoxesWithNotesInMultiboxView && mostRecentBoxData != null && !String.IsNullOrWhiteSpace(mostRecentBoxData.Notes);
                bool hideInteresting = _appSettings.HideInterestingBoxesInMultiBoxView && hasBoxNotes;
                bool hideSingleEgg = _appSettings.HideSingleEggBoxesInMultiboxView && mostRecentBoxData.Eggs == 1;
                bool hideDoubleEgg = _appSettings.HideDoubleEggBoxesInMultiboxView && mostRecentBoxData.Eggs == 2;

                // In Edit Box Tags mode, show all boxes regardless of filters
                bool shouldShow = _appSettings.EditBoxTagsMode ||
                    (showBox && !hideBoxWithData && !hideDCM && !hideABN && !hideBeforeCurrent && !hideNo && !hideUnlikely && !hidePotential && !hideConfident && !hideBreeding && !hideNotes && !hideInteresting && !hideSingleEgg && !hideDoubleEgg);

                if (shouldShow)
                {
                    View? card;
                    if (currentBoxDataFound)
                        card = CreateBoxSummaryCard(boxName, currentBoxData, _boxNamesAndIndexes[boxName] == _currentBoxIndex, previousBoxData);
                    else
                        card = CreateBoxSummaryCard(boxName, null, _boxNamesAndIndexes[boxName] == _currentBoxIndex, previousBoxData);
                    currentRow?.AddView(card);
                    visibleBoxCount++;
                }
            }
            if (visibleBoxCount == 0)
            {
                var empty = new TextView(this) { Text = "No boxes to show." };
                _multiBoxViewCard.AddView(empty);
            }
        }
        private void createBreedingDatesCard()
        {
            _breedingDatesCard.RemoveAllViews();
            var breedingDatesContent = createBreedingDatesTimelineSection();
            _breedingDatesCard.AddView(breedingDatesContent);
        }
        private View? CreateBoxSummaryCard(string boxName, BoxObservation? thisBoxData, bool selected, BoxObservation? previousBoxData)
        {
            bool currentExists = thisBoxData != null;
            if (!currentExists && previousBoxData != null)
                thisBoxData = previousBoxData;

            var boxOverviewCard = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };
            boxOverviewCard.SetPadding(5, 5, 5, 5);

            int minWidth = Resources.DisplayMetrics.WidthPixels / 5;
            var cardParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1f);
            cardParams.SetMargins(5, 5, 5, 5);
            boxOverviewCard.LayoutParameters = cardParams;
            boxOverviewCard.SetMinimumWidth(minWidth);

            boxOverviewCard.Click += (sender, e) =>
            {
                JumpToBox(boxName);
                ScrollToTop();
            };

            // Border: today=solid black, old data=orange border, loss=red, changed=blue, default=grey
            bool differenceFound = false;
            if (currentExists && thisBoxData?.IsPendingUpload == true)
            {
                // Unsynced today's edit — orange border
                boxOverviewCard.Background = _uiFactory.CreateCardBackground(borderWidth: 8, borderColour: UIFactory.WARNING_YELLOW, backgroundColor: selected ? UIFactory.WARNING_YELLOW : null);
            }
            else if (currentExists)
            {
                // Today's synced data — solid black border
                if (previousBoxData != null && thisBoxData != null
                    && (thisBoxData.Eggs + thisBoxData.Chicks < previousBoxData.Eggs + previousBoxData.Chicks))
                {
                    differenceFound = true;
                    boxOverviewCard.Background = _uiFactory.CreateCardBackground(borderWidth: 8, borderColour: UIFactory.DANGER_RED, backgroundColor: selected ? UIFactory.WARNING_YELLOW : null);
                }
                else if (previousBoxData != null && thisBoxData != null
                    && (thisBoxData.Eggs != previousBoxData.Eggs || thisBoxData.Chicks != previousBoxData.Chicks))
                {
                    differenceFound = true;
                    boxOverviewCard.Background = _uiFactory.CreateCardBackground(borderWidth: 8, borderColour: UIFactory.PRIMARY_BLUE, backgroundColor: selected ? UIFactory.WARNING_YELLOW : null);
                }
                else
                {
                    boxOverviewCard.Background = _uiFactory.CreateCardBackground(borderWidth: 8, borderColour: Color.Black, backgroundColor: selected ? UIFactory.WARNING_YELLOW : null);
                }
            }
            else if (thisBoxData != null)
            {
                // Old/previous data only — orange border
                boxOverviewCard.Background = _uiFactory.CreateCardBackground(borderWidth: 4, borderColour: UIFactory.WARNING_YELLOW, backgroundColor: selected ? UIFactory.WARNING_YELLOW : null);
            }
            else
            {
                // No data — thin grey
                boxOverviewCard.Background = _uiFactory.CreateCardBackground(borderWidth: 3, backgroundColor: selected ? UIFactory.WARNING_YELLOW : null);
            }

            // Pale green background for boxes with no-scan penguins (chipping candidates)
            bool hasNoScan = thisBoxData != null && thisBoxData.ScannedIds.Any(s => s.BirdId.StartsWith("NOSCAN_"));
            if (hasNoScan && !selected)
            {
                var currentBg = boxOverviewCard.Background as Android.Graphics.Drawables.GradientDrawable;
                currentBg?.SetColor(SCAN_CHIPPED_TODAY_BG);
            }

            var title = new TextView(this)
            {
                Text = $"Box {boxName}",
                Gravity = GravityFlags.Center,
                TextSize = 18
            };
            title.SetTypeface(Typeface.DefaultBold, TypefaceStyle.Normal);
            title.SetTextColor(Color.Black);
            boxOverviewCard.AddView(title);

            if (thisBoxData == null)
                return boxOverviewCard;

            var summary = new TextView(this)
            {
                Text = $"{string.Concat(Enumerable.Repeat("🐧", thisBoxData.Adults))}" +
                    $"{string.Concat(Enumerable.Repeat("🥚", thisBoxData.Eggs))}" +
                    $"{string.Concat(Enumerable.Repeat("🐣", thisBoxData.Chicks))}",
                Gravity = GravityFlags.Center,
                TextSize = 14
            };
            if (differenceFound && previousBoxData != null)
            {
                var prevEggs = previousBoxData.Eggs;
                var prevChicks = previousBoxData.Chicks;
                if (prevChicks + prevEggs > 0 && (thisBoxData.Eggs != prevEggs || thisBoxData.Chicks != prevChicks))
                    summary.Text += $"({string.Concat(Enumerable.Repeat("🥚", prevEggs))}{string.Concat(Enumerable.Repeat("🐣", prevChicks))})";
            }

            // Show breeding status once
            var status = thisBoxData.BreedingStatus;
            if (!string.IsNullOrEmpty(status) && (status != "BR" || (thisBoxData.Chicks + thisBoxData.Eggs == 0)))
                summary.Text += $" {status}";

            if (_remoteBreedingDates != null && _remoteBreedingDates.ContainsKey(boxName))
                summary.Text += "\n" + _remoteBreedingDates[boxName].breedingDateStatus();
            
            summary.SetTextColor(Color.Black);

            string gateStatus = thisBoxData.GateStatus;
            string notes = string.IsNullOrWhiteSpace(thisBoxData.Notes) ? "" : "notes";
            bool hasBoxNotesForCard = _boxNotes.TryGetValue(boxName, out var cardBoxNote) && !string.IsNullOrWhiteSpace(cardBoxNote.PersistentNotes);
            notes += hasBoxNotesForCard ? $" ({cardBoxNote.PersistentNotes})" : "";
            // NRF percentage removed (requires monitor history)
            string lineThreeStatusText = "";
            if (!string.IsNullOrWhiteSpace(gateStatus) && !string.IsNullOrWhiteSpace(notes))
                lineThreeStatusText = gateStatus + " & " + notes;
            else
                lineThreeStatusText = gateStatus + notes;
            var gate_and_notes = new TextView(this)
            {
                Text = lineThreeStatusText,
                Gravity = GravityFlags.Center,
                TextSize = 14
            };
            gate_and_notes.SetTextColor(Color.DarkGray);

            if(!string.IsNullOrEmpty(summary.Text)) boxOverviewCard.AddView(summary);
            if(!string.IsNullOrEmpty(gate_and_notes.Text)) boxOverviewCard.AddView(gate_and_notes);
            return boxOverviewCard;
        }

        /// <summary>
        /// Creates the breeding dates timeline section showing upcoming milestones grouped by date
        /// </summary>
        private LinearLayout createBreedingDatesTimelineSection()
        {
            var container = _uiFactory.CreateCard(Android.Widget.Orientation.Vertical);

            // Header with title
            var headerRow = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Horizontal };
            var title = new TextView(this)
            {
                Text = "Next breeding dates",
                TextSize = 30,
                Gravity = GravityFlags.Left
            };
            title.SetTextColor(Color.Black);
            title.SetTypeface(Typeface.DefaultBold, TypefaceStyle.Normal);
            headerRow.AddView(title);
            container.AddView(headerRow);

            // Filter checkboxes row
            var filtersRow = new PenguinMonitor.UI.FlowLayout(this);
            filtersRow.SetPadding(0, 8, 0, 8);
            filtersRow.LayoutParameters = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);

            foreach (var (text, getter, setter) in new (string, Func<bool>, Action<bool>)[] {
                ("Hatch", () => _appSettings.ShowHatchingDatesInTimeline, v => _appSettings.ShowHatchingDatesInTimeline = v),
                ("PG", () => _appSettings.ShowPGDatesInTimeline, v => _appSettings.ShowPGDatesInTimeline = v),
                ("Chip", () => _appSettings.ShowChippingDatesInTimeline, v => _appSettings.ShowChippingDatesInTimeline = v),
                ("Fledge", () => _appSettings.ShowFledgingDatesInTimeline, v => _appSettings.ShowFledgingDatesInTimeline = v),
            })
            {
                var cb = new CheckBox(this) { Text = text, Checked = getter() };
                cb.SetTextColor(Color.Black);
                cb.Click += (s, e) => { setter(cb.Checked); DrawPageLayouts(); };
                filtersRow.AddView(cb);
            }

            container.AddView(filtersRow);

            // Collect all breeding dates from local calculations
            var milestones = new List<(DateTime date, string boxName, string milestone)>();

            // Use remote breeding dates if available
            if (_remoteBreedingDates != null)
            {
                foreach (string boxName in _boxNamesAndIndexes.Keys)
                {
                    if (!_remoteBreedingDates.ContainsKey(boxName)) continue;
                    var bd = _remoteBreedingDates[boxName];
                    if (_appSettings.ShowHatchingDatesInTimeline && !string.IsNullOrEmpty(bd.estHatchDate))
                        milestones.Add((DateTime.Parse(bd.estHatchDate), boxName, "Hatches"));
                    if (_appSettings.ShowPGDatesInTimeline && !string.IsNullOrEmpty(bd.estPGDate))
                        milestones.Add((DateTime.Parse(bd.estPGDate), boxName, "PG"));
                    if (_appSettings.ShowChippingDatesInTimeline && !string.IsNullOrEmpty(bd.chipWindowStart))
                        milestones.Add((DateTime.Parse(bd.chipWindowStart), boxName, "Chipping starts"));
                    if (_appSettings.ShowFledgingDatesInTimeline && !string.IsNullOrEmpty(bd.estFledgeDate))
                        milestones.Add((DateTime.Parse(bd.estFledgeDate), boxName, "Fledges"));
                }
            }

            // Filter to only future dates (including today), then sort
            var today = NzToday;
            var sortedMilestones = milestones
                .Where(m => m.date >= today)
                .OrderBy(m => m.date)
                .ToList();

            // Group by date and render
            var groupedByDate = sortedMilestones.GroupBy(m => m.date.Date);

            foreach (var dateGroup in groupedByDate)
            {
                var dateHeader = new TextView(this)
                {
                    Text = dateGroup.Key.ToString("d MMM"),
                    TextSize = 18,
                    Gravity = GravityFlags.Left
                };
                dateHeader.SetTypeface(Typeface.DefaultBold, TypefaceStyle.Normal);
                dateHeader.SetPadding(0, 16, 0, 4);
                dateHeader.SetTextColor(Color.Black);

                container.AddView(dateHeader);

                foreach (var milestone in dateGroup.OrderBy(m => m.boxName))
                {
                    var entryRow = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Horizontal };
                    entryRow.SetPadding(24, 2, 0, 2);

                    var entryText = new TextView(this)
                    {
                        Text = $"Box {milestone.boxName}: {milestone.milestone}",
                        TextSize = 16
                    };
                    entryText.SetTextColor(Color.Black);

                    // Make clickable to jump to box
                    entryRow.Click += (s, e) =>
                    {
                        JumpToBox(milestone.boxName);
                        ScrollToTop();
                    };

                    entryRow.AddView(entryText);
                    container.AddView(entryRow);
                }
            }

            if (milestones.Count == 0)
            {
                var noDataText = new TextView(this)
                {
                    Text = "No breeding dates available. Dates are calculated from boxes with eggs/chicks.",
                    TextSize = 14
                };
                noDataText.SetTextColor(UIFactory.TEXT_SECONDARY);
                noDataText.SetPadding(0, 16, 0, 8);
                container.AddView(noDataText);
            }

            return container;
        }

        /// <summary>
        private void ScrollToTop()
        {
            if (_rootScrollView == null) return;
            _rootScrollView.Post(() =>
            {
                var animator = ObjectAnimator.OfInt(_rootScrollView, "scrollY", _rootScrollView.ScrollY, 0);
                animator.SetDuration(750); // millis
                animator.SetInterpolator(new DecelerateInterpolator());
                animator.Start();
            });
        }
        private void AnimateHistoricalDataTransition(bool isSwipingToOlder)
        {
            if (_singleBoxDataContentLayout == null || _isAnimating) return;

            _isAnimating = true;

            // Slide distance
            int slideDistance = _singleBoxDataContentLayout.Width;
            // Swipe LEFT (to older): current exits RIGHT, new enters from LEFT
            // Swipe RIGHT (to newer): current exits LEFT, new enters from RIGHT
            int slideOutX = isSwipingToOlder ? slideDistance : -slideDistance;
            int slideInX = isSwipingToOlder ? -slideDistance : slideDistance;

            // Haptic feedback
            _vibrator?.Vibrate(50);

            // Phase 1: Slide out current content
            var slideOut = ObjectAnimator.OfFloat(_singleBoxDataContentLayout, "translationX", 0, slideOutX);
            slideOut?.SetDuration(200);
            slideOut?.SetInterpolator(new AccelerateInterpolator());

            if (slideOut != null)
            {
                slideOut.AnimationEnd += (s, e) =>
                {
                    // Phase 2: Update content (happens off-screen)
                    DrawPageLayouts();

                    // Phase 3: Slide in new content
                    if (_singleBoxDataContentLayout != null)
                    {
                        _singleBoxDataContentLayout.TranslationX = slideInX;
                        var slideIn = ObjectAnimator.OfFloat(_singleBoxDataContentLayout, "translationX", slideInX, 0);
                        slideIn?.SetDuration(250);
                        slideIn?.SetInterpolator(new DecelerateInterpolator());

                        if (slideIn != null)
                        {
                            slideIn.AnimationEnd += (s2, e2) =>
                            {
                                _isAnimating = false;
                            };

                            slideIn.Start();
                        }
                    }
                };

                slideOut.Start();
            }
        }
        private void createSettingsCard()
        {
            _settingsCard = _uiFactory.CreateCard(borderWidth: 8);
            _settingsCard.Visibility = ViewStates.Gone;

            TextView versionText = new TextView(this)
            {
                Text = "Version: " + version
                ,
                Gravity = GravityFlags.CenterHorizontal
            };
            versionText.SetTextColor(Color.Black);
            _settingsCard.AddView(versionText);

            _isBluetoothEnabledCheckBox = new CheckBox(this)
            {
                Text = "Enable Bluetooth and GPS",
            };
            _isBluetoothEnabledCheckBox.SetTextColor(Color.Black);
            _isBluetoothEnabledCheckBox.CheckedChange += (s, e) =>
            {
                if (_isBluetoothEnabledCheckBox.Checked)
                {
                    InitializeBluetooth();
                    InitializeGPS();
                    _appSettings.IsBlueToothEnabled = true;
                }
                else
                {
                    _appSettings.IsBlueToothEnabled = false;
                    _bluetoothManager?.Dispose();
                    _bluetoothManager = null;
                    _locationManager?.RemoveUpdates(this);
                    _gpsAccuracy = -1;
                    UpdateStatusText("Bluetooth & GPS Disabled");
                }
            };
            _isBluetoothEnabledCheckBox.Checked = _appSettings.IsBlueToothEnabled;
            // Daily label
            var dailyLabelLayout = new LinearLayout(this);
            dailyLabelLayout.SetPadding(8, 8, 8, 8);
            var dailyLabelTitle = new TextView(this) { Text = "Daily label:", TextSize = 14 };
            dailyLabelTitle.SetTextColor(Color.Black);
            dailyLabelTitle.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            dailyLabelLayout.AddView(dailyLabelTitle);

            var dailyLabelInput = new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassText | Android.Text.InputTypes.TextFlagCapSentences,
                Hint = "e.g. Morning check",
                Text = _colonyState.DailyLabel ?? "",
                TextSize = 14,
            };
            dailyLabelInput.SetTextColor(UIFactory.TEXT_PRIMARY);
            dailyLabelInput.SetHintTextColor(UIFactory.TEXT_SECONDARY);
            dailyLabelInput.SetPadding(12, 8, 12, 8);
            dailyLabelInput.Background = _uiFactory.CreateRoundedBackground(UIFactory.LIGHTER_GRAY, 8);
            dailyLabelInput.Focusable = true;
            dailyLabelInput.FocusableInTouchMode = true;
            dailyLabelInput.Clickable = true;
            dailyLabelInput.LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1);
            dailyLabelLayout.AddView(dailyLabelInput);

            var setLabelButton = new Button(this) { Text = "Set", TextSize = 12 };
            setLabelButton.SetTextColor(Color.White);
            setLabelButton.SetPadding(16, 8, 16, 8);
            setLabelButton.Background = _uiFactory.CreateRoundedBackground(UIFactory.SUCCESS_GREEN, 8);
            setLabelButton.SetAllCaps(false);
            setLabelButton.LayoutParameters = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent);
            setLabelButton.Click += (s, e) =>
            {
                var newLabel = dailyLabelInput.Text?.Trim() ?? "";
                var oldLabel = _colonyState.DailyLabel ?? "";

                // Hide keyboard
                var imm = (Android.Views.InputMethods.InputMethodManager?)GetSystemService(InputMethodService);
                imm?.HideSoftInputFromWindow(dailyLabelInput.WindowToken, 0);

                // Find today's observations by this user with a different or empty label
                var nzToday = NzToday;
                var myObserverName = _appSettings?.ObserverName ?? "";
                var mismatchedObs = _colonyState.TodayBoxes.Values
                    .Where(o => o.ObserverName == myObserverName
                        && ToNzTime(o.WhenDataCollectedUtc).Date == nzToday
                        && (o.MonitorFilename ?? "") != newLabel)
                    .ToList();
                var mismatchedPending = _colonyState.PendingObservations
                    .Where(o => o.ObserverName == myObserverName
                        && ToNzTime(o.WhenDataCollectedUtc).Date == nzToday
                        && (o.MonitorFilename ?? "") != newLabel)
                    .ToList();
                var totalMismatched = mismatchedObs.Count + mismatchedPending.Count;

                Action applyLabel = () =>
                {
                    _colonyState.DailyLabel = newLabel;
                    _colonyState.DailyLabelDate = nzToday.ToString("yyyy-MM-dd");
                    DataStorageService.SaveColonyState(this, _colonyState);
                    UpdateDailyLabelWarnings();
                };

                if (totalMismatched > 0 && !string.IsNullOrEmpty(newLabel))
                {
                    new AlertDialog.Builder(this)
                        .SetTitle("Update existing observations?")
                        .SetMessage($"{totalMismatched} of your observations today have a different label.\n\nUpdate them all to \"{newLabel}\"?")
                        .SetPositiveButton("Update all", (s2, e2) =>
                        {
                            foreach (var obs in mismatchedObs) { obs.MonitorFilename = newLabel; obs.IsPendingUpload = true; obs.PendingUploadSinceUtc ??= DateTime.UtcNow; }
                            foreach (var obs in mismatchedPending) { obs.MonitorFilename = newLabel; obs.IsPendingUpload = true; obs.PendingUploadSinceUtc ??= DateTime.UtcNow; }
                            applyLabel();
                            DrawPageLayouts();
                        })
                        .SetNegativeButton("Just set label", (s2, e2) => applyLabel())
                        .Show();
                }
                else
                {
                    applyLabel();
                }
            };
            dailyLabelLayout.AddView(setLabelButton);

            var dailyLabelWarningCheckBox = new CheckBox(this) { Text = "⚠", Checked = _appSettings.ShowDailyLabelWarning };
            dailyLabelWarningCheckBox.SetTextColor(UIFactory.DANGER_RED);
            dailyLabelWarningCheckBox.SetPadding(0, 0, 0, 0);
            dailyLabelWarningCheckBox.LayoutParameters = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent);
            dailyLabelWarningCheckBox.CheckedChange += (s, e) =>
            {
                _appSettings.ShowDailyLabelWarning = dailyLabelWarningCheckBox.Checked;
                UpdateDailyLabelWarnings();
            };
            dailyLabelLayout.AddView(dailyLabelWarningCheckBox);

            // Edit Box Tags mode toggle button
            Button editBoxTagsButton = _uiFactory.CreateStyledButton(
                _appSettings.EditBoxTagsMode ? "Exit Box Tags Mode" : "Edit Box Tags",
                _appSettings.EditBoxTagsMode ? UIFactory.DANGER_RED : UIFactory.SUCCESS_GREEN);
            editBoxTagsButton.Click += (s, e) =>
            {
                _appSettings.EditBoxTagsMode = !_appSettings.EditBoxTagsMode;
                editBoxTagsButton.Text = _appSettings.EditBoxTagsMode ? "Exit Box Tags Mode" : "Edit Box Tags";
                editBoxTagsButton.Background = _uiFactory.CreateRoundedBackground(
                    _appSettings.EditBoxTagsMode ? UIFactory.DANGER_RED : UIFactory.SUCCESS_GREEN, 8);
                selectedPage = UIFactory.selectedPage.BoxDataSingle;
                DrawPageLayouts();
            };
            // Region & Colony dropdowns (horizontal)
            var regionColonyLayout = new LinearLayout(this);
            regionColonyLayout.SetPadding(8, 8, 8, 8);

            var regionSpinner = new Spinner(this);
            regionSpinner.SetPadding(8, 4, 8, 4);
            regionSpinner.Prompt = "Region";
            regionSpinner.LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1);
            regionColonyLayout.AddView(regionSpinner);

            var colonySpinner = new Spinner(this);
            colonySpinner.SetPadding(8, 4, 8, 4);
            colonySpinner.Prompt = "Colony";
            colonySpinner.LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1);
            regionColonyLayout.AddView(colonySpinner);


            // Show saved colony immediately (before server fetch)
            if (!string.IsNullOrEmpty(_appSettings.SelectedColonyName))
            {
                var savedColony = new[] { _appSettings.SelectedColonyName };
                colonySpinner.Adapter = new ArrayAdapter<string>(this, Android.Resource.Layout.SimpleSpinnerItem, savedColony);
                ((ArrayAdapter<string>)colonySpinner.Adapter).SetDropDownViewResource(Android.Resource.Layout.SimpleSpinnerDropDownItem);
            }

            // Fetch colonies from server and populate dropdowns
            new Thread(async () =>
            {
                try
                {
                    var request = new HttpRequestMessage(HttpMethod.Get, $"{DataStorageService.WILDWATCH_BASE_URL}/colonies.php");
                    if (_appSettings.IsAuthenticated)
                        request.Headers.Add("Authorization", $"Bearer {_appSettings.AuthToken}");
                    var response = await new HttpClient { Timeout = TimeSpan.FromSeconds(10) }.SendAsync(request);
                    var json = await response.Content.ReadAsStringAsync();
                    var allColonies = JsonConvert.DeserializeObject<List<Dictionary<string, object>>>(json) ?? new();

                    RunOnUiThread(() =>
                    {
                        if (allColonies.Count == 0)
                        {
                            Toast.MakeText(this, "No colonies available", ToastLength.Short)?.Show();
                            return;
                        }

                        // Build region list
                        var regions = allColonies.Select(c => c["region_name"]?.ToString() ?? "").Distinct().ToList();
                        var regionAdapter = new ArrayAdapter<string>(this, Android.Resource.Layout.SimpleSpinnerItem, regions);
                        regionAdapter.SetDropDownViewResource(Android.Resource.Layout.SimpleSpinnerDropDownItem);
                        regionSpinner.Adapter = regionAdapter;

                        // When region changes, update colony spinner
                        regionSpinner.ItemSelected += (s, e) =>
                        {
                            var selectedRegion = regions[e.Position];
                            var coloniesInRegion = allColonies.Where(c => c["region_name"]?.ToString() == selectedRegion).ToList();
                            var colonyNames = coloniesInRegion.Select(c => c["colony_name"]?.ToString() ?? "").ToList();
                            var colonyAdapter = new ArrayAdapter<string>(this, Android.Resource.Layout.SimpleSpinnerItem, colonyNames);
                            colonyAdapter.SetDropDownViewResource(Android.Resource.Layout.SimpleSpinnerDropDownItem);
                            colonySpinner.Adapter = colonyAdapter;

                            // Pre-select current colony if in this region
                            var currentIdx = colonyNames.IndexOf(_appSettings.SelectedColonyName);
                            if (currentIdx >= 0) colonySpinner.SetSelection(currentIdx, false);
                        };

                        // When colony changes, apply it
                        colonySpinner.ItemSelected += (s, e) =>
                        {
                            var selectedRegion = regionSpinner.SelectedItem?.ToString() ?? "";
                            var coloniesInRegion = allColonies.Where(c => c["region_name"]?.ToString() == selectedRegion).ToList();
                            if (e.Position < coloniesInRegion.Count)
                            {
                                var selected = coloniesInRegion[e.Position];
                                var newId = Convert.ToInt32(selected["colony_id"]);
                                if (newId != _appSettings.SelectedColonyId)
                                {
                                    _appSettings.SelectedColonyId = newId;
                                    _appSettings.SelectedColonyName = selected["colony_name"]?.ToString() ?? "";
                                    _appSettings.AllBoxSetsString = selected["location_sets_string"]?.ToString() ?? "";
                                    _appSettings.BoxSetString = "All";
                                    CreateBoxSetsDictionary();
                                    if (_boxNamesAndIndexes.Count > 0)
                                        JumpToBox(_boxNamesAndIndexes.First().Key);
                                    DrawPageLayouts();
                                }
                            }
                        };

                        // Pre-select current region
                        var currentRegion = allColonies.FirstOrDefault(c => c["colony_name"]?.ToString() == _appSettings.SelectedColonyName);
                        if (currentRegion != null)
                        {
                            var regionIdx = regions.IndexOf(currentRegion["region_name"]?.ToString() ?? "");
                            if (regionIdx >= 0) regionSpinner.SetSelection(regionIdx, false);
                        }
                    });
                }
                catch { }
            }).Start();


            // Daily label warning

            // Logout/Login button
            View authButton;
            if (_appSettings?.IsAuthenticated == true)
            {
                var logoutButton = _uiFactory.CreateStyledButton($"Logout {_appSettings.ObserverName}", UIFactory.DANGER_RED);
                logoutButton.Click += (s, e) =>
                {
                    new AlertDialog.Builder(this)
                        .SetTitle("Logout")
                        .SetMessage($"Logout {_appSettings.ObserverName}? You will need to log in again to sync.")
                        .SetPositiveButton("Logout", (s2, e2) =>
                        {
                            _appSettings.AuthToken = "";
                            _appSettings.ObserverName = "";
                            _appSettings.ObserverId = 0;
                            DataStorageService.saveApplicationSettings(_appSettings);
                            UpdateStatusText();
                            DrawPageLayouts();
                        })
                        .SetNegativeButton("Cancel", (s2, e2) => { })
                        .Show();
                };
                var logoutParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
                logoutParams.SetMargins(8, 8, 8, 8);
                logoutButton.LayoutParameters = logoutParams;
                authButton = logoutButton;
            }
            else
            {
                var loginButton = _uiFactory.CreateStyledButton("Login to Wildwatch", UIFactory.PRIMARY_BLUE);
                loginButton.Click += (s, e) => ShowLoginPrompt();
                var loginParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
                loginParams.SetMargins(8, 8, 8, 8);
                loginButton.LayoutParameters = loginParams;
                authButton = loginButton;
            }

            // === Add all elements in order ===
            // 1. Region/Colony (top)
            _settingsCard.AddView(regionColonyLayout);
            // 2. Daily label
            _settingsCard.AddView(dailyLabelLayout);
            // 3. Bluetooth
            _settingsCard.AddView(_isBluetoothEnabledCheckBox);

            // Scanner device picker
            // Scanner selection
            var scannerSection = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };
            scannerSection.SetPadding(8, 0, 8, 8);

            var currentScanner = _appSettings.SelectedBluetoothDevice;
            var pairedName = BluetoothManager.GetPairedDevices().FirstOrDefault(d => d.Address == currentScanner).Name;
            var scannerStatus = new TextView(this) { TextSize = 14 };
            scannerStatus.SetTextColor(Color.Black);
            scannerStatus.Text = currentScanner != null ? $"Scanner: {pairedName ?? currentScanner}" : "No scanner selected";

            IDisposable? discoveryHandle = null;
            var scanButton = _uiFactory.CreateStyledButton("Scan for scanners", UIFactory.PRIMARY_BLUE);
            var deviceListLayout = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };

            scanButton.Click += (s, e) =>
            {
                scannerStatus.Visibility = Android.Views.ViewStates.Visible;
                deviceListLayout.Visibility = Android.Views.ViewStates.Visible;
                discoveryHandle?.Dispose();
                deviceListLayout.RemoveAllViews();
                scanButton.Text = "Scanning...";
                scanButton.Enabled = false;
                var foundAddresses = new HashSet<string>();

                discoveryHandle = BluetoothManager.StartDiscovery(this, (address, name) =>
                {
                    RunOnUiThread(() =>
                    {
                        if (!foundAddresses.Add(address)) return;
                        var btn = _uiFactory.CreateStyledButton($"{name}\n{address}", UIFactory.SUCCESS_GREEN);
                        btn.SetAllCaps(false);
                        btn.Click += (_, _) =>
                        {
                            discoveryHandle?.Dispose();
                            _appSettings.SelectedBluetoothDevice = address;
                            scannerStatus.Text = $"Scanner: {name}";
                            deviceListLayout.RemoveAllViews();
                            scanButton.Text = "Scan for scanners";
                            scanButton.Enabled = true;
                            if (_isBluetoothEnabledCheckBox.Checked)
                            {
                                _bluetoothManager?.Dispose();
                                InitializeBluetooth();
                            }
                        };
                        var btnParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
                        btnParams.SetMargins(0, 4, 0, 4);
                        btn.LayoutParameters = btnParams;
                        deviceListLayout.AddView(btn);
                    });
                }, () =>
                {
                    RunOnUiThread(() =>
                    {
                        scanButton.Text = "Scan for scanners";
                        scanButton.Enabled = true;
                    });
                });
            };

            scannerStatus.Visibility = Android.Views.ViewStates.Gone;
            deviceListLayout.Visibility = Android.Views.ViewStates.Gone;
            scannerSection.AddView(scannerStatus);
            var scanBtnParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            scanBtnParams.SetMargins(0, 4, 0, 4);
            scanButton.LayoutParameters = scanBtnParams;
            scannerSection.AddView(scanButton);
            scannerSection.AddView(deviceListLayout);
            _settingsCard.AddView(scannerSection);

            // 4. Box Tags + Sync + Logout/Login (horizontal row)
            _syncButton = _uiFactory.CreateStyledButton("Sync", UIFactory.PRIMARY_BLUE);
            _syncButton.Click += OnSyncClick;

            var actionRow = new PenguinMonitor.UI.FlowLayout(this);
            var actionDensity = Resources?.DisplayMetrics?.Density ?? 2;
            actionRow.HorizontalSpacing = (int)(6 * actionDensity);
            actionRow.VerticalSpacing = (int)(6 * actionDensity);
            var actionRowParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            actionRowParams.SetMargins(0, 4, 0, 4);
            actionRow.LayoutParameters = actionRowParams;

            var density = Resources?.DisplayMetrics?.Density ?? 2;
            var gap = (int)(3 * density);
            foreach (var btn in new[] { editBoxTagsButton, _syncButton, authButton as Button })
            {
                if (btn == null) continue;
                btn.SetPadding((int)(12 * density), (int)(8 * density), (int)(12 * density), (int)(8 * density));
                var p = new ViewGroup.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent);
                btn.LayoutParameters = p;
            }
            _syncButton.SetMinimumWidth((int)(100 * density));
            actionRow.AddView(editBoxTagsButton);
            actionRow.AddView(_syncButton);
            actionRow.AddView(authButton);
            _settingsCard.AddView(actionRow);
        }

        private void UpdateBoxSetsSelector()
        {
            //Update box sets selector spinner
            List<string> boxSets = (_appSettings.AllBoxSetsString ?? "").Split(new string[] { "},{", "{", "}" }, StringSplitOptions.RemoveEmptyEntries).ToList();
            boxSets.Add("All");
            ArrayAdapter<string> adapter = new ArrayAdapter<string>(this, Android.Resource.Layout.SimpleSpinnerItem, boxSets);
            adapter.SetDropDownViewResource(Android.Resource.Layout.SimpleSpinnerDropDownItem);
            _boxSetSelector.Adapter = adapter;
            if (_appSettings.BoxSetString != null && boxSets.Contains(_appSettings.BoxSetString))
                _boxSetSelector.SetSelection(boxSets.IndexOf(_appSettings.BoxSetString));
        }

        private void OnScrollViewTouch(object? sender, View.TouchEventArgs e)
        {
            if (e.Event?.Action == MotionEventActions.Down)
            {
                _lastTouchDownY = e.Event.GetY();
            }

            if (_gestureDetector != null && e.Event != null)
            {
                _gestureDetector.OnTouchEvent(e.Event);
            }
            e.Handled = false; // Allow scrolling to continue
        }
        private LinearLayout CreateStyledButtonLayout(params (string text, EventHandler handler, Color color)[] buttons)
        {
            var layout = new LinearLayout(this);
            for (int i = 0; i < buttons.Length; i++)
            {
                var (text, handler, color) = buttons[i];
                var button = _uiFactory.CreateStyledButton(text, color);
                button.Click += handler;

                var buttonParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1);
                if (i > 0) buttonParams.SetMargins(8, 0, 0, 0);
                button.LayoutParameters = buttonParams;

                layout.AddView(button);
            }
            return layout;
        }
        public bool IsTouchInContentArea(float touchY)
        {
            if (_singleBoxDataContentLayout == null) return false;

            int[] contentLocation = new int[2];
            _singleBoxDataContentLayout.GetLocationOnScreen(contentLocation);

            int contentTop = contentLocation[1] - (_rootScrollView?.ScrollY ?? 0);
            int contentBottom = contentTop + _singleBoxDataContentLayout.Height;

            return touchY >= contentTop && touchY <= contentBottom;
        }
        private LinearLayout CreateNavigationLayout()
        {
            var layout = new LinearLayout(this);
            layout.LayoutParameters = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            var density = Resources?.DisplayMetrics?.Density ?? 2;
            _prevBoxButton = _uiFactory.CreateStyledButton("← Prev", UIFactory.PRIMARY_BLUE);
            _prevBoxButton.Click += OnPrevBoxClick;
            _prevBoxButton.SetPadding((int)(12 * density), (int)(8 * density), (int)(12 * density), (int)(8 * density));
            var buttonParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1);
            buttonParams.SetMargins(8, 8, 8, 8);
            _prevBoxButton.LayoutParameters = buttonParams;

            _selectBoxButton = _uiFactory.CreateStyledButton("Select", UIFactory.PRIMARY_BLUE);
            _selectBoxButton.Click += (s,e) => ShowBoxJumpDialog();
            _selectBoxButton.SetPadding((int)(12 * density), (int)(8 * density), (int)(12 * density), (int)(8 * density));
            _selectBoxButton.LayoutParameters = buttonParams;

            _nextBoxButton = _uiFactory.CreateStyledButton("Next →", UIFactory.PRIMARY_BLUE);
            _nextBoxButton.Click += OnNextBoxClick;
            _nextBoxButton.SetPadding((int)(12 * density), (int)(8 * density), (int)(12 * density), (int)(8 * density));
            _nextBoxButton.LayoutParameters = buttonParams;

            layout.AddView(_prevBoxButton);
            layout.AddView(_selectBoxButton);
            layout.AddView(_nextBoxButton);

            return layout;
        }
        private string GetShowFilterText()
        {
            if (_appSettings.ShowAllBoxesInMultiBoxView)
                return "all";

            var filters = new List<string>();
            if (_appSettings.ShowBoxesWithDataInMultiBoxView) filters.Add("with data");
            if (_appSettings.ShowNoBoxesInMultiBoxView) filters.Add("NO");
            if (_appSettings.ShowUnlikleyBoxesInMultiBoxView) filters.Add("UNL");
            if (_appSettings.ShowPotentialBoxesInMultiBoxView) filters.Add("POT");
            if (_appSettings.ShowConfidentBoxesInMultiBoxView) filters.Add("CON");
            if (_appSettings.ShowBreedingBoxesInMultiBoxView) filters.Add("BR");
            if (_appSettings.ShowDCMBoxesInMultiboxView) filters.Add("DCM");
            if (_appSettings.ShowABNBoxesInMultiboxView) filters.Add("ABN");
            if (_appSettings.showBoxesWithNotesInMultiboxView) filters.Add("notes");
            if (_appSettings.ShowInterestingBoxesInMultiBoxView) filters.Add("box notes");
            if (_appSettings.ShowSingleEggBoxesInMultiboxView) filters.Add("1 egg");
            if (_appSettings.ShowDoubleEggBoxesInMultiboxView) filters.Add("2 egg");

            return filters.Count > 0 ? string.Join(", ", filters) : "none";
        }

        private string GetHideFilterText()
        {
            var filters = new List<string>();
            if (_appSettings.HideBoxesWithDataInMultiBoxView) filters.Add("with data");
            if (_appSettings.HideNoBoxesInMultiBoxView) filters.Add("NO");
            if (_appSettings.HideUnlikelyBoxesInMultiBoxView) filters.Add("UNL");
            if (_appSettings.HidePotentialBoxesInMultiBoxView) filters.Add("POT");
            if (_appSettings.HideConfidentBoxesInMultiBoxView) filters.Add("CON");
            if (_appSettings.HideBreedingBoxesInMultiBoxView) filters.Add("BR");
            if (_appSettings.HideDCMInMultiBoxView) filters.Add("DCM");
            if (_appSettings.HideABNInMultiBoxView) filters.Add("ABN");
            if (_appSettings.HideBoxesWithNotesInMultiboxView) filters.Add("notes");
            if (_appSettings.HideInterestingBoxesInMultiBoxView) filters.Add("box notes");
            if (_appSettings.HideSingleEggBoxesInMultiboxView) filters.Add("1 egg");
            if (_appSettings.HideDoubleEggBoxesInMultiboxView) filters.Add("2 egg");
            if (_appSettings.HideBeforeCurrentInMultiBoxView) filters.Add("<current");

            return filters.Count > 0 ? string.Join(", ", filters) : "none";
        }

        internal void DrawPageLayouts()
        {
            new Handler(Looper.MainLooper).Post(() =>
                {
                    // Day rollover: move yesterday's data to previous
                    if (!_isHistoricalView)
                        _colonyState.RolloverDay();

                    // Historical view mode
                    if (_appTitleText != null)
                        _appTitleText.Text = _isHistoricalView ? "Json Nest Viewer" : "NestCheck38";
                    if (_exitHistoricalButton != null)
                        _exitHistoricalButton.Visibility = _isHistoricalView ? ViewStates.Visible : ViewStates.Gone;
                    if (_isHistoricalView)
                    {
                        // Show title but hide settings expand and all other controls
                        if (_expandSettingsButton != null) _expandSettingsButton.Visibility = ViewStates.Gone;
                        if (_statusText != null)
                        {
                            _statusText.Text = _historicalFilename;
                            _statusText.Visibility = ViewStates.Visible;
                        }
                        if (_settingsCard != null) _settingsCard.Visibility = ViewStates.Gone;
                        if (_breedingDatesCard != null) _breedingDatesCard.Visibility = ViewStates.Gone;
                        if (_standaloneDailyLabelWarning != null) _standaloneDailyLabelWarning.Visibility = ViewStates.Gone;
                        if (_prevObsHeaderText != null) _prevObsHeaderText.Visibility = ViewStates.Gone;
                        if (_prevObsSummaryLayout != null) _prevObsSummaryLayout.Visibility = ViewStates.Gone;
                        if (_stickyNoteBar != null) _stickyNoteBar.Visibility = ViewStates.Gone;
                        if (_tagModeContentLayout != null) _tagModeContentLayout.Visibility = ViewStates.Gone;
                        if (_unsyncedCardsContainer != null) _unsyncedCardsContainer.Visibility = ViewStates.Gone;
                    }
                    else
                    {
                        if (_expandSettingsButton != null) _expandSettingsButton.Visibility = ViewStates.Visible;
                        if (_statusText != null) _statusText.Visibility = ViewStates.Visible;
                        if (_stickyNoteBar != null) _stickyNoteBar.Visibility = ViewStates.Visible;
                        if (_unsyncedCardsContainer != null) _unsyncedCardsContainer.Visibility = ViewStates.Visible;
                    }

                    // Box tag mode: hide normal content, show simplified tag view
                    bool tagMode = _appSettings.EditBoxTagsMode && !_isHistoricalView;
                    if (_singleBoxDataContentLayout != null && tagMode)
                        _singleBoxDataContentLayout.Visibility = ViewStates.Gone;
                    if (_multiBoxViewCard != null)
                        _multiBoxViewCard.Visibility = tagMode ? ViewStates.Gone : _multiBoxViewCard.Visibility;
                    if (_settingsCard != null)
                        _settingsCard.Visibility = tagMode ? ViewStates.Gone : _settingsCard.Visibility;
                    if (_breedingDatesCard != null)
                        _breedingDatesCard.Visibility = tagMode ? ViewStates.Gone : ViewStates.Visible;
                    // Keep prev obs and unsynced cards visible in tag mode, expanded by default
                    if (tagMode)
                    {
                        if (_prevObsSummaryLayout != null) _prevObsSummaryLayout.Visibility = ViewStates.Visible;
                        if (_prevObsDetailLayout != null) _prevObsDetailLayout.Visibility = ViewStates.Visible;
                    }

                    // Force single box view in tag mode
                    if (tagMode)
                    {
                        selectedPage = UIFactory.selectedPage.BoxDataSingle;
                    }

                    // Warnings below action buttons (always visible regardless of settings collapse)
                    UpdateDailyLabelWarnings();

                    // Tag mode content: today's data card + instruction text
                    if (_tagModeContentLayout != null)
                    {
                        _tagModeContentLayout.Visibility = tagMode ? ViewStates.Visible : ViewStates.Gone;
                        if (tagMode)
                        {
                            var tagCurrentObs = _colonyState.GetTodayForBox(_currentBoxName);
                            _tagModeTodayCard.RemoveAllViews();
                            if (tagCurrentObs != null)
                            {
                                var todayHeader = new TextView(this) { TextSize = 13, Text = BuildObsHeaderText(tagCurrentObs, "Today", true) };
                                todayHeader.SetTextColor(Color.Black);
                                todayHeader.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
                                _tagModeTodayCard.AddView(todayHeader);
                                _tagModeTodayCard.AddView(BuildObsDetailView(tagCurrentObs));
                                _tagModeTodayCard.Visibility = ViewStates.Visible;
                            }
                            else
                            {
                                _tagModeTodayCard.Visibility = ViewStates.Gone;
                            }

                            var hasTag = _boxTags.TryGetValue(_currentBoxName, out var tagInfo) && !string.IsNullOrEmpty(tagInfo.TagNumber);
                            var tagDetails = hasTag
                                ? $"Current tag: {tagInfo!.TagNumber}" + (tagInfo.Accuracy > 0 ? $" ({FormatAccuracy(tagInfo.Accuracy)})" : "")
                                : "No tag assigned.";

                            if (_isBoxLocked)
                            {
                                _tagModeInstructionText.Text = $"{tagDetails}\nUnlock the box to edit the tag.";
                                _tagModeInstructionText.SetTextColor(Color.DarkGray);
                            }
                            else
                            {
                                _tagModeInstructionText.Text = $"{tagDetails}\nPlace your phone on the box and wait for GPS to become accurate.\nThen scan the new box tag.";
                                _tagModeInstructionText.SetTextColor(UIFactory.PRIMARY_BLUE);
                            }
                        }
                    }

                    ///Single Box Card
                    // Hide expand/collapse button in tag mode, but keep lock icon and click area
                    if (_expandButton != null)
                    {
                        // Expand/collapse button is always available (except tag mode, which replaces the content)
                        _expandButton.Visibility = tagMode ? ViewStates.Gone : ViewStates.Visible;
                        // Keep the fold/unfold icon in sync with the actual content state
                        bool contentExpanded = _singleBoxDataContentLayout != null && _singleBoxDataContentLayout.Visibility == ViewStates.Visible;
                        _expandButton.SetImageResource(contentExpanded ? Resource.Drawable.fold : Resource.Drawable.unfold);
                        // Nav buttons are visible whenever the box is expanded (and always in tag mode for box navigation)
                        if (_boxNavigationButtonsLayout != null)
                            _boxNavigationButtonsLayout.Visibility = (tagMode || contentExpanded) ? ViewStates.Visible : ViewStates.Gone;
                        if (_discardButton != null)
                            _discardButton.Visibility = !_isBoxLocked && !tagMode ? ViewStates.Visible : ViewStates.Gone;
                    }

                    if (_dataCardLockIconView != null)
                    {
                        _dataCardLockIconView.SetColorFilter(null);
                        if (GetDisplayBoxData(_currentBoxName) == null && _isBoxLocked)
                        {
                            _dataCardLockIconView.SetImageResource(Resource.Drawable.locked_yellow);
                            _dataCardLockIconView.SetColorFilter(
                                new Android.Graphics.PorterDuffColorFilter(
                                    UIFactory.WARNING_YELLOW, // yellow
                                    Android.Graphics.PorterDuff.Mode.SrcIn));
                        }
                        else if (_isBoxLocked)
                        {
                            _dataCardLockIconView.SetImageResource(Resource.Drawable.locked_green);
                            _dataCardLockIconView.SetColorFilter(
                                new Android.Graphics.PorterDuffColorFilter(
                                    UIFactory.SUCCESS_GREEN,     // green
                                    Android.Graphics.PorterDuff.Mode.SrcIn));
                        }
                        else
                        {
                            _dataCardLockIconView.SetImageResource(Resource.Drawable.unlocked_red);
                            _dataCardLockIconView.SetColorFilter(
                                new Android.Graphics.PorterDuffColorFilter(
                                    UIFactory.DANGER_RED,     // red
                                    Android.Graphics.PorterDuff.Mode.SrcIn));
                        }
                    }

                    if (_dataCardTitleText != null)
                    {
                        _dataCardTitleText.Text = $"Box {_currentBoxName}";
                        // Show in red if viewing historical data
                        if (false /* no historical view */)
                            _dataCardTitleText.SetTextColor(UIFactory.DANGER_RED);
                        else
                            _dataCardTitleText.SetTextColor(Color.Black);
                    }

                    // Update box tag delete button visibility

                    // Show today's data info or pit_id for empty box
                    var currentObs = GetDisplayBoxData(_currentBoxName);
                    var tagStr = _boxTags.TryGetValue(_currentBoxName, out var bt) ? bt.TagNumber : "";
                    if (tagMode)
                    {
                        _boxSavedTimeTextView.Text = !string.IsNullOrEmpty(tagStr) ? $"Tag: {tagStr}" : "No tag";
                    }
                    else if (currentObs != null)
                    {
                        var nzTime = ToNzTime(currentObs.WhenDataCollectedUtc);
                        var who = !string.IsNullOrEmpty(currentObs.ObserverName) ? currentObs.ObserverName : "";
                        var syncLine = currentObs.IsPendingUpload ? "⏳ Unsynced" : "Synced";
                        _boxSavedTimeTextView.Text = $"{syncLine}\n{nzTime:HH:mm}" + (!string.IsNullOrEmpty(who) ? $"\n{who}" : "");
                        _boxSavedTimeTextView.SetTextColor(currentObs.IsPendingUpload ? UIFactory.DANGER_RED : Color.Black);
                    }
                    else
                    {
                        _boxSavedTimeTextView.Text = "";
                    }
                    _boxSavedTimeTextView.Gravity = GravityFlags.Right;

                    // Duplicate penguin warning for this box
                    if (_dupPenguinWarningView != null)
                    {
                        var boxObs = _colonyState.GetTodayForBox(_currentBoxName);
                        var dupWarnings = new List<string>();
                        if (boxObs != null)
                        {
                            foreach (var scan in boxObs.ScannedIds)
                            {
                                if (scan.BirdId.StartsWith("NOSCAN_")) continue;
                                var key = scan.BirdId.ToUpper();
                                foreach (var otherBox in _boxNamesAndIndexes.Keys)
                                {
                                    if (otherBox == _currentBoxName) continue;
                                    var otherObs = _colonyState.GetTodayForBox(otherBox);
                                    if (otherObs == null) continue;
                                    if (otherObs.ScannedIds.Any(s => s.BirdId.ToUpper() == key))
                                    {
                                        var (dupLabel, _, _, _) = LookupPenguinLabel(scan.BirdId);
                                        dupWarnings.Add($"⚠ {dupLabel} also in Box {otherBox}");
                                    }
                                }
                            }
                        }
                        if (dupWarnings.Count > 0)
                        {
                            _dupPenguinWarningView.Text = string.Join("\n", dupWarnings.Distinct());
                            _dupPenguinWarningView.Visibility = ViewStates.Visible;
                        }
                        else
                        {
                            _dupPenguinWarningView.Visibility = ViewStates.Gone;
                        }
                    }

                    // Update sticky note bar
                    if (_boxNotes.TryGetValue(_currentBoxName, out var boxNote) && !string.IsNullOrWhiteSpace(boxNote.PersistentNotes))
                    {
                        _interestingBoxTextView.Text = boxNote.PersistentNotes;
                    }
                    else
                    {
                        _interestingBoxTextView.Text = "";
                    }
                    if (_stickyNoteBar != null)
                        _stickyNoteBar.Clickable = !_isBoxLocked;

                    var editTexts = new[] { _adultsEditText, _eggsEditText, _chicksEditText, _notesEditText };
                    _suppressDataChanged = true;

                    foreach (var editText in editTexts)
                    {
                        if (editText != null) editText[0].TextChanged -= OnDataChanged;
                    }

                    var displayData = GetDisplayBoxData(_currentBoxName);
                    if (displayData != null)
                    {
                        var boxData = displayData;
                        if (_adultsEditText != null) _adultsEditText[0].Text = boxData.Adults.ToString();
                        if (_eggsEditText != null) _eggsEditText[0].Text = boxData.Eggs.ToString();
                        if (_chicksEditText != null) _chicksEditText[0].Text = boxData.Chicks.ToString();
                        SetSpinnerStatus(_gateStatusSpinner[0], boxData.GateStatus);
                        if (_notesEditText != null) _notesEditText[0].Text = boxData.Notes;
                        buildScannedIdsLayout(boxData.ScannedIds);
                        var breedingVal = !string.IsNullOrWhiteSpace(boxData.BreedingStatus) ? boxData.BreedingStatus
                            : (_boxNotes.TryGetValue(_currentBoxName, out var bn1) && !string.IsNullOrEmpty(bn1.BreedingStatus) ? bn1.BreedingStatus : "");
                        SetSpinnerStatus(_breedingChanceSpinner[0], breedingVal);
                    }
                    else
                    {
                        // Empty box — pre-fill breeding status from previous observation or box notes
                        if (_adultsEditText != null) _adultsEditText[0].Text = "0";
                        if (_eggsEditText != null) _eggsEditText[0].Text = "0";
                        if (_chicksEditText != null) _chicksEditText[0].Text = "0";
                        SetSpinnerStatus(_gateStatusSpinner[0], null);
                        if (_notesEditText != null) _notesEditText[0].Text = "";
                        buildScannedIdsLayout(new List<ScanRecord>());

                        var prev = _colonyState.PreviousBoxes.ContainsKey(_currentBoxName) ? _colonyState.PreviousBoxes[_currentBoxName] : null;
                        var breedingFallback = prev != null && !string.IsNullOrEmpty(prev.BreedingStatus) ? prev.BreedingStatus
                            : (_boxNotes.TryGetValue(_currentBoxName, out var bn2) && !string.IsNullOrEmpty(bn2.BreedingStatus) ? bn2.BreedingStatus : "");
                        SetSpinnerStatus(_breedingChanceSpinner[0], breedingFallback);
                    }

                    foreach (var editText in editTexts)
                        if (editText != null) editText[0].TextChanged += OnDataChanged;
                    // Clear suppress after spinner events fire (they're queued after this Post)
                    new Handler(Looper.MainLooper).Post(() => _suppressDataChanged = false);

                    // Update previous observation summary
                    UpdatePreviousObsSummary();

                    // Nav buttons are item 0, title layout is item 1 — don't disable either
                    for (int i = 2; i < _singleBoxDataOuterLayout.ChildCount; i++)
                    {
                        var child = _singleBoxDataOuterLayout.GetChildAt(i);
                        // Keep previous obs summary, unsynced cards, and tag mode content always interactive
                        if (child == _prevObsSummaryLayout || child == _unsyncedCardsContainer || child == _tagModeContentLayout) continue;
                        // Disable editing when box is locked
                        bool shouldDisable = _isBoxLocked;
                        SetEnabledRecursive(child, !shouldDisable, shouldDisable ? 0.8f : 1.0f);
                    }
                    // Previous obs summary is always interactive regardless of lock state
                    if (_prevObsSummaryLayout != null)
                    {
                        _prevObsSummaryLayout.Enabled = true;
                        _prevObsSummaryLayout.Clickable = true;
                        _prevObsSummaryLayout.Alpha = 1.0f;
                        if (_prevObsHeaderText != null) { _prevObsHeaderText.Enabled = true; _prevObsHeaderText.Alpha = 1.0f; }
                        if (_prevObsDetailLayout != null) { _prevObsDetailLayout.Enabled = true; _prevObsDetailLayout.Alpha = 1.0f; }
                    }

                    // Enable/Disable navigation and data buttons when available
                    List<Button> buttonsToToggle = new List<Button> { _prevBoxButton, _selectBoxButton, _nextBoxButton };
                    foreach (var button in buttonsToToggle)
                    {
                        bool canGo = true;
                        if(button.Text.Contains("rev box") && _currentBoxIndex == 1 || button.Text.Contains("ext box") && _currentBoxIndex == _boxNamesAndIndexes.Count)
                        {
                            canGo = false;
                        }
                        button.Enabled = _isBoxLocked && canGo;
                        button.Alpha = button.Enabled ? 1.0f : 0.5f;
                    }


                    createMultiBoxViewCard();
                    createBreedingDatesCard();

                    // Complete a deferred "forgot to lock" navigation once the box is finally locked
                    if (_isBoxLocked && _pendingBoxTagNavigation != null)
                    {
                        var pending = _pendingBoxTagNavigation;
                        _pendingBoxTagNavigation = null;
                        _pendingScanQueueFrozen = false;
                        NavigateToPendingBox(pending!);
                    }
                });
        }
        private bool dataCardHasZeroData()
        {
            int.TryParse(_adultsEditText?[0].Text ?? "0", out int adults);
            int.TryParse(_eggsEditText?[0].Text ?? "0", out int eggs);
            int.TryParse(_chicksEditText?[0].Text ?? "0", out int chicks);

            string? gate = GetSelectedStatus(_gateStatusSpinner[0]); // returns null for blank
            bool noGate = string.IsNullOrEmpty(gate);
            bool noNotes = string.IsNullOrWhiteSpace(_notesEditText?[0].Text);

            return adults == 0 && eggs == 0 && chicks == 0  && noGate && noNotes;
        }
        private (string label, string sex, bool isChick, PenguinData? pd) LookupPenguinLabel(string birdId)
        {
            var cleanId = new string(birdId.Where(char.IsLetterOrDigit).ToArray()).ToUpper();
            var shortId = cleanId.Length >= 8 ? cleanId.Substring(cleanId.Length - 8) : cleanId;
            string label = shortId;
            string sex = "";
            bool isChick = false;

            PenguinData? pd = null;
            if (_remotePenguinData != null)
            {
                if (!_remotePenguinData.TryGetValue(cleanId, out pd))
                    if (!_remotePenguinData.TryGetValue(shortId, out pd))
                        pd = _remotePenguinData.Values.FirstOrDefault(p => p.VidForScanner == birdId);
            }

            if (pd != null)
            {
                sex = pd.Sex?.ToUpper() ?? "";
                isChick = pd.ChipAs != "Adult" && pd.ChipDate > DateTime.MinValue && (DateTime.UtcNow - pd.ChipDate).TotalDays < 90;
                var num = !string.IsNullOrEmpty(pd.PengNum) ? $"#{pd.PengNum}" : "";
                var sexOrSize = !string.IsNullOrEmpty(pd.ChickSizeCode)
                    ? (sex != "" ? $"{pd.ChickSizeCode}{sex[0]}" : pd.ChickSizeCode)
                    : (sex == "M" ? "♂" : sex == "F" ? "♀" : "");
                label = $"{num} {sexOrSize} {pd.ScannedId}".Trim();
            }

            return (label, sex, isChick, pd);
        }

        private TextView CreateScanBadge(string birdId, Action? onClick = null, float textSize = 10)
        {
            if (birdId.StartsWith("NOSCAN_"))
            {
                var nsb = new TextView(this) { Text = "No scan", TextSize = textSize };
                var nsPadH = (int)(8 * textSize / 10);
                var nsPadV = (int)(3 * textSize / 10);
                nsb.SetPadding(nsPadH, nsPadV, nsPadH, nsPadV);
                nsb.Background = _uiFactory.CreateRoundedBackground(SCAN_CHIPPED_TODAY_BG, 4);
                nsb.SetTextColor(Color.DarkGray);
                nsb.SetTypeface(Android.Graphics.Typeface.Monospace, Android.Graphics.TypefaceStyle.Normal);
                return nsb;
            }
            var (label, sex, isChick, _) = LookupPenguinLabel(birdId);

            var badge = new TextView(this) { Text = label, TextSize = textSize };
            var padH = (int)(8 * textSize / 10);
            var padV = (int)(3 * textSize / 10);
            badge.SetPadding(padH, padV, padH, padV);

            Color bg = isChick ? SCAN_CHICK_BG : sex == "M" ? SCAN_MALE_BG : sex == "F" ? SCAN_FEMALE_BG : SCAN_UNKNOWN_BG;
            badge.Background = _uiFactory.CreateRoundedBackground(bg, 4);
            badge.SetTextColor(sex == "M" ? SCAN_MALE_TEXT : sex == "F" ? SCAN_FEMALE_TEXT : Color.DarkGray);
            badge.SetTypeface(Android.Graphics.Typeface.Monospace, Android.Graphics.TypefaceStyle.Normal);

            if (onClick != null)
            {
                badge.Clickable = true;
                badge.Click += (s, e) => onClick();
            }

            return badge;
        }

        private static readonly Color SCAN_MALE_BG = Color.ParseColor("#E6F3FF");
        private static readonly Color SCAN_FEMALE_BG = Color.ParseColor("#FFE4E1");
        private static readonly Color SCAN_UNKNOWN_BG = Color.ParseColor("#F0F0F0");
        private static readonly Color SCAN_CHICK_BG = Color.ParseColor("#FFF9C4");
        private static readonly Color SCAN_CHIPPED_TODAY_BG = Color.ParseColor("#C8E6C9");
        private static readonly Color SCAN_MALE_TEXT = Color.ParseColor("#1565C0");
        private static readonly Color SCAN_FEMALE_TEXT = Color.ParseColor("#C62828");

        /// <summary>
        /// Build the observation detail as a View (not just text) so scans can be styled badges.
        /// </summary>
        private View BuildObsDetailView(BoxObservation obs, bool showBoxLink = true)
        {
            var layout = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };

            // Status row: breeding% | icons | gate — evenly spaced
            var statusItems = new List<(string text, int size)>();
            if (!string.IsNullOrEmpty(obs.BreedingStatus)) statusItems.Add((obs.BreedingStatus, 13));
            var icons = string.Concat(Enumerable.Repeat("🐧", obs.Adults)) +
                string.Concat(Enumerable.Repeat("🥚", obs.Eggs)) +
                string.Concat(Enumerable.Repeat("🐣", obs.Chicks));
            if (!string.IsNullOrEmpty(icons)) statusItems.Add((icons, 14));
            if (!string.IsNullOrEmpty(obs.GateStatus)) statusItems.Add((obs.GateStatus, 13));

            if (statusItems.Count > 0)
            {
                var statusRow = new LinearLayout(this);
                statusRow.SetGravity(GravityFlags.CenterVertical);
                statusRow.LayoutParameters = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
                var spacerParams = new LinearLayout.LayoutParams(0, 1, 1f);

                foreach (var (text, size) in statusItems)
                {
                    statusRow.AddView(new View(this) { LayoutParameters = spacerParams });
                    var tv = new TextView(this) { Text = text, TextSize = size };
                    tv.SetTextColor(Color.DarkGray);
                    tv.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
                    tv.LayoutParameters = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent);
                    statusRow.AddView(tv);
                }
                statusRow.AddView(new View(this) { LayoutParameters = spacerParams });

                layout.AddView(statusRow);
            }

            // Notes (if any)
            if (!string.IsNullOrEmpty(obs.Notes))
            {
                var notesText = new TextView(this) { Text = obs.Notes, TextSize = 11 };
                notesText.SetTextColor(Color.DarkGray);
                notesText.SetPadding(0, 4, 0, 0);
                layout.AddView(notesText);
            }

            // Badge row: box link first, then scan badges
            var scansRow = new LinearLayout(this);
            scansRow.SetPadding(0, 6, 0, 0);
            var flowParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent);
            flowParams.SetMargins(0, 2, 4, 2);

            // Box link badge — always first (unless suppressed)
            if (showBoxLink && !string.IsNullOrEmpty(obs.BoxName))
            {
                var boxName = obs.BoxName;
                var boxBadge = new TextView(this) { Text = $"Box {boxName} →", TextSize = 10 };
                boxBadge.SetPadding(8, 3, 8, 3);
                boxBadge.LayoutParameters = flowParams;
                boxBadge.Background = _uiFactory.CreateRoundedBackground(UIFactory.PRIMARY_BLUE, 4);
                boxBadge.SetTextColor(Color.White);
                boxBadge.SetTypeface(Android.Graphics.Typeface.Monospace, Android.Graphics.TypefaceStyle.Normal);
                boxBadge.Clickable = true;
                boxBadge.Click += (s, e) =>
                {
                    StartActivity(new Android.Content.Intent(Android.Content.Intent.ActionView,
                        Android.Net.Uri.Parse($"https://wildwatch.co.nz/box/{boxName}")));
                };
                scansRow.AddView(boxBadge);
            }

            foreach (var s in obs.ScannedIds)
            {
                var badgeBirdId = s.BirdId;
                var badge = CreateScanBadge(badgeBirdId, () => ShowBirdDialog(badgeBirdId, isTodayScan: false), textSize: 10);
                badge.LayoutParameters = flowParams;
                scansRow.AddView(badge);
            }

            layout.AddView(scansRow);

            return layout;
        }

        /// <summary>
        /// Build a header line for an observation card.
        /// </summary>
        private string BuildObsHeaderText(BoxObservation obs, string label, bool expanded)
        {
            var nzDate = ToNzTime(obs.WhenDataCollectedUtc);
            int daysAgo = (int)(NzToday - nzDate.Date).TotalDays;
            string dateStr = daysAgo == 0 ? "today" : daysAgo == 1 ? "yesterday" : $"{daysAgo} days ago";
            string byWhom = !string.IsNullOrEmpty(obs.ObserverName) ? $" by {obs.ObserverName}" : "";
            string arrow = expanded ? "▾" : "▸";
            string boxStr = !string.IsNullOrEmpty(obs.BoxName) ? $"Box {obs.BoxName} " : "";
            if (expanded)
                return $"{arrow} {boxStr}{label}: {nzDate:d MMM HH:mm}{byWhom}";
            string status = !string.IsNullOrEmpty(obs.BreedingStatus) ? $" {obs.BreedingStatus}" : "";
            return $"{arrow} {boxStr}{label}: {nzDate:d MMM HH:mm}{byWhom} — " +
                $"{string.Concat(Enumerable.Repeat("🐧", obs.Adults))}" +
                $"{string.Concat(Enumerable.Repeat("🥚", obs.Eggs))}" +
                $"{string.Concat(Enumerable.Repeat("🐣", obs.Chicks))}" +
                status;
        }

        private void UpdatePreviousObsSummary()
        {
            if (_prevObsHeaderText == null || _prevObsDetailLayout == null || _prevObsSummaryLayout == null) return;

            var prev = _colonyState.PreviousBoxes.ContainsKey(_currentBoxName) ? _colonyState.PreviousBoxes[_currentBoxName] : null;
            if (prev == null)
            {
                _prevObsHeaderText.Visibility = ViewStates.Gone;
                _prevObsSummaryLayout.Visibility = ViewStates.Gone;
                UpdateUnsyncedCards();
                return;
            }

            // Compact header: date: icons, show breeding status if no eggs/chicks
            var nzDate = ToNzTime(prev.WhenDataCollectedUtc);
            string compact = $"{nzDate:d MMM}: " +
                string.Concat(Enumerable.Repeat("🐧", prev.Adults)) +
                string.Concat(Enumerable.Repeat("🥚", prev.Eggs)) +
                string.Concat(Enumerable.Repeat("🐣", prev.Chicks));
            if (prev.Eggs == 0 && prev.Chicks == 0 && !string.IsNullOrEmpty(prev.BreedingStatus))
                compact += $" {prev.BreedingStatus}";

            bool expanded = _prevObsDetailLayout.Visibility == ViewStates.Visible;

            // Hide compact badge when expanded
            _prevObsHeaderText.Text = compact;
            _prevObsHeaderText.Visibility = expanded ? ViewStates.Gone : ViewStates.Visible;

            if (expanded)
            {
                _prevObsSummaryLayout.Visibility = ViewStates.Visible;
                _prevObsDetailLayout.RemoveAllViews();
                _prevObsDetailLayout.AddView(BuildObsDetailView(prev));

                // Date label bottom-right
                var dateLabel = new TextView(this) { Text = nzDate.ToString("d MMM"), TextSize = 11 };
                dateLabel.SetTextColor(Color.Gray);
                dateLabel.Gravity = GravityFlags.Right;
                dateLabel.LayoutParameters = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
                _prevObsDetailLayout.AddView(dateLabel);
            }

            // Update today miniview
            UpdateTodayMiniView();

            UpdateUnsyncedCards();
        }

        private void UpdateTodayMiniView()
        {
            if (_todayMiniView == null) return;
            var today = _colonyState.GetTodayForBox(_currentBoxName);
            if (today == null)
            {
                _todayMiniView.Visibility = ViewStates.Gone;
                return;
            }
            string text = string.Concat(Enumerable.Repeat("🐧", today.Adults)) +
                string.Concat(Enumerable.Repeat("🥚", today.Eggs)) +
                string.Concat(Enumerable.Repeat("🐣", today.Chicks));
            if (!string.IsNullOrEmpty(today.BreedingStatus) && today.BreedingStatus != "BR")
                text += $" {today.BreedingStatus}";
            if (!string.IsNullOrEmpty(today.GateStatus))
                text += $" {today.GateStatus}";
            if (string.IsNullOrWhiteSpace(text)) text = "Empty";
            _todayMiniView.Text = text;
            _todayMiniView.Visibility = ViewStates.Visible;
        }

        private LinearLayout? _unsyncedCardsContainer;

        private void UpdateUnsyncedCards()
        {
            if (_unsyncedCardsContainer == null) return;
            _unsyncedCardsContainer.RemoveAllViews();

            var nzToday = NzToday;
            var olderPending = _colonyState.PendingObservations
                .Where(o => o.BoxName == _currentBoxName && ToNzTime(o.WhenDataCollectedUtc).Date < nzToday)
                .OrderByDescending(o => o.WhenDataCollectedUtc)
                .ToList();

            foreach (var obs in olderPending)
            {
                var card = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };
                card.SetPadding(12, 8, 12, 8);
                card.Background = _uiFactory.CreateCardBackground(borderWidth: 6, borderColour: UIFactory.DANGER_RED);
                var cardParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
                cardParams.SetMargins(0, 0, 0, 8);
                card.LayoutParameters = cardParams;

                var headerText = new TextView(this) { TextSize = 13 };
                headerText.SetTextColor(UIFactory.DANGER_RED);
                headerText.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
                headerText.Text = BuildObsHeaderText(obs, "Unsynced", false);
                card.AddView(headerText);

                var detailLayout = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };
                detailLayout.Visibility = ViewStates.Gone;
                card.AddView(detailLayout);

                card.Click += (s, e) =>
                {
                    bool wasVisible = detailLayout.Visibility == ViewStates.Visible;
                    detailLayout.Visibility = wasVisible ? ViewStates.Gone : ViewStates.Visible;
                    headerText.Text = BuildObsHeaderText(obs, "Unsynced", !wasVisible);
                    if (!wasVisible)
                    {
                        detailLayout.RemoveAllViews();
                        detailLayout.AddView(BuildObsDetailView(obs));
                    }
                };

                _unsyncedCardsContainer.AddView(card);
            }
        }

        private void CreateBoxDataCard()
        {
            _singleBoxDataOuterLayout = _uiFactory.CreateCard();
            _singleBoxDataOuterLayout.Visibility = ViewStates.Visible;

            // Horizontal layout for lock icon + box title
            _singleBoxDataTitleLayout = new LinearLayout(this)
            {
                Clickable = true,
                Focusable = true
            };
            _singleBoxDataTitleLayout.SetGravity(GravityFlags.Center);
            _expandButton = new ImageButton(this);
            _expandButton.LayoutParameters = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent);
            var expandSingleBoxImageButton = _expandButton;
            expandSingleBoxImageButton.SetImageResource(Resource.Drawable.unfold);
            expandSingleBoxImageButton.SetBackgroundColor(Color.Transparent);
            expandSingleBoxImageButton.Click += (s, e) =>
            {
                if (_singleBoxDataContentLayout.Visibility == ViewStates.Gone)
                {
                    _singleBoxDataContentLayout.Visibility = ViewStates.Visible;
                    _boxNavigationButtonsLayout.Visibility = ViewStates.Visible;
                    expandSingleBoxImageButton.SetImageResource(Resource.Drawable.fold);
                }
                else
                {
                    _singleBoxDataContentLayout.Visibility = ViewStates.Gone;
                    _boxNavigationButtonsLayout.Visibility = ViewStates.Gone;
                    expandSingleBoxImageButton.SetImageResource(Resource.Drawable.unfold);
                }
            };
            _singleBoxDataTitleLayout.AddView(expandSingleBoxImageButton);
            _singleBoxDataTitleLayout.Click += (sender, e) =>
            {
                _isBoxLocked = !_isBoxLocked;
                if (!_isBoxLocked)
                {
                    // Unlock — enter edit mode
                    _dataChangedSinceUnlock = false;
                    _highOffspringCountConfirmed = false;
                    if (!_appSettings.EditBoxTagsMode)
                        _singleBoxDataContentLayout.Visibility = ViewStates.Visible;
                    DrawPageLayouts();
                }
                else
                {
                    // In tag mode or historical view, just lock without saving
                    if (_appSettings.EditBoxTagsMode || _isHistoricalView)
                    {
                        _dataChangedSinceUnlock = false;
                        DrawPageLayouts();
                        return;
                    }

                    // No changes and box already has today data — lock silently
                    if (!_dataChangedSinceUnlock && _colonyState.GetTodayForBox(_currentBoxName) != null)
                    {
                        _dataChangedSinceUnlock = false;
                        DrawPageLayouts();
                        return;
                    }

                    // All zeros and no prior today data — confirm empty
                    if (_colonyState.GetTodayForBox(_currentBoxName) == null && dataCardHasZeroData())
                    {
                        ShowEmptyBoxDialog(() =>
                        {
                            SaveCurrentBoxData();
                            _dataChangedSinceUnlock = false;
                            DrawPageLayouts();
                            TryBackgroundUpload();
                        }, () =>
                        {
                            _dataChangedSinceUnlock = false;
                            DrawPageLayouts();
                        });
                    }
                    else
                    {
                        // If box has existing server data, show confirm edit dialog
                        var serverVersion = _colonyState.TodayBoxes.ContainsKey(_currentBoxName)
                            ? _colonyState.TodayBoxes[_currentBoxName] : null;
                        if (serverVersion != null && !serverVersion.IsPendingUpload)
                        {
                            ShowLocalConfirmEditDialog(_currentBoxName, serverVersion, () =>
                            {
                                if (serverVersion.ObservationId.HasValue)
                                    _confirmedAgainstServerObsId[_currentBoxName] = serverVersion.ObservationId.Value;
                                SaveCurrentBoxData();
                                // Stamp the confirmed obs ID onto the pending observation
                                var pending = _colonyState.PendingObservations.FirstOrDefault(p => p.BoxName == _currentBoxName && p.IsPendingUpload);
                                if (pending != null && serverVersion.ObservationId.HasValue)
                                    pending.ConfirmedAgainstObsId = serverVersion.ObservationId.Value;
                                _dataChangedSinceUnlock = false;
                                DrawPageLayouts();
                                TryBackgroundUpload();
                            }, () =>
                            {
                                // Restore server version — remove any pending edit for this box
                                _colonyState.PendingObservations.RemoveAll(p => p.BoxName == _currentBoxName && p.IsPendingUpload);
                                _dataChangedSinceUnlock = false;
                                DrawPageLayouts();
                            });
                        }
                        else
                        {
                            SaveCurrentBoxData();
                            _dataChangedSinceUnlock = false;
                            DrawPageLayouts();
                            TryBackgroundUpload();
                        }
                    }
                }
            };

            // Add a spacer that expands to fill available space
            var spacer = new View(this);
            spacer.LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MatchParent, 1f);
            _singleBoxDataTitleLayout.AddView(spacer);

            // Box title text
            _dataCardTitleText = new TextView(this)
            {
                Text = $"Box {_currentBoxIndex}  ",
                TextSize = 30,
                Gravity = GravityFlags.Center
            };
            _dataCardTitleText.SetTextColor(UIFactory.TEXT_PRIMARY);
            _dataCardTitleText.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            _dataCardTitleText.LayoutParameters = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent);
            _singleBoxDataTitleLayout.AddView(_dataCardTitleText);

            var boxTitleParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            boxTitleParams.SetMargins(0, 0, 0, 16);
            _singleBoxDataTitleLayout.LayoutParameters = boxTitleParams;

            // Lock icon
            _dataCardLockIconView = new ImageView(this);
            _dataCardLockIconView.SetImageResource(Android.Resource.Drawable.IcLockLock);
            var iconParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent);
            iconParams.SetMargins(0, 0, 12, 0); // Space between icon and text
            _dataCardLockIconView.LayoutParameters = iconParams;
            _singleBoxDataTitleLayout.AddView(_dataCardLockIconView);

            // Spacer between title and saved time
            var titleSpacer = new View(this);
            titleSpacer.LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MatchParent, 1f);
            _singleBoxDataTitleLayout.AddView(titleSpacer);

            _boxSavedTimeTextView = new TextView(this);
            _singleBoxDataTitleLayout.AddView(_boxSavedTimeTextView);

            // Discard button — visible only when unlocked
            _discardButton = new TextView(this) { Text = "✕", TextSize = 14, Gravity = GravityFlags.Center };
            _discardButton.SetTextColor(Color.White);
            _discardButton.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            _discardButton.Background = _uiFactory.CreateRoundedBackground(UIFactory.DANGER_RED, 6);
            var discardParams = new LinearLayout.LayoutParams(
                (int)(28 * (Resources?.DisplayMetrics?.Density ?? 2)),
                (int)(28 * (Resources?.DisplayMetrics?.Density ?? 2)));
            discardParams.SetMargins(12, 0, 4, 0);
            _discardButton.LayoutParameters = discardParams;
            _discardButton.Visibility = ViewStates.Gone;
            _discardButton.Clickable = true;
            _discardButton.Click += (s, e) =>
            {
                if (_dataChangedSinceUnlock)
                {
                    bool hasServerData = _colonyState.TodayBoxes.ContainsKey(_currentBoxName);
                    new AlertDialog.Builder(this)
                        .SetMessage(hasServerData ? "Discard changes?" : "Discard data?")
                        .SetPositiveButton(hasServerData ? "Discard changes" : "Discard data", (s2, e2) =>
                        {
                            _colonyState.PendingObservations.RemoveAll(p => p.BoxName == _currentBoxName && p.IsPendingUpload);
                            _isBoxLocked = true;
                            _dataChangedSinceUnlock = false;
                            DrawPageLayouts();
                        })
                        .SetNegativeButton("Cancel", (s2, e2) => { })
                        .Show();
                }
                else
                {
                    _isBoxLocked = true;
                    _dataChangedSinceUnlock = false;
                    DrawPageLayouts();
                }
            };
            _singleBoxDataTitleLayout.AddView(_discardButton);

            // Navigation buttons above the box header
            _boxNavigationButtonsLayout = CreateNavigationLayout();
            _singleBoxDataOuterLayout.AddView(_boxNavigationButtonsLayout);

            _singleBoxDataOuterLayout.AddView(_singleBoxDataTitleLayout);

            _singleBoxDataContentLayout = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };

            // Combined row: [prev obs compact] [sticky notes centered]
            var prevAndStickyRow = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Horizontal };
            prevAndStickyRow.SetGravity(GravityFlags.CenterVertical);
            prevAndStickyRow.SetPadding(4, 4, 4, 4);
            var prevAndStickyParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            prevAndStickyParams.SetMargins(0, 0, 0, 4);
            prevAndStickyRow.LayoutParameters = prevAndStickyParams;

            // Prev obs compact summary (left-aligned)
            _prevObsHeaderText = new TextView(this) { TextSize = 11 };
            _prevObsHeaderText.SetTextColor(Color.DarkGray);
            _prevObsHeaderText.SetPadding(8, 4, 8, 4);
            _prevObsHeaderText.Background = _uiFactory.CreateRoundedBackground(Color.ParseColor("#FFF3E0"), 6); // light orange
            var prevCompactParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent);
            _prevObsHeaderText.LayoutParameters = prevCompactParams;
            _prevObsHeaderText.Click += (s, e) =>
            {
                // Expand: show full-width detail below
                _prevObsDetailLayout.Visibility = ViewStates.Visible;
                _prevObsSummaryLayout.Visibility = ViewStates.Visible;
                UpdatePreviousObsSummary();
            };
            prevAndStickyRow.AddView(_prevObsHeaderText);

            // Sticky note bar (fills remaining space, centered)
            _stickyNoteBar = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Horizontal };
            _stickyNoteBar.SetGravity(GravityFlags.Center);
            _stickyNoteBar.SetPadding(8, 4, 8, 4);
            var stickyBarParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1f);
            _stickyNoteBar.LayoutParameters = stickyBarParams;

            var bulb1 = new TextView(this) { Text = "💡", TextSize = 14 };
            _interestingBoxTextView = new TextView(this) { TextSize = 12 };
            _interestingBoxTextView.SetTextColor(UIFactory.PRIMARY_BLUE);
            _interestingBoxTextView.SetPadding(2, 0, 2, 0);
            var bulb2 = new TextView(this) { Text = "💡", TextSize = 14 };

            _stickyNoteBar.AddView(bulb1);
            _stickyNoteBar.AddView(_interestingBoxTextView);
            _stickyNoteBar.AddView(bulb2);
            _stickyNoteBar.Click += (s, e) => { if (!_isBoxLocked) ShowBoxNotesDialog(); };
            prevAndStickyRow.AddView(_stickyNoteBar);

            // Duplicate penguin warning
            _dupPenguinWarningView = new TextView(this) { TextSize = 13 };
            _dupPenguinWarningView.SetTextColor(UIFactory.DANGER_RED);
            _dupPenguinWarningView.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            _dupPenguinWarningView.SetPadding(12, 4, 12, 4);
            _dupPenguinWarningView.Visibility = ViewStates.Gone;
            _singleBoxDataOuterLayout.AddView(_dupPenguinWarningView);

            // Today miniview (right-aligned, black border)
            _todayMiniView = new TextView(this) { TextSize = 11 };
            _todayMiniView.SetTextColor(Color.Black);
            _todayMiniView.SetPadding(8, 4, 8, 4);
            var todayMiniViewBg = new Android.Graphics.Drawables.GradientDrawable();
            todayMiniViewBg.SetColor(Color.White);
            todayMiniViewBg.SetCornerRadius(6 * (Resources?.DisplayMetrics?.Density ?? 2));
            todayMiniViewBg.SetStroke((int)(2 * (Resources?.DisplayMetrics?.Density ?? 2)), Color.Black);
            _todayMiniView.Background = todayMiniViewBg;
            _todayMiniView.LayoutParameters = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent);
            _todayMiniView.Visibility = ViewStates.Gone;
            prevAndStickyRow.AddView(_todayMiniView);

            _singleBoxDataOuterLayout.AddView(prevAndStickyRow);

            // Prev obs expanded detail (full width, below the row)
            _prevObsSummaryLayout = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };
            _prevObsSummaryLayout.SetPadding(12, 8, 12, 8);
            _prevObsSummaryLayout.Background = _uiFactory.CreateCardBackground(borderWidth: 4, borderColour: UIFactory.WARNING_YELLOW);
            var prevExpandedParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            prevExpandedParams.SetMargins(0, 0, 0, 8);
            _prevObsSummaryLayout.LayoutParameters = prevExpandedParams;
            _prevObsSummaryLayout.Visibility = ViewStates.Gone;

            _prevObsDetailLayout = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };
            _prevObsDetailLayout.Visibility = ViewStates.Gone;
            _prevObsSummaryLayout.AddView(_prevObsDetailLayout);

            _prevObsSummaryLayout.Click += (s, e) =>
            {
                _prevObsDetailLayout.Visibility = ViewStates.Gone;
                _prevObsSummaryLayout.Visibility = ViewStates.Gone;
                UpdatePreviousObsSummary();
            };
            _singleBoxDataOuterLayout.AddView(_prevObsSummaryLayout);

            // Container for red unsynced cards (older pending observations)
            _unsyncedCardsContainer = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };
            _singleBoxDataOuterLayout.AddView(_unsyncedCardsContainer);

            // Tag mode content — shown instead of normal data entry when editing box tags
            _tagModeContentLayout = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };
            _tagModeContentLayout.SetPadding(12, 8, 12, 8);
            _tagModeContentLayout.Visibility = ViewStates.Gone;

            _tagModeTodayCard = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };
            _tagModeTodayCard.SetPadding(12, 8, 12, 8);
            _tagModeTodayCard.Background = _uiFactory.CreateCardBackground(borderWidth: 4, borderColour: Color.Black);
            var todayCardParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            todayCardParams.SetMargins(0, 0, 0, 8);
            _tagModeTodayCard.LayoutParameters = todayCardParams;
            _tagModeContentLayout.AddView(_tagModeTodayCard);

            _tagModeInstructionText = new TextView(this) { TextSize = 14 };
            _tagModeInstructionText.SetPadding(0, 8, 0, 8);
            _tagModeContentLayout.AddView(_tagModeInstructionText);

            _singleBoxDataOuterLayout.AddView(_tagModeContentLayout);

            _scannedIdsLayout = new List<LinearLayout?>();
            // Scanned birds container
            _scannedIdsLayout.Add(new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical });
            _scannedIdsLayout[0].SetPadding(16, 16, 16, 16);
            _scannedIdsLayout[0].Background = _uiFactory.CreateRoundedBackground(UIFactory.LIGHTER_GRAY, 8);
            var idsParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            idsParams.SetMargins(0, 0, 0, 16);
            _scannedIdsLayout[0].LayoutParameters = idsParams;
            _singleBoxDataContentLayout.AddView(_scannedIdsLayout[0]);

            // Headings row: Adults, Eggs, Chicks, Gate Status
            var headingsLayout = new LinearLayout(this);
            var headingsParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            headingsParams.SetMargins(0, 0, 0, 8);
            headingsLayout.LayoutParameters = headingsParams;

            var adultsLabel = _uiFactory.CreateDataLabel("Adults");
            var eggsLabel = _uiFactory.CreateDataLabel("Eggs");
            var chicksLabel = _uiFactory.CreateDataLabel("Chicks");
            var breedingChance = _uiFactory.CreateDataLabel("BR%");
            var gateLabel = _uiFactory.CreateDataLabel("Gate");

            headingsLayout.AddView(adultsLabel);
            headingsLayout.AddView(eggsLabel);
            headingsLayout.AddView(chicksLabel);
            headingsLayout.AddView(breedingChance);
            headingsLayout.AddView(gateLabel);
            _singleBoxDataContentLayout.AddView(headingsLayout);

            // Input fields row: Adults, Eggs, Chicks inputs, Gate Status spinner
            var inputFieldsLayout = new LinearLayout(this);
            var inputFieldsParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            inputFieldsParams.SetMargins(0, 0, 0, 16);
            inputFieldsLayout.LayoutParameters = inputFieldsParams;

            _adultsEditText = new List<EditText?>();
            _adultsEditText.Add(_uiFactory.CreateStyledNumberField());
            _eggsEditText = new List<EditText?>();
            _eggsEditText.Add(_uiFactory.CreateStyledNumberField());
            _chicksEditText = new List<EditText?>();
            _chicksEditText.Add(_uiFactory.CreateStyledNumberField());

            _breedingChanceSpinner = new List<Spinner?>();
            List<string> items = new List<string> { "", "NO", "UNL", "POT", "CON", "BR", "ABN", "DCM" };
            _breedingChanceSpinner.Add(_uiFactory.CreateSpinner(items));
            string? breedingChanceString = "";
            try { breedingChanceString = _colonyState.GetTodayForBox(_currentBoxName).BreedingStatus; }
            catch { }
            int breedingPercentageIndex = 0;
            if (breedingChanceString != null)
                breedingPercentageIndex = items.FindIndex(x => x == breedingChanceString);
            breedingPercentageIndex = Math.Max(0, breedingPercentageIndex);
            _breedingChanceSpinner[0].SetSelection(breedingPercentageIndex, false);
            _breedingChanceSpinner[0].ItemSelected += (s, e) =>
            {
                if (!_suppressDataChanged) _dataChangedSinceUnlock = true;
                string selectedItem = items[e.Position];
                string status = _breedingChanceSpinner[0].SelectedItem.ToString();
            };
            _gateStatusSpinner = new List<Spinner?>();
            _gateStatusSpinner.Add(_uiFactory.CreateSpinner(new string[] { "", "Gate up", "Regate" }));
            _gateStatusSpinner[0].ItemSelected += (s, e) =>
            {
                if (!_suppressDataChanged) _dataChangedSinceUnlock = true;
                // Only save if viewing current data (not historical)
                if (false /* no historical view */) return;

                string status = _gateStatusSpinner[0].SelectedItem.ToString();
                if (status.Equals("Gate up") || status.Equals("Regate"))
                {
                    SaveCurrentBoxData();
                    _isBoxLocked = true;
                    DrawPageLayouts();
                    TryBackgroundUpload();
                }
            };

            // Add event handlers
            _adultsEditText[0].TextChanged += OnDataChanged;
            _adultsEditText[0].Click += OnNumberFieldClick;
            _adultsEditText[0].FocusChange += OnNumberFieldFocus;

            _eggsEditText[0].TextChanged += OnDataChanged;
            _eggsEditText[0].Click += OnNumberFieldClick;
            _eggsEditText[0].FocusChange += OnNumberFieldFocus;

            _chicksEditText[0].TextChanged += OnDataChanged;
            _chicksEditText[0].Click += OnNumberFieldClick;
            _chicksEditText[0].FocusChange += OnNumberFieldFocus;

            inputFieldsLayout.AddView(_adultsEditText[0]);
            inputFieldsLayout.AddView(_eggsEditText[0]);
            inputFieldsLayout.AddView(_chicksEditText[0]);
            inputFieldsLayout.AddView(_breedingChanceSpinner[0]);
            inputFieldsLayout.AddView(_gateStatusSpinner[0]);
            _singleBoxDataContentLayout.AddView(inputFieldsLayout);

            var notesLabel = new TextView(this)
            {
                Text = "Notes:",
                TextSize = 16
            };
            notesLabel.SetTextColor(UIFactory.TEXT_PRIMARY);
            notesLabel.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            var notesLabelParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            notesLabelParams.SetMargins(0, 0, 0, 8);
            notesLabel.LayoutParameters = notesLabelParams;
            _singleBoxDataContentLayout.AddView(notesLabel);

            _notesEditText = new List<EditText?>();
            _notesEditText.Add(new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassText | Android.Text.InputTypes.TextFlagMultiLine | Android.Text.InputTypes.TextFlagCapSentences,
                Hint = "Additional observations",
                Gravity = Android.Views.GravityFlags.Top | Android.Views.GravityFlags.Start
            });
            _notesEditText[0].SetTextColor(UIFactory.TEXT_PRIMARY);
            _notesEditText[0].SetHintTextColor(UIFactory.TEXT_SECONDARY);
            _notesEditText[0].SetPadding(16, 16, 16, 16);
            _notesEditText[0].Background = _uiFactory.CreateRoundedBackground(UIFactory.LIGHTER_GRAY, 8);
            var notesEditParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            notesEditParams.SetMargins(0, 0, 0, 8);
            _notesEditText[0].LayoutParameters = notesEditParams;
            _notesEditText[0].TextChanged += OnDataChanged;
            _singleBoxDataContentLayout.AddView(_notesEditText[0]);

            _singleBoxDataOuterLayout.AddView(_singleBoxDataContentLayout);

            // Box tag mode layout — shown instead of normal content when in tag editing mode
        }
        private void SetEnabledRecursive(View view, bool enabled, float alpha)
        {
            if (view == null)
                return;
            view.Enabled = enabled;
            view.Alpha = alpha;
            if (view is ViewGroup group)
            {
                for (int i = 0; i < group.ChildCount; i++)
                {
                    SetEnabledRecursive(group.GetChildAt(i), enabled, alpha);
                }
            }
        }
        private void OnNumberFieldClick(object? sender, EventArgs e)
        {
            if (sender is EditText editText)
            {
                editText.SelectAll();
            }
        }
        private void OnNumberFieldFocus(object? sender, View.FocusChangeEventArgs e)
        {
            if (e.HasFocus && sender is EditText editText)
            {
                editText.Post(() => editText.SelectAll());
            }
        }
        /// <summary>
        /// Build a BoxObservation from the current UI fields without saving.
        /// </summary>
        private BoxObservation BuildObsFromCurrentUI()
        {
            int.TryParse(_adultsEditText?[0].Text ?? "0", out int adults);
            int.TryParse(_eggsEditText?[0].Text ?? "0", out int eggs);
            int.TryParse(_chicksEditText?[0].Text ?? "0", out int chicks);
            var obs = new BoxObservation
            {
                BoxName = _currentBoxName,
                Adults = adults, Eggs = eggs, Chicks = chicks,
                GateStatus = GetSelectedStatus(_gateStatusSpinner[0]),
                BreedingStatus = GetSelectedStatus(_breedingChanceSpinner[0]),
                Notes = _notesEditText?[0].Text ?? "",
                WhenDataCollectedUtc = DateTime.UtcNow,
                ObserverName = _appSettings.ObserverName,
            };
            // Copy scans from current box data
            var existing = _colonyState.GetTodayForBox(_currentBoxName);
            if (existing != null) obs.ScannedIds = existing.ScannedIds;
            return obs;
        }

        private void ShowLocalConfirmEditDialog(string boxName, BoxObservation serverVersion, Action onConfirm, Action onDiscard)
        {
            var localObs = BuildObsFromCurrentUI();
            ShowComparisonDialog($"Confirm edit: Box {boxName}", serverVersion, localObs, onConfirm, onDiscard);
        }

        private void OnPrevBoxClick(object? sender, EventArgs e)
        {
            NavigateToBox(_currentBoxIndex - 1, () => _currentBoxIndex > 1);
        }
        private void OnNextBoxClick(object? sender, EventArgs e)
        {
            NavigateToBox(_currentBoxIndex + 1, () => _currentBoxIndex < _boxNamesAndIndexes.Count);
        }
        private void NavigateToBox(int targetBox, Func<bool> canNavigate)
        {
            if (!canNavigate())
                return;

            //foreach 
            KeyValuePair<string, int>? boxNameAndIndex = _boxNamesAndIndexes.Where(x => x.Value == targetBox).First();
            if (boxNameAndIndex != null)
            {
                JumpToBox(boxNameAndIndex.Value.Key);
            }            
        }
        private void ShowEmptyBoxDialog(Action onConfirm, Action onCancel)
        {
            ShowConfirmationDialog(
                "Empty Box",
                "This box has been inspected and is empty",
                ("Save as empty", onConfirm),
                ("Don't save", onCancel)
            );
        }
        private void OnSaveDataClick(object? sender, EventArgs e)
        {
            var alertDialog = new AlertDialog.Builder(this)
                .SetTitle("Save data")
                .SetMessage(GetSummaryText())
                .SetPositiveButton("Save", (s, e) => ShowSaveFilenameDialog())
                .SetNeutralButton("Save & upload", (s, e) => ShowSaveFilenameDialog(true))
                .SetNegativeButton("Cancel", (s, e) => { })
                .SetCancelable(true)
                .Create();
            alertDialog?.Show();
        }
        private void ShowConfirmationDialog(string title, string message, (string text, Action action) positiveButton, (string text, Action action)? negativeButton = null)
        {
            var alertDialog = new AlertDialog.Builder(this)
                .SetTitle(title)
                .SetMessage(message)
                .SetPositiveButton(positiveButton.text, (s, e) => positiveButton.action())
                .SetCancelable(true)
                .Create();
            if (null != negativeButton)
                alertDialog.SetButton((int)DialogButtonType.Negative, negativeButton?.text, (s, e) => negativeButton?.action());
            alertDialog?.Show();
        }

        // Monitor deletion removed — data managed via wildwatch.co.nz

        private void ShowBoxNotesDialog()
        {
            string currentNotes = "";
            if (_boxNotes.TryGetValue(_currentBoxName, out var boxNote))
                currentNotes = boxNote.PersistentNotes ?? "";

            var mainLayout = new LinearLayout(this)
            {
                Orientation = Android.Widget.Orientation.Vertical
            };
            mainLayout.SetPadding(40, 20, 40, 20);

            var helpText = new TextView(this)
            {
                Text = "Use this text field for notes you want during subsequent monitors i.e. Missing nail.",
                TextSize = 15
            };
            helpText.SetTextColor(Color.White);
            var helpParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            helpParams.SetMargins(0, 0, 0, 12);
            helpText.LayoutParameters = helpParams;
            mainLayout.AddView(helpText);

            var notesInput = new EditText(this)
            {
                Text = currentNotes,
                Hint = "",
                InputType = Android.Text.InputTypes.ClassText | Android.Text.InputTypes.TextFlagMultiLine | Android.Text.InputTypes.TextFlagCapSentences
            };
            notesInput.SetMinLines(3);
            notesInput.SetTextColor(UIFactory.TEXT_PRIMARY);
            notesInput.SetHintTextColor(UIFactory.TEXT_SECONDARY);
            notesInput.SetPadding(16, 16, 16, 16);
            notesInput.Background = _uiFactory.CreateRoundedBackground(UIFactory.LIGHTER_GRAY, 8);
            mainLayout.AddView(notesInput);

            var dialog = new AlertDialog.Builder(this)
                .SetTitle($"Persistent notes - Box {_currentBoxName}")
                .SetView(mainLayout)
                .SetPositiveButton("Save", (s, e) =>
                {
                    string newNotes = notesInput.Text?.Trim() ?? "";
                    // Update local cache
                    if (!_boxNotes.ContainsKey(_currentBoxName))
                    {
                        _boxNotes[_currentBoxName] = new BoxNoteData { BoxName = _currentBoxName };
                    }
                    _boxNotes[_currentBoxName].PersistentNotes = newNotes;
                    int locationId = _boxNotes[_currentBoxName].LocationId;

                    // Save to API in background
                    if (locationId > 0)
                    {
                        _ = Task.Run(async () =>
                        {
                            bool success = await _dataStorageService.UpdateBoxNotesAsync(locationId, newNotes, _appSettings.AuthToken);
                            new Handler(Looper.MainLooper).Post(() =>
                            {
                                if (success)
                                    Toast.MakeText(this, "Notes saved", ToastLength.Short)?.Show();
                                else
                                    Toast.MakeText(this, "Failed to save notes to server", ToastLength.Short)?.Show();
                                DrawPageLayouts();
                            });
                        });
                    }
                    else
                    {
                        Toast.MakeText(this, "Box not found on server - notes saved locally only", ToastLength.Short)?.Show();
                        DrawPageLayouts();
                    }

                    // Save local cache to disk
                    var boxNotesJson = Newtonsoft.Json.JsonConvert.SerializeObject(_boxNotes, Newtonsoft.Json.Formatting.Indented);
                    File.WriteAllText(System.IO.Path.Combine(FilesDir?.AbsolutePath, DataStorageService.BOX_NOTES_FILENAME), boxNotesJson);
                })
                .SetNegativeButton("Cancel", (s, e) => { })
                .Create();

            dialog?.Show();

            notesInput.RequestFocus();
            var inputManager = (InputMethodManager?)GetSystemService(InputMethodService);
            inputManager?.ShowSoftInput(notesInput, ShowFlags.Implicit);
        }
        private void OnDataChanged(object? sender, TextChangedEventArgs e)
        {
            if (!_suppressDataChanged) _dataChangedSinceUnlock = true;
            CheckForHighOffspringCount();
            if ((int.TryParse(_eggsEditText?[0].Text ?? "0", out int eggs) && eggs > 0) || (int.TryParse(_chicksEditText?[0].Text ?? "0", out int chicks) && chicks > 0))
            {
                var spinner = _breedingChanceSpinner[0];
                for (int i = 0; i < spinner.Count; i++)
                {
                    if (spinner.GetItemAtPosition(i).ToString() == "BR")
                    {
                        spinner.SetSelection(i, true);
                        break;
                    }
                }
            }
        }
        private void CheckForHighOffspringCount()
        {
            if(_highOffspringCountConfirmed)
                return;

            int adults, eggs, chicks;
            int.TryParse(_adultsEditText?[0].Text ?? "0", out adults);
            int.TryParse(_eggsEditText?[0].Text ?? "0", out eggs);
            int.TryParse(_chicksEditText?[0].Text ?? "0", out chicks);

            // Check if any values are 3 or greater - no state tracking, ask every time
            var highValues = new List<(string type, int count)>();
            if (adults > 2) highValues.Add(("adults", adults));
            if (eggs > 2) highValues.Add(("eggs", eggs));
            if (chicks > 2) highValues.Add(("chicks", chicks));
            if (chicks + eggs > 2 && eggs > 0 && chicks > 0) highValues.Add(("eggs & chicks", chicks + eggs));

            if (highValues.Count > 0)
            {
                var message = "Are you sure you have found:\n\n";
                foreach (var (type, count) in highValues)
                    message += $"• {count} {type}\n";
                message += "\nPlease check this is correct.";
                ShowConfirmationDialog(
                    "High Value Confirmation",
                    message,
                    ("OK", () =>{ _highOffspringCountConfirmed = true; }
                ),
                   null
                );
            }
        }
        private void SaveCurrentBoxData()
        {
            var boxData = _colonyState.GetTodayForBox(_currentBoxName) ?? new BoxObservation { BoxName = _currentBoxName };

            int adults, eggs, chicks;
            int.TryParse(_adultsEditText?[0].Text ?? "0", out adults);
            int.TryParse(_eggsEditText?[0].Text ?? "0", out eggs);
            int.TryParse(_chicksEditText?[0].Text ?? "0", out chicks);

            bool changed = boxData.Adults != adults || boxData.Eggs != eggs || boxData.Chicks != chicks
                || (boxData.GateStatus ?? "") != (GetSelectedStatus(_gateStatusSpinner[0]) ?? "")
                || (boxData.BreedingStatus ?? "") != (GetSelectedStatus(_breedingChanceSpinner[0]) ?? "")
                || (boxData.Notes ?? "") != (_notesEditText?[0].Text ?? "");

            boxData.Adults = adults;
            boxData.Eggs = eggs;
            boxData.Chicks = chicks;
            boxData.GateStatus = GetSelectedStatus(_gateStatusSpinner[0]);
            boxData.BreedingStatus = GetSelectedStatus(_breedingChanceSpinner[0]);
            boxData.Notes = _notesEditText?[0].Text ?? "";

            if (changed)
            {
                boxData.WhenDataCollectedUtc = DateTime.UtcNow;
                boxData.IsPendingUpload = true;
                boxData.PendingUploadSinceUtc ??= DateTime.UtcNow;
                boxData.ObserverName = _appSettings.ObserverName;
                // Auto-replace on server if this box was already synced
                if (boxData.ObservationId.HasValue)
                    boxData.ConfirmedAgainstObsId = boxData.ObservationId.Value;
                _colonyState.SaveBoxObservation(_currentBoxName, boxData);
                SaveToAppDataDir();
            }
        }
        private void buildScannedIdsLayout(List<ScanRecord> scans)
        {
            if (_scannedIdsLayout == null) return;

            // Clear existing views
            _scannedIdsLayout[0].RemoveAllViews();

            if (scans.Count == 0)
            {
                var emptyText = new TextView(this)
                {
                    Text = "No birds scanned yet",
                    TextSize = 14
                };
                emptyText.SetTextColor(UIFactory.TEXT_SECONDARY);
                _scannedIdsLayout[0].AddView(emptyText);
            }
            else
            {
                // Header text
                var headerText = new TextView(this)
                {
                    Text = $"🐧 {scans.Count} bird{(scans.Count == 1 ? "" : "s")} scanned:",
                    TextSize = 14
                };
                headerText.SetTextColor(UIFactory.TEXT_PRIMARY);
                headerText.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
                var headerParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
                headerParams.SetMargins(0, 0, 0, 12);
                headerText.LayoutParameters = headerParams;
                _scannedIdsLayout[0].AddView(headerText);

                // Individual scan records with delete buttons
                for (int i = 0; i < scans.Count; i++)
                {
                    var scan = scans[i];
                    var scanLayout = CreateScanRecordView(scan, i);
                    _scannedIdsLayout[0].AddView(scanLayout);
                }
            }

            // Add manual input section at the bottom
            // Search field with dropdown results
            var searchContainer = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };
            var searchContainerParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            searchContainerParams.SetMargins(0, 12, 0, 0);
            searchContainer.LayoutParameters = searchContainerParams;

            _manualScanEditText = new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassText | Android.Text.InputTypes.TextFlagCapCharacters,
                Hint = "Search penguin # or pit ID",
                TextSize = 14
            };
            _manualScanEditText.SetTextColor(UIFactory.TEXT_PRIMARY);
            _manualScanEditText.SetHintTextColor(UIFactory.TEXT_SECONDARY);
            _manualScanEditText.SetPadding(12, 12, 12, 12);
            _manualScanEditText.Background = _uiFactory.CreateRoundedBackground(Color.White, 8);

            var editTextParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            editTextParams.SetMargins(0, 0, 0, 0);
            _manualScanEditText.LayoutParameters = editTextParams;

            // Search + No scan button row
            var searchRow = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Horizontal };
            searchRow.SetGravity(GravityFlags.CenterVertical);
            _manualScanEditText.LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1f);
            searchRow.AddView(_manualScanEditText);

            var noScanBtn = new Button(this) { Text = "No scan", TextSize = 12 };
            noScanBtn.SetTextColor(Color.Black);
            noScanBtn.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            noScanBtn.SetPadding(12, 8, 12, 8);
            noScanBtn.Background = _uiFactory.CreateRoundedBackground(UIFactory.LIGHTER_GRAY, 8);
            noScanBtn.SetAllCaps(false);
            var noScanBtnParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent);
            noScanBtnParams.SetMargins(8, 0, 0, 0);
            noScanBtnParams.Gravity = GravityFlags.CenterVertical;
            noScanBtn.LayoutParameters = noScanBtnParams;
            noScanBtn.Click += (s, e) =>
            {
                _adultsEditText[0].Text = (int.Parse(_adultsEditText[0].Text ?? "0") + 1).ToString();
                var boxData = _colonyState.GetTodayForBox(_currentBoxName) ?? new BoxObservation { BoxName = _currentBoxName };
                var noScanId = $"NOSCAN_{boxData.ScannedIds.Count(s2 => s2.BirdId.StartsWith("NOSCAN_")) + 1}";
                boxData.ScannedIds.Add(new ScanRecord { BirdId = noScanId, Timestamp = DateTime.UtcNow });
                boxData.IsPendingUpload = true;
                boxData.PendingUploadSinceUtc ??= DateTime.UtcNow;
                boxData.WhenDataCollectedUtc = DateTime.UtcNow;
                boxData.ObserverName = _appSettings.ObserverName;
                // Auto-replace if this box was already synced
                if (boxData.ObservationId.HasValue)
                    boxData.ConfirmedAgainstObsId = boxData.ObservationId.Value;
                _colonyState.SaveBoxObservation(_currentBoxName, boxData);
                SaveCurrentBoxData();
                _dataChangedSinceUnlock = true;
                DrawPageLayouts();
                Toast.MakeText(this, "+1 Adult (no scan)", ToastLength.Short)?.Show();
            };
            searchRow.AddView(noScanBtn);
            searchContainer.AddView(searchRow);

            // Dropdown results container
            var _searchResultsLayout = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };
            searchContainer.AddView(_searchResultsLayout);

            _manualScanEditText.TextChanged += (s, e) =>
            {
                _searchResultsLayout.RemoveAllViews();
                var query = _manualScanEditText.Text?.Trim().ToUpper() ?? "";
                if (query.Length < 1 || _remotePenguinData == null) return;

                // Search: exact peng# match first, then pit_id substring, then peng# prefix
                var exactPengNum = new List<PenguinData>();
                var pitIdMatches = new List<PenguinData>();
                var pengNumPrefix = new List<PenguinData>();

                foreach (var pd in _remotePenguinData.Values)
                {
                    if (pd.PengNum == query)
                        exactPengNum.Add(pd);
                    else if (pd.ScannedId.Contains(query))
                        pitIdMatches.Add(pd);
                    else if (pd.PengNum.StartsWith(query))
                        pengNumPrefix.Add(pd);
                }

                // Order: exact peng# → pit_id matches → peng# prefix
                var results = exactPengNum
                    .Concat(pitIdMatches.OrderBy(p => p.ScannedId))
                    .Concat(pengNumPrefix.OrderBy(p => int.TryParse(p.PengNum, out var n) ? n : 9999))
                    .Take(8)
                    .ToList();

                foreach (var pd in results)
                {
                    var fullPitId = !string.IsNullOrEmpty(pd.FullPitId) ? pd.FullPitId : pd.ScannedId;
                    var resultView = CreateScanBadge(fullPitId, () =>
                    {
                        AddScannedId(fullPitId, 0, isManualEntry: true);
                        _manualScanEditText.Text = "";
                        _searchResultsLayout.RemoveAllViews();
                        var imm = (Android.Views.InputMethods.InputMethodManager?)GetSystemService(InputMethodService);
                        imm?.HideSoftInputFromWindow(_manualScanEditText.WindowToken, 0);
                    }, textSize: 12);
                    resultView.SetPadding(12, 8, 12, 8);
                    var resultParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
                    resultParams.SetMargins(0, 2, 0, 2);
                    resultView.LayoutParameters = resultParams;

                    _searchResultsLayout.AddView(resultView);
                }
            };

            _scannedIdsLayout[0].AddView(searchContainer);

        }
        private LinearLayout CreateScanRecordView(ScanRecord scan, int index)
        {
            var scanLayout = new LinearLayout(this);

            var layoutParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            layoutParams.SetMargins(0, 2, 0, 2);
            scanLayout.LayoutParameters = layoutParams;

            // Determine background color based on penguin sex data
            Color backgroundColor;
            string additionalInfo = "";
            
            // Handle "No scan" placeholder entries
            if (scan.BirdId.StartsWith("NOSCAN_"))
            {
                scanLayout.Background = _uiFactory.CreateRoundedBackground(SCAN_CHIPPED_TODAY_BG, 4);
                scanLayout.SetPadding(12, 8, 12, 8);
                var noScanText = new TextView(this) { Text = "🐧 No scan", TextSize = 14 };
                noScanText.SetTextColor(Color.Black);
                scanLayout.AddView(noScanText);
                return scanLayout;
            }

            var (label, sex, isChick, penguinData) = LookupPenguinLabel(scan.BirdId);

            if (penguinData != null)
            {
                bool chippedToday = penguinData.ChipDate > DateTime.MinValue && ToNzTime(penguinData.ChipDate).Date == NzToday;
                bool isReturning = penguinData.LastKnownLifeStage == LifeStage.Returnee ||
                                   (!string.IsNullOrEmpty(penguinData.ChipAs) &&
                                    penguinData.ChipAs.IndexOf("chick", StringComparison.OrdinalIgnoreCase) >= 0);
                bool isRecentChick = penguinData.LastKnownLifeStage == LifeStage.Chick &&
                                     !(penguinData.ChipDate > NzToday.AddYears(-20) &&
                                       NzToday > penguinData.ChipDate.AddMonths(3));

                if (chippedToday)
                {
                    backgroundColor = SCAN_CHIPPED_TODAY_BG;
                    additionalInfo = " 🆕";
                }
                else if (isRecentChick)
                {
                    backgroundColor = UIFactory.CHICK_BACKGROUND;
                    additionalInfo = isReturning ? " 🐣🔄" : " 🐣";
                }
                else if (sex == "F")
                {
                    backgroundColor = UIFactory.FEMALE_BACKGROUND;
                    additionalInfo = isReturning ? " 🔄" : "";
                }
                else if (sex == "M")
                {
                    backgroundColor = UIFactory.MALE_BACKGROUND;
                    additionalInfo = isReturning ? " 🔄" : "";
                }
                else
                {
                    backgroundColor = index % 2 == 0 ? UIFactory.SCAN_ROW_EVEN : UIFactory.SCAN_ROW_ODD;
                    additionalInfo = isReturning ? " 🔄" : "";
                }
            }
            else
            {
                backgroundColor = index % 2 == 0 ? UIFactory.SCAN_ROW_EVEN : UIFactory.SCAN_ROW_ODD;
            }

            scanLayout.Background = _uiFactory.CreateRoundedBackground(backgroundColor, 4);
            scanLayout.SetPadding(12, 8, 12, 8);

            var scanText = new TextView(this)
            {
                Text = $"• {label}{additionalInfo} at {ToNzTime(scan.Timestamp):HH:mm}",
                TextSize = 14
            };
            scanText.SetTextColor(UIFactory.TEXT_PRIMARY);
            scanText.Clickable = true;
            // Tapping the bird opens it on the website directly (no modal)
            scanText.Click += (s, e) =>
            {
                var pn = penguinData?.PengNum ?? "";
                if (!string.IsNullOrEmpty(pn))
                    StartActivity(new Android.Content.Intent(Android.Content.Intent.ActionView,
                        Android.Net.Uri.Parse($"https://wildwatch.co.nz/bird/{pn}")));
                else
                    Toast.MakeText(this, "Bird not in database", ToastLength.Short)?.Show();
            };
            var textParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1);
            scanText.LayoutParameters = textParams;
            scanLayout.AddView(scanText);

            // Detail button — opens the biometric detail directly
            var detailButton = new Button(this)
            {
                Text = "Detail",
                TextSize = 12
            };
            detailButton.SetTextColor(Color.White);
            detailButton.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            detailButton.SetPadding(12, 8, 12, 8);
            detailButton.Background = _uiFactory.CreateRoundedBackground(UIFactory.SUCCESS_GREEN, 8);
            detailButton.SetAllCaps(false);

            var detailButtonParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent);
            detailButtonParams.SetMargins(8, 0, 4, 0);
            detailButton.LayoutParameters = detailButtonParams;

            detailButton.Click += (sender, e) => ShowBiometricForm(scan.BirdId, penguinData, penguinData?.PengNum ?? "");

            scanLayout.AddView(detailButton);

            // Move button
            var moveButton = new Button(this)
            {
                Text = "Move",
                TextSize = 12
            };
            moveButton.SetTextColor(Color.White);
            moveButton.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal); 
            moveButton.SetPadding(12, 8, 12, 8);
            moveButton.Background = _uiFactory.CreateRoundedBackground(UIFactory.PRIMARY_BLUE, 8);
            moveButton.SetAllCaps(false);

            var moveButtonParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent);
            moveButtonParams.SetMargins(8, 0, 4, 0);
            moveButton.LayoutParameters = moveButtonParams;

            // Set up move functionality
            moveButton.Click += (sender, e) => OnMoveScanClick(scan);

            scanLayout.AddView(moveButton);

            // Delete button
            var deleteButton = new Button(this)
            {
                Text = "Delete",
                TextSize = 12
            };
            deleteButton.SetTextColor(Color.White);
            deleteButton.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal); 
            deleteButton.SetPadding(12, 8, 12, 8);
            deleteButton.Background = _uiFactory.CreateRoundedBackground(UIFactory.DANGER_RED, 8);
            deleteButton.SetAllCaps(false);

            var deleteButtonParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent);
            deleteButtonParams.SetMargins(4, 0, 0, 0);
            deleteButton.LayoutParameters = deleteButtonParams;

            // Set up delete functionality
            deleteButton.Click += (sender, e) => OnDeleteScanClick(scan);

            scanLayout.AddView(deleteButton);

            return scanLayout;
        }
        private void ShowBirdDialog(string birdId, bool isTodayScan = true)
        {
            PenguinData? pd = null;
            _remotePenguinData?.TryGetValue(birdId, out pd);
            var shortId = birdId.Length > 8 ? birdId.Substring(birdId.Length - 8) : birdId;
            var pengNum = pd?.PengNum ?? "";
            var title = !string.IsNullOrEmpty(pengNum) ? $"#{pengNum} {shortId}" : shortId;
            if (pd != null)
            {
                var sex = pd.Sex == "M" ? " ♂" : pd.Sex == "F" ? " ♀" : "";
                title += sex;
            }

            var container = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };
            container.SetPadding(16, 16, 16, 16);

            var bioButton = _uiFactory.CreateStyledButton("Enter biometric data", isTodayScan ? UIFactory.PRIMARY_BLUE : Color.LightGray);
            var bioParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            bioParams.SetMargins(8, 8, 8, 8);
            bioButton.LayoutParameters = bioParams;
            bioButton.Enabled = isTodayScan;
            if (!isTodayScan) bioButton.Alpha = 0.5f;
            container.AddView(bioButton);

            if (!isTodayScan)
            {
                var warningText = new TextView(this) { Text = "Only for today's scans", TextSize = 12 };
                warningText.SetTextColor(UIFactory.DANGER_RED);
                warningText.Gravity = GravityFlags.Center;
                var warningParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
                warningParams.SetMargins(8, 0, 8, 8);
                warningText.LayoutParameters = warningParams;
                container.AddView(warningText);
            }

            var webButton = _uiFactory.CreateStyledButton("Open on website", UIFactory.SUCCESS_GREEN);
            webButton.LayoutParameters = bioParams;
            container.AddView(webButton);

            var dialog = new AlertDialog.Builder(this)
                .SetTitle(title)
                .SetView(container)
                .SetNegativeButton("Cancel", (s, e) => { })
                .Create();

            bioButton.Click += (s, e) => { if (isTodayScan) { dialog.Dismiss(); ShowBiometricForm(birdId, pd, pengNum); } };
            webButton.Click += (s, e) =>
            {
                dialog.Dismiss();
                if (!string.IsNullOrEmpty(pengNum))
                    StartActivity(new Android.Content.Intent(Android.Content.Intent.ActionView,
                        Android.Net.Uri.Parse($"https://wildwatch.co.nz/bird/{pengNum}")));
                else
                    Toast.MakeText(this, "Bird not in database", ToastLength.Short)?.Show();
            };

            dialog.Show();
        }

        // Observed sex-guess scale stored in penguin_biometric_data.observed_sex (wildwatch codes PM/MM/U/MF/PF).
        // First entry is the blank "not recorded" default.
        private static readonly (string code, string label)[] ObservedSexOptions = new[]
        {
            ("", ""),
            ("PM", "Probably male"),
            ("MM", "Maybe male"),
            ("U", "Unsure"),
            ("MF", "Maybe female"),
            ("PF", "Probably female"),
        };

        private void ShowBiometricForm(string birdId, PenguinData? pd, string pengNum)
        {
            // Read today's biometric record from the local cache (kept fresh by the main sync) —
            // opens instantly and works offline. Any unsynced edit is already in this cache.
            BiometricRecord? existing = null;
            if (!string.IsNullOrEmpty(pengNum))
                _colonyState.TodayBiometrics.TryGetValue(pengNum, out existing);
            ShowBiometricFormUI(birdId, pd, pengNum, existing);
        }

        private void ShowBiometricFormUI(string birdId, PenguinData? pd, string pengNum, BiometricRecord? existing)
        {
            var (pengLabel, _, _, _) = LookupPenguinLabel(birdId);
            var title = $"{pengLabel} detail";
            if (existing != null) title += " (update)";

            var scrollView = new ScrollView(this);
            var card = _uiFactory.CreateCard();
            card.SetPadding(16, 16, 16, 16);
            scrollView.AddView(card);

            // Styled input helper
            EditText createInput(string hint, Android.Text.InputTypes inputType)
            {
                var input = new EditText(this) { InputType = inputType, Hint = hint, TextSize = 14 };
                input.SetTextColor(UIFactory.TEXT_PRIMARY);
                input.SetHintTextColor(UIFactory.TEXT_SECONDARY);
                input.SetPadding(16, 12, 16, 12);
                input.Background = _uiFactory.CreateRoundedBackground(UIFactory.LIGHTER_GRAY, 8);
                var p = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
                p.SetMargins(0, 4, 0, 12);
                input.LayoutParameters = p;
                return input;
            }

            TextView createLabel(string text)
            {
                var lbl = new TextView(this) { Text = text, TextSize = 14 };
                lbl.SetTextColor(UIFactory.TEXT_PRIMARY);
                lbl.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
                return lbl;
            }

            // Weight
            card.AddView(createLabel("Weight (g)"));
            var weightInput = createInput("e.g. 1250", Android.Text.InputTypes.ClassNumber | Android.Text.InputTypes.NumberFlagDecimal);
            weightInput.Text = existing?.Weight ?? "";
            card.AddView(weightInput);

            // Right flipper length
            card.AddView(createLabel("Flipper (mm)"));
            var flipperInput = createInput("e.g. 185", Android.Text.InputTypes.ClassNumber | Android.Text.InputTypes.NumberFlagDecimal);
            flipperInput.Text = existing?.RightFlipperLength ?? "";
            card.AddView(flipperInput);

            // Sex
            card.AddView(createLabel("Sex"));
            var sexSpinner = _uiFactory.CreateSpinner(ObservedSexOptions.Select(o => o.label).ToList());
            var savedSex = existing?.ObservedSex ?? "";
            var sexIdx = Array.FindIndex(ObservedSexOptions, o => o.code == savedSex);
            if (sexIdx >= 0) sexSpinner.SetSelection(sexIdx);
            var spinnerParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            spinnerParams.SetMargins(0, 4, 0, 12);
            sexSpinner.LayoutParameters = spinnerParams;
            card.AddView(sexSpinner);

            // Conditions
            card.AddView(createLabel("Condition"));
            var conditions = new (string label, string field)[] {
                ("Moulting", "condition_moulting"),
                ("Ticks", "condition_ticks"),
                ("Dead", "condition_dead"),
            };
            bool condChecked(string field) => existing != null && field switch
            {
                "condition_moulting" => existing.ConditionMoulting,
                "condition_ticks" => existing.ConditionTicks,
                "condition_dead" => existing.ConditionDead,
                _ => false,
            };
            var conditionChecks = new Dictionary<string, CheckBox>();
            foreach (var (label, field) in conditions)
            {
                var cb = new CheckBox(this) { Text = label };
                cb.SetTextColor(Color.Black);
                cb.Checked = condChecked(field);
                conditionChecks[field] = cb;
                card.AddView(cb);
            }

            // Notes
            card.AddView(createLabel("Notes"));
            var notesInput = createInput("Observations about this bird",
                Android.Text.InputTypes.ClassText | Android.Text.InputTypes.TextFlagMultiLine | Android.Text.InputTypes.TextFlagCapSentences);
            notesInput.Text = existing?.Notes ?? "";
            card.AddView(notesInput);

            // Save button
            var saveButton = _uiFactory.CreateStyledButton("Save", UIFactory.SUCCESS_GREEN);
            var saveParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            saveParams.SetMargins(0, 16, 0, 0);
            saveButton.LayoutParameters = saveParams;
            card.AddView(saveButton);

            var dialog = new AlertDialog.Builder(this)
                .SetTitle(title)
                .SetView(scrollView)
                .SetNegativeButton("Cancel", (s, e) => { })
                .Create();

            saveButton.Click += (s, e) =>
            {
                if (string.IsNullOrEmpty(pengNum))
                {
                    Toast.MakeText(this, "Cannot save — penguin not in database", ToastLength.Short)?.Show();
                    return;
                }

                // Save to the local cache + sync queue — instant, offline-safe. The next sync (and the
                // prompt background flush below) uploads it; the server id is preserved so edits update.
                var selectedSexLabel = sexSpinner.SelectedItem?.ToString() ?? "";
                var record = new BiometricRecord
                {
                    PengNum = pengNum,
                    ObservationDate = NzNow.ToString("yyyy-MM-dd"),
                    Weight = string.IsNullOrEmpty(weightInput.Text) ? null : weightInput.Text,
                    RightFlipperLength = string.IsNullOrEmpty(flipperInput.Text) ? null : flipperInput.Text,
                    ObservedSex = ObservedSexOptions.FirstOrDefault(o => o.label == selectedSexLabel).code,
                    ConditionMoulting = conditionChecks["condition_moulting"].Checked,
                    ConditionTicks = conditionChecks["condition_ticks"].Checked,
                    ConditionDead = conditionChecks["condition_dead"].Checked,
                    Notes = string.IsNullOrEmpty(notesInput.Text) ? null : notesInput.Text,
                    BiometricId = existing?.BiometricId,
                    IsPendingUpload = true,
                    PendingUploadSinceUtc = DateTime.UtcNow,
                };
                _colonyState.SaveBiometric(record);
                SaveToAppDataDir();
                Toast.MakeText(this, $"Saved for #{pengNum} — will sync", ToastLength.Short)?.Show();
                dialog.Dismiss();

                // Prompt background flush so it uploads promptly; a full sync also flushes it.
                _ = Task.Run(async () =>
                {
                    try
                    {
                        await _dataStorageService.UploadPendingBiometricsOnly(_colonyState, _appSettings);
                        DataStorageService.SaveColonyState(this, _colonyState);
                    }
                    catch { }
                });
            };

            dialog.Show();
        }

        private void ShowNewBirdDialog(string shortId, string fullPitId)
        {
            SetDialogActive(true);
            var scrollView = new ScrollView(this);
            scrollView.SetClipChildren(false);
            scrollView.DescendantFocusability = Android.Views.DescendantFocusability.AfterDescendants;
            var card = _uiFactory.CreateCard();
            card.SetPadding(16, 16, 16, 16);
            scrollView.AddView(card);

            EditText createInput(string hint, Android.Text.InputTypes inputType = Android.Text.InputTypes.ClassText)
            {
                var input = new EditText(this) { InputType = inputType, Hint = hint, TextSize = 14, Focusable = true, FocusableInTouchMode = true };
                input.SetTextColor(UIFactory.TEXT_PRIMARY);
                input.SetHintTextColor(UIFactory.TEXT_SECONDARY);
                input.SetPadding(16, 12, 16, 12);
                input.Background = _uiFactory.CreateRoundedBackground(UIFactory.LIGHTER_GRAY, 8);
                var p = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
                p.SetMargins(0, 4, 0, 12);
                input.LayoutParameters = p;
                return input;
            }

            TextView createLabel(string text)
            {
                var lbl = new TextView(this) { Text = text, TextSize = 14 };
                lbl.SetTextColor(UIFactory.TEXT_PRIMARY);
                lbl.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
                return lbl;
            }

            // PIT ID (read-only)
            var pitInfo = new TextView(this) { Text = $"PIT ID: {fullPitId}", TextSize = 13 };
            pitInfo.SetTextColor(Color.DarkGray);
            pitInfo.SetPadding(0, 0, 0, 12);
            card.AddView(pitInfo);

            // Sex
            card.AddView(createLabel("Sex"));
            var sexSpinner = _uiFactory.CreateSpinner(ObservedSexOptions.Select(o => o.label).ToList());
            var spinnerParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            spinnerParams.SetMargins(0, 4, 0, 12);
            sexSpinner.LayoutParameters = spinnerParams;
            card.AddView(sexSpinner);

            // Chipped as adult/chick toggle
            card.AddView(createLabel("Chipped as"));
            var chippedAsAdult = new RadioButton(this) { Text = "Adult" };
            chippedAsAdult.SetTextColor(Color.Black);
            var chippedAsChick = new RadioButton(this) { Text = "Chick" };
            chippedAsChick.SetTextColor(Color.Black);
            var chippedGroup = new RadioGroup(this);
            chippedGroup.AddView(chippedAsAdult);
            chippedGroup.AddView(chippedAsChick);
            chippedAsAdult.Checked = true;
            card.AddView(chippedGroup);

            // Chick size options (hidden until "Chick" selected)
            var chickSizeLayout = new LinearLayout(this) { Orientation = Android.Widget.Orientation.Vertical };
            chickSizeLayout.Visibility = ViewStates.Gone;
            chickSizeLayout.SetPadding(16, 0, 0, 0);

            var sizeLabel = createLabel("Chick size");
            chickSizeLayout.AddView(sizeLabel);

            var sizeGroup = new RadioGroup(this);
            var sizeUnknown = new RadioButton(this) { Text = "Unknown" };
            sizeUnknown.SetTextColor(Color.Black);
            sizeUnknown.Checked = true;
            var sizeSC = new RadioButton(this) { Text = "Single Chick (SC)" };
            sizeSC.SetTextColor(Color.Black);
            var sizeBC = new RadioButton(this) { Text = "Big Chick (BC)" };
            sizeBC.SetTextColor(Color.Black);
            var sizeLC = new RadioButton(this) { Text = "Little Chick (LC)" };
            sizeLC.SetTextColor(Color.Black);
            sizeGroup.AddView(sizeUnknown);
            sizeGroup.AddView(sizeSC);
            sizeGroup.AddView(sizeBC);
            sizeGroup.AddView(sizeLC);
            chickSizeLayout.AddView(sizeGroup);
            card.AddView(chickSizeLayout);

            chippedAsChick.CheckedChange += (s, e) =>
                chickSizeLayout.Visibility = chippedAsChick.Checked ? ViewStates.Visible : ViewStates.Gone;

            // Chip box (pre-filled with current box)
            card.AddView(createLabel("Chip box"));
            var chipBoxInput = createInput("Box name");
            chipBoxInput.Text = _currentBoxName;
            card.AddView(chipBoxInput);

            // Chipped by (pre-filled with current observer)
            card.AddView(createLabel("Chipped by"));
            var chippedByInput = createInput("Observer name");
            chippedByInput.Text = _appSettings?.ObserverName ?? "";
            card.AddView(chippedByInput);

            // --- Biometric data ---
            var bioHeader = new TextView(this) { Text = "Biometric Data (optional)", TextSize = 15 };
            bioHeader.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            bioHeader.SetTextColor(UIFactory.TEXT_PRIMARY);
            bioHeader.SetPadding(0, 16, 0, 4);
            card.AddView(bioHeader);

            card.AddView(createLabel("Weight (g)"));
            var weightInput = createInput("e.g. 1250", Android.Text.InputTypes.ClassNumber | Android.Text.InputTypes.NumberFlagDecimal);
            card.AddView(weightInput);

            card.AddView(createLabel("Flipper (mm)"));
            var flipperInput = createInput("e.g. 185", Android.Text.InputTypes.ClassNumber | Android.Text.InputTypes.NumberFlagDecimal);
            card.AddView(flipperInput);

            card.AddView(createLabel("Condition"));
            var bioConditions = new (string label, string field)[] {
                ("Moulting", "condition_moulting"),
                ("Ticks", "condition_ticks"),
                ("Dead", "condition_dead"),
            };
            var bioConditionChecks = new Dictionary<string, CheckBox>();
            foreach (var (label, field) in bioConditions)
            {
                var cb = new CheckBox(this) { Text = label };
                cb.SetTextColor(Color.Black);
                bioConditionChecks[field] = cb;
                card.AddView(cb);
            }

            card.AddView(createLabel("Notes"));
            var notesInput = createInput("Notes",
                Android.Text.InputTypes.ClassText | Android.Text.InputTypes.TextFlagMultiLine | Android.Text.InputTypes.TextFlagCapSentences);
            card.AddView(notesInput);

            var dialog = new AlertDialog.Builder(this)
                .SetTitle($"New bird: {shortId}")
                .SetView(scrollView)
                .SetPositiveButton("Add new penguin", (EventHandler<DialogClickEventArgs>)null!)
                .SetNegativeButton("Skip", (s, e) => { SetDialogActive(false); })
                .Create();

            dialog.Show();
            var addButton = dialog.GetButton((int)DialogButtonType.Positive);
            addButton.Click += (s, e) =>
            {
                addButton.Enabled = false;
                addButton.Text = "Adding...";
                var isChick = chippedAsChick.Checked;
                var sexLabel = sexSpinner.SelectedItem?.ToString() ?? "";
                var sex = ObservedSexOptions.FirstOrDefault(o => o.label == sexLabel).code;
                var chickSize = "";
                if (isChick)
                {
                    if (sizeSC.Checked) chickSize = "SC";
                    else if (sizeBC.Checked) chickSize = "BC";
                    else if (sizeLC.Checked) chickSize = "LC";
                }

                _ = Task.Run(async () =>
                {
                    try
                    {
                        var client = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
                        var token = _appSettings.AuthToken;

                        // 1. Create penguin record
                        var pengFields = new Dictionary<string, object>
                        {
                            ["chipped_as_adult"] = isChick ? 0 : 1,
                            ["life_stage"] = isChick ? "Chick" : "Adult",
                        };
                        // sex goes to biometric data as observed_sex, not penguin table
                        if (!string.IsNullOrEmpty(chickSize)) pengFields["chick_size_code"] = chickSize;

                        var pengReq = new HttpRequestMessage(HttpMethod.Post,
                            $"{DataStorageService.WILDWATCH_BASE_URL}/crud.php?action=create&table=penguins");
                        pengReq.Headers.Add("Authorization", $"Bearer {token}");
                        pengReq.Content = new StringContent(
                            JsonConvert.SerializeObject(pengFields), System.Text.Encoding.UTF8, "application/json");
                        var pengResp = await client.SendAsync(pengReq);
                        var pengJson = await pengResp.Content.ReadAsStringAsync();
                        var pengResult = JsonConvert.DeserializeObject<Dictionary<string, object>>(pengJson);

                        var pengNum = pengResult?.ContainsKey("peng_num") == true ? pengResult["peng_num"]?.ToString() : null;
                        if (string.IsNullOrEmpty(pengNum))
                        {
                            RunOnUiThread(() =>
                            {
                                new AlertDialog.Builder(this)
                                    .SetTitle("Failed to create penguin")
                                    .SetMessage(pengJson)
                                    .SetPositiveButton("OK", (s2, e2) => { })
                                    .Show();
                            });
                            return;
                        }

                        // 2. Create chip record
                        var chipFields = new Dictionary<string, object>
                        {
                            ["peng_num"] = pengNum,
                            ["pit_id"] = fullPitId,
                            ["chip_date"] = NzNow.ToString("yyyy-MM-dd"),
                            ["is_active"] = 1,
                            ["chip_box"] = chipBoxInput.Text?.Trim() ?? "",
                            ["chip_by"] = chippedByInput.Text?.Trim() ?? "",
                        };
                        var chipReq = new HttpRequestMessage(HttpMethod.Post,
                            $"{DataStorageService.WILDWATCH_BASE_URL}/crud.php?action=create&table=penguin_chips");
                        chipReq.Headers.Add("Authorization", $"Bearer {token}");
                        chipReq.Content = new StringContent(
                            JsonConvert.SerializeObject(chipFields), System.Text.Encoding.UTF8, "application/json");
                        var chipResp = await client.SendAsync(chipReq);
                        var chipJson = await chipResp.Content.ReadAsStringAsync();
                        var chipResult = JsonConvert.DeserializeObject<Dictionary<string, object>>(chipJson);
                        if (chipResult == null || chipResult.ContainsKey("error"))
                        {
                            RunOnUiThread(() =>
                            {
                                new AlertDialog.Builder(this)
                                    .SetTitle("Failed to create chip")
                                    .SetMessage(chipJson)
                                    .SetPositiveButton("OK", (s3, e3) => { })
                                    .Show();
                            });
                            return;
                        }

                        // 3. Create biometric record if any data entered
                        var bioFields = new Dictionary<string, object>();
                        if (!string.IsNullOrEmpty(weightInput.Text)) bioFields["weight"] = weightInput.Text;
                        if (!string.IsNullOrEmpty(flipperInput.Text)) bioFields["right_flipper_length"] = flipperInput.Text;
                        if (!string.IsNullOrEmpty(sex)) bioFields["observed_sex"] = sex;
                        foreach (var (field, cb) in bioConditionChecks)
                            if (cb.Checked) bioFields[field] = true;
                        if (bioFields.Count > 0)
                        {
                            bioFields["peng_num"] = pengNum;
                            bioFields["observation_date"] = NzNow.ToString("yyyy-MM-dd");
                            var bioReq = new HttpRequestMessage(HttpMethod.Post,
                                $"{DataStorageService.WILDWATCH_BASE_URL}/crud.php?action=create&table=penguin_biometric_data");
                            bioReq.Headers.Add("Authorization", $"Bearer {token}");
                            bioReq.Content = new StringContent(
                                JsonConvert.SerializeObject(bioFields), System.Text.Encoding.UTF8, "application/json");
                            await client.SendAsync(bioReq);
                        }

                        // 4. Update local penguin data cache
                        if (_remotePenguinData != null)
                        {
                            var pd = new PenguinData
                            {
                                ScannedId = shortId,
                                PengNum = pengNum,
                                Sex = "", // sex is unconfirmed until set on penguins table
                                LastKnownLifeStage = isChick ? LifeStage.Chick : LifeStage.Adult,
                                ChipDate = DateTime.UtcNow,
                                ChipAs = isChick ? "Chick" : "Adult",
                                ChickSizeCode = chickSize,
                            };
                            _remotePenguinData[fullPitId] = pd;
                            _remotePenguinData[shortId] = pd;
                        }

                        RunOnUiThread(() =>
                        {
                            // Increment adult or chick count
                            if (isChick)
                            {
                                _chicksEditText[0].Text = (int.Parse(_chicksEditText[0].Text ?? "0") + 1).ToString();
                                Toast.MakeText(this, $"#{pengNum} added (+1 Chick)", ToastLength.Short)?.Show();
                            }
                            else
                            {
                                _adultsEditText[0].Text = (int.Parse(_adultsEditText[0].Text ?? "0") + 1).ToString();
                                Toast.MakeText(this, $"#{pengNum} added (+1 Adult)", ToastLength.Short)?.Show();
                            }
                            SaveCurrentBoxData();
                            dialog.Dismiss();
                            SetDialogActive(false);
                            DrawPageLayouts();
                        });
                    }
                    catch (Exception ex)
                    {
                        RunOnUiThread(() =>
                            Toast.MakeText(this, $"Failed: {ex.Message}", ToastLength.Long)?.Show());
                    }
                });
            };
        }

        private void OnDeleteScanClick(ScanRecord scanToDelete)
        {
            ShowConfirmationDialog(
                "Delete Bird Scan",
                $"Are you sure you want to delete the scan for bird {scanToDelete.BirdId}?",
                ("Yes, Delete", () =>
                {
                    if ((_colonyState.GetTodayForBox(_currentBoxName) != null))
                    {
                        var boxData = _colonyState.GetTodayForBox(_currentBoxName);
                        var scanToRemove = boxData.ScannedIds.FirstOrDefault(s =>
                            s.BirdId == scanToDelete.BirdId &&
                            s.Timestamp == scanToDelete.Timestamp);

                        if (scanToRemove != null)
                        {
                            boxData.ScannedIds.Remove(scanToRemove);
                            if (_remotePenguinData.TryGetValue(scanToRemove.BirdId, out var penguinData) && (
                                LifeStage.Adult == penguinData.LastKnownLifeStage ||
                                LifeStage.Returnee == penguinData.LastKnownLifeStage ||
                                NzNow > penguinData.ChipDate.AddMonths(3)))
                            {
                                _adultsEditText[0].Text = "" + Math.Max(0, int.Parse(_adultsEditText[0].Text ?? "0") - 1);
                            }
                            else if (penguinData != null && LifeStage.Chick == penguinData.LastKnownLifeStage)
                            {
                                _chicksEditText[0].Text = "" + Math.Max(0, int.Parse(_chicksEditText[0].Text ?? "0") - 1);
                            }
                            SaveCurrentBoxData();
                            buildScannedIdsLayout(boxData.ScannedIds);
                            Toast.MakeText(this, $"🗑️ Bird {scanToDelete.BirdId} deleted from Box {_currentBoxName}", ToastLength.Short)?.Show();
                            DrawPageLayouts();
                        }
                    }
                }
            ),
                ("Cancel", () => { }
            )
            );
        }
        private void OnMoveScanClick(ScanRecord scanToMove)
        {
            ShowMoveDialog(scanToMove);
        }
        private void ShowMoveDialog(ScanRecord scanToMove)
        {
            var input = new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassText,
                Hint = $"Enter box name in scope: " + _appSettings.BoxSetString
            };
            input.SetTextColor(UIFactory.TEXT_PRIMARY);

            var alertDialog = new AlertDialog.Builder(this)
                .SetTitle($"Move Bird {scanToMove.BirdId}")
                .SetMessage($"Move from Box { _currentBoxName} to:")
                .SetView(input)
                .SetPositiveButton("Move", (s, e) =>
                {
                    string targetBoxName = input.Text?.Trim() ?? "";
                    if (_boxNamesAndIndexes.ContainsKey(targetBoxName))
                    {
                        if (targetBoxName == _currentBoxName)
                        {
                            Toast.MakeText(this, "Bird is already in this box", ToastLength.Short)?.Show();
                        }
                        else
                        {
                            MoveScanToBox(scanToMove, targetBoxName);
                        }
                    }
                    else
                    {
                        Toast.MakeText(this, $"Box name must be in scope {_appSettings.BoxSetString}", ToastLength.Short)?.Show();
                    }
                })
                .SetNegativeButton("Cancel", (s, e) => { })
                .Create();

            alertDialog?.Show();
            
            input.RequestFocus();
            var inputMethodManager = (Android.Views.InputMethods.InputMethodManager?)GetSystemService(InputMethodService);
            inputMethodManager?.ShowSoftInput(input, Android.Views.InputMethods.ShowFlags.Implicit);
        }
        private void MoveScanToBox(ScanRecord scanToMove, string targetBoxName)
        {
            ShowConfirmationDialog(
                "Move Bird Scan",
                $"Move bird {scanToMove.BirdId} from Box {_currentBoxName} to Box {targetBoxName}?",
                ("Yes, Move", (Action)(() =>
                {
                    // Remove from current box
                    if ((_colonyState.GetTodayForBox(_currentBoxName) != null))
                    {
                        var currentBoxData = _colonyState.GetTodayForBox(_currentBoxName);
                        var scanToRemove = currentBoxData.ScannedIds.FirstOrDefault(s =>
                            s.BirdId == scanToMove.BirdId &&
                            s.Timestamp == scanToMove.Timestamp);

                        var targetBoxData = _colonyState.GetTodayForBox(targetBoxName);
                        if (targetBoxData != null && targetBoxData.ScannedIds.Any(s => s.BirdId == scanToMove.BirdId))
                        {
                            Toast.MakeText(this, $"🔄 Bird {scanToMove.BirdId} exists already in Box {targetBoxName}", ToastLength.Long)?.Show();
                        }
                        else if (scanToRemove != null)
                        {
                            currentBoxData.ScannedIds.Remove(scanToRemove);
                            _colonyState.SaveBoxObservation(_currentBoxName, currentBoxData);

                            // Add to target box
                            if (targetBoxData == null)
                                targetBoxData = new BoxObservation { BoxName = targetBoxName };

                            targetBoxData.ScannedIds.Add(scanToMove);

                            if (_remotePenguinData.TryGetValue(scanToRemove.BirdId, out var penguinData))
                            {
                                if (LifeStage.Adult == penguinData.LastKnownLifeStage || LifeStage.Returnee == penguinData.LastKnownLifeStage || NzNow > penguinData.ChipDate.AddMonths(3))
                                {
                                    _adultsEditText[0].Text = "" + Math.Max(0, int.Parse(_adultsEditText[0].Text ?? "0") - 1);
                                    targetBoxData.Adults++;
                                }
                                else if (LifeStage.Chick == penguinData.LastKnownLifeStage)
                                {
                                    _chicksEditText[0].Text = "" + Math.Max(0, int.Parse(_chicksEditText[0].Text ?? "0") - 1);
                                    targetBoxData.Chicks++;
                                }
                            }
                            targetBoxData.IsPendingUpload = true;
                            targetBoxData.PendingUploadSinceUtc ??= DateTime.UtcNow;
                            _colonyState.SaveBoxObservation(targetBoxName, targetBoxData);
                            SaveCurrentBoxData();
                            buildScannedIdsLayout(currentBoxData.ScannedIds);
                            Toast.MakeText(this, $"🔄 Bird {scanToMove.BirdId} moved from Box {_currentBoxName} to Box {targetBoxName}", ToastLength.Long)?.Show();
                            DrawPageLayouts();
                        }
                    }
                })),
                ("Cancel", () => { })
            );
        }
        private void HandleIncomingJsonIntent()
        {
            try
            {
                if (Intent?.Action != Android.Content.Intent.ActionView || Intent.Data == null) return;
                if (Intent.Data.Scheme == "nestcheck") return; // Handled by HandleAuthDeepLink

                var uri = Intent.Data;
                using var stream = ContentResolver?.OpenInputStream(uri);
                if (stream == null) return;

                using var reader = new System.IO.StreamReader(stream);
                var json = reader.ReadToEnd();
                var filename = uri.LastPathSegment ?? "";

                // Clear intent so it doesn't re-trigger on activity recreate
                Intent.SetData(null);
                Intent.SetAction(null);

                LoadJsonData(json, filename);
            }
            catch (Exception ex)
            {
                Toast.MakeText(this, $"Failed to open JSON: {ex.Message}", ToastLength.Long)?.Show();
            }
        }

        private async void LoadFromAppDataDir()
        {
            try
            {
                var internalPath = this.FilesDir?.AbsolutePath;
                if (string.IsNullOrEmpty(internalPath))
                    throw new Exception();
                _appSettings = DataStorageService.loadAppSettingsFromDir(internalPath);
                _appSettings.PropertyChanged += (s, e) => DataStorageService.saveApplicationSettings(_appSettings);

                // Initialize BoxTags API if configured
                if (_appSettings.IsBoxTagsApiConfigured)
                {
                    BoxTagService.InitializeApi(_appSettings.BoxTagsApiUrl, _appSettings.BoxTagsApiKey);
                }

                // Load box tags from local storage
                _boxTags = BoxTagService.LoadBoxTags(internalPath);

                // Load remote penguin data.
                _remotePenguinData = await _dataStorageService.loadRemotePengInfoFromAppDataDir(this);
                _boxNotes = _dataStorageService.LoadBoxNotesFromDisk(this);
                if (_remotePenguinData != null &&  _remoteBreedingDates != null)
                {
                    Toast.MakeText(this, $"{_remotePenguinData.Count} bird, {_remoteBreedingDates.Count} breeding dates found.", ToastLength.Short)?.Show();
                }

                // Load colony state (or migrate from legacy)
                _colonyState = DataStorageService.LoadColonyState(this);
                // Clear daily label if it was set on a previous day
                if (!string.IsNullOrEmpty(_colonyState.DailyLabelDate) && _colonyState.DailyLabelDate != NzToday.ToString("yyyy-MM-dd"))
                {
                    _colonyState.DailyLabel = "";
                    _colonyState.DailyLabelDate = "";
                    DataStorageService.SaveColonyState(this, _colonyState);
                }
                if (_colonyState.PreviousBoxes.Count > 0 || _colonyState.TodayBoxes.Count > 0 || _colonyState.PendingObservations.Count > 0)
                    Toast.MakeText(this, $"📱 Data restored...", ToastLength.Short)?.Show();

                // Flag for auto-download after UI is built
                var lastSyncNzDate = _colonyState.LastSyncedUtc > DateTime.MinValue ? ToNzTime(_colonyState.LastSyncedUtc).Date : DateTime.MinValue;
                _shouldAutoDownloadBirdStats = (_remotePenguinData == null || _remotePenguinData.Count == 0 || lastSyncNzDate < NzToday);
            }
            catch (Exception ex)
            {
                _remotePenguinData = new Dictionary<string, PenguinData>();
                System.Diagnostics.Debug.WriteLine($"Failed to load data: {ex.Message}");
            }
        }
        private void UpdatePenguinLifeStage(string pengNum, string lifeStage)
        {
            _ = Task.Run(async () =>
            {
                try
                {
                    var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
                    var req = new HttpRequestMessage(HttpMethod.Post,
                        $"{DataStorageService.WILDWATCH_BASE_URL}/crud.php?action=update&table=penguins&id={pengNum}");
                    req.Headers.Add("Authorization", $"Bearer {_appSettings.AuthToken}");
                    req.Content = new StringContent(
                        JsonConvert.SerializeObject(new { life_stage = lifeStage }),
                        System.Text.Encoding.UTF8, "application/json");
                    await client.SendAsync(req);
                }
                catch { }
            });
        }

        private void SaveToAppDataDir()
        {
            DataStorageService.SaveColonyState(this, _colonyState);
            UpdateSyncButtonLabel();

        }

        private void UpdateDailyLabelWarnings()
        {
            bool show = _appSettings.ShowDailyLabelWarning && string.IsNullOrWhiteSpace(_colonyState.DailyLabel) && !_appSettings.EditBoxTagsMode && !_isHistoricalView;
            if (_standaloneDailyLabelWarning != null)
                _standaloneDailyLabelWarning.Visibility = show ? ViewStates.Visible : ViewStates.Gone;
        }

        private void UpdateSyncButtonLabel()
        {
            UpdateStatusText();
        }

        private void TryBackgroundUpload()
        {
            if (!_appSettings.IsAuthenticated || _colonyState.PendingUploadCount == 0 || _dialogActive || !_isBoxLocked) return;

            // Use Thread directly to avoid Android SynchronizationContext deadlock
            new Thread(async () =>
            {
                try
                {
                    var result = await _dataStorageService.UploadPendingOnly(_colonyState, _appSettings);
                    if (result.Uploaded > 0)
                        DataStorageService.SaveColonyState(this, _colonyState);
                    RunOnUiThread(() =>
                    {
                        if (result.Uploaded > 0)
                        {
                            _lastSyncCheckUtc = DateTime.UtcNow;
                            UpdateStatusText();
                            DrawPageLayouts();
                        }
                        UpdateSyncButtonLabel();
                        if (result.Conflicts != null && result.Conflicts.Count > 0)
                            ShowConflictDialog(result.Conflicts);
                        else if (!string.IsNullOrEmpty(result.Error))
                            Toast.MakeText(this, $"Sync: {result.Error}", ToastLength.Short)?.Show();
                    });
                }
                catch (Exception ex)
                {
                    RunOnUiThread(() =>
                        Toast.MakeText(this, $"Sync failed: {ex.Message}", ToastLength.Short)?.Show());
                }
            }).Start();
        }

        private void HandleAuthDeepLink(Android.Content.Intent? intent)
        {
            if (intent?.Data?.Scheme != "nestcheck" || intent?.Data?.Host != "auth") return;
            var token = intent.Data.GetQueryParameter("token");
            var name = intent.Data.GetQueryParameter("name");
            var observerId = intent.Data.GetQueryParameter("observer_id");
            if (!string.IsNullOrEmpty(token))
            {
                _appSettings.AuthToken = token;
                _appSettings.ObserverName = name ?? "";
                if (int.TryParse(observerId, out var oid)) _appSettings.ObserverId = oid;
                DataStorageService.saveApplicationSettings(_appSettings);
                Toast.MakeText(this, $"Logged in as {name}", ToastLength.Short)?.Show();
                // Auto-sync after login to fetch colony and data
                _shouldAutoDownloadBirdStats = true;
            }
        }
        private void triggerAlertAsync()
        {
            new Thread(TriggerAlert).Start();
        }
        private void TriggerAlert()
        {
            try
            {
                // Vibrate for 500ms
                if (_vibrator != null)
                {
                    if (OperatingSystem.IsAndroidVersionAtLeast(26))
                    {
                        // Use VibrationEffect for API 26+
                        var vibrationEffect = VibrationEffect.CreateOneShot(500, VibrationEffect.DefaultAmplitude);
                        _vibrator.Vibrate(vibrationEffect);
                    }
                }

                // Play alert sound
                if (_alertMediaPlayer != null)
                {
                    try
                    {
                        int replayCount = 3;
                        while (replayCount-- > 0)
                        {
                            if (_alertMediaPlayer.IsPlaying)
                            {
                                _alertMediaPlayer.Stop();
                                _alertMediaPlayer.Prepare();
                            }
                            _alertMediaPlayer.Start();
                            Thread.Sleep(1000);
                        }
                    }
                    catch (Exception ex)
                    {
                        System.Diagnostics.Debug.WriteLine($"Failed to play alert sound: {ex.Message}");
                    }
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to trigger chick alert: {ex.Message}");
            }
        }
        private void ClearInternalStorageData()
        {
            try
            {
                var internalPath = FilesDir?.AbsolutePath;
                if (!string.IsNullOrEmpty(internalPath))
                {
                    _dataStorageService.ClearInternalStorageData(internalPath);
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to clear auto-save file: {ex.Message}");
            }
        }

        private void HandleBoxTagScan(string cleanTagId)
        {
            RunOnUiThread(() =>
            {
                // Check if this tag is already assigned to a box
                string? assignedBoxId = BoxTagService.GetBoxIdByTag(_boxTags, cleanTagId);

                if (!_isBoxLocked)
                {
                    if (_appSettings.EditBoxTagsMode)
                    {
                        // Edit box tags mode — assign/move tags
                        if (assignedBoxId != null && assignedBoxId != _currentBoxName)
                        {
                            TriggerAlert();
                            new AlertDialog.Builder(this)
                                .SetTitle("Tag already assigned")
                                .SetMessage($"This tag is currently assigned to Box {assignedBoxId}.\n\nMove it to Box {_currentBoxName}?")
                                .SetPositiveButton($"Move to Box {_currentBoxName}", (s, e) =>
                                {
                                    var internalPath = this.FilesDir?.AbsolutePath;
                                    if (!string.IsNullOrEmpty(internalPath))
                                    {
                                        BoxTagService.RemoveBoxTag(_boxTags, assignedBoxId, internalPath);
                                        BoxTagService.AssignBoxTag(_boxTags, _currentBoxName, cleanTagId,
                                            _currentLocation?.Latitude ?? 0, _currentLocation?.Longitude ?? 0,
                                            _currentLocation?.Accuracy ?? -1, internalPath, _appSettings.ObserverId);
                                        Toast.MakeText(this, $"📌 Tag moved from Box {assignedBoxId} to Box {_currentBoxName}", ToastLength.Short)?.Show();
                                        DrawPageLayouts();
                                    }
                                })
                                .SetNegativeButton("Cancel", (s, e) => { })
                                .Show();
                            return;
                        }

                        var internalPath = this.FilesDir?.AbsolutePath;
                        if (!string.IsNullOrEmpty(internalPath))
                        {
                            BoxTagService.AssignBoxTag(_boxTags, _currentBoxName, cleanTagId,
                                _currentLocation?.Latitude ?? 0, _currentLocation?.Longitude ?? 0,
                                _currentLocation?.Accuracy ?? -1, internalPath, _appSettings.ObserverId);
                            Toast.MakeText(this, $"📌 Box tag assigned to Box {_currentBoxName}", ToastLength.Short)?.Show();
                            DrawPageLayouts();
                        }
                    }
                    else
                    {
                        // Normal mode — a box tag means "navigate to that box".
                        if (_pendingBoxTagNavigation != null && assignedBoxId != _pendingBoxTagNavigation)
                        {
                            // A navigation is already pending and the user scanned a *different* box tag.
                            // Keep the original destination (first tag wins) and freeze the scan queue
                            // so nothing else is recorded into it.
                            _pendingScanQueueFrozen = true;
                            TriggerAlert();
                            Toast.MakeText(this, $"⚠️ Lock Box {_currentBoxName} first — heading to Box {_pendingBoxTagNavigation}", ToastLength.Long)?.Show();
                        }
                        else if (assignedBoxId != null && assignedBoxId != _currentBoxName)
                        {
                            // Current box is unlocked — the user forgot to lock it before moving on.
                            // Remind them, defer the navigation, and record incoming scans until they lock.
                            _pendingBoxTagNavigation = assignedBoxId;
                            _pendingScanQueueFrozen = false;
                            TriggerAlert();
                            new AlertDialog.Builder(this)
                                .SetTitle("Box not locked")
                                .SetMessage($"You forgot to lock Box {_currentBoxName}!\n\nValidate the data and lock the box — we'll continue to Box {assignedBoxId} once it's locked.")
                                .SetCancelable(false)
                                .SetPositiveButton("OK", (s, e) => { })
                                .Show();
                        }
                        else if (assignedBoxId == _currentBoxName)
                        {
                            Toast.MakeText(this, $"Already at Box {_currentBoxName} — lock it when done", ToastLength.Short)?.Show();
                        }
                        else
                        {
                            Toast.MakeText(this, $"Unassigned tag — enter Edit Box Tags mode to assign", ToastLength.Short)?.Show();
                        }
                    }
                }
                else
                {
                    // Current box is LOCKED
                    if (assignedBoxId != null)
                    {
                        // This tag is assigned to a box - jump to it and unlock
                        if (assignedBoxId == _currentBoxName)
                        {
                            // Same box - just unlock
                            _isBoxLocked = false;
                            selectedPage = UIFactory.selectedPage.BoxDataSingle;
                            if (_singleBoxDataContentLayout != null) _singleBoxDataContentLayout.Visibility = ViewStates.Visible;
                            if (_heldScans.Count > 0) FlushHeldScansToCurrentBox();
                            else { DrawPageLayouts(); Toast.MakeText(this, $"🔓 Box {_currentBoxName} unlocked", ToastLength.Short)?.Show(); }
                        }
                        else
                        {
                            // Different box - jump to it and unlock
                            if (_boxNamesAndIndexes.ContainsKey(assignedBoxId))
                            {
                                _currentBoxIndex = _boxNamesAndIndexes[assignedBoxId];
                                _currentBoxName = assignedBoxId;
                                _isBoxLocked = false;
                                selectedPage = UIFactory.selectedPage.BoxDataSingle;
                                if (_singleBoxDataContentLayout != null) _singleBoxDataContentLayout.Visibility = ViewStates.Visible;
                                if (_heldScans.Count > 0) FlushHeldScansToCurrentBox();
                                else { DrawPageLayouts(); Toast.MakeText(this, $"📍 Jumped to Box {assignedBoxId} and unlocked", ToastLength.Short)?.Show(); }
                            }
                            else
                            {
                                Toast.MakeText(this, $"⚠️ Box {assignedBoxId} not in current scope", ToastLength.Long)?.Show();
                            }
                        }
                    }
                    else
                    {
                        // Unassigned box tag scanned while locked - error
                        TriggerAlert();
                        Toast.MakeText(this, $"⚠️ Unknown box tag!\nUnlock a box first to assign this tag.", ToastLength.Long)?.Show();
                    }
                }
            });
        }

        // Completes a deferred "forgot to lock" navigation: jump to the box whose tag was scanned
        // and replay the recorded penguin scans into it.
        private void NavigateToPendingBox(string boxName)
        {
            if (!_boxNamesAndIndexes.ContainsKey(boxName))
            {
                Toast.MakeText(this, $"⚠️ Box {boxName} not in current scope", ToastLength.Long)?.Show();
                _heldScans.Clear();
                return;
            }
            _currentBoxIndex = _boxNamesAndIndexes[boxName];
            _currentBoxName = boxName;
            _isBoxLocked = false;
            selectedPage = UIFactory.selectedPage.BoxDataSingle;
            if (_singleBoxDataContentLayout != null) _singleBoxDataContentLayout.Visibility = ViewStates.Visible;
            if (_heldScans.Count > 0)
            {
                // Replay the recorded scans into the now-current box
                FlushHeldScansToCurrentBox();
            }
            else
            {
                DrawPageLayouts();
                Toast.MakeText(this, $"📍 Box {boxName}", ToastLength.Short)?.Show();
            }
        }

        private void AddScannedId(String fullEid, int _unused = 0, bool isManualEntry = false)
        {
            var cleanEid = new String(fullEid.Where(char.IsLetterOrDigit).ToArray());

            // Check if this is a box tag scan (LA9000250*)
            if (BoxTagService.IsBoxTag(cleanEid))
            {
                HandleBoxTagScan(cleanEid);
                return;
            }

            var boxData = _colonyState.GetTodayForBox(_currentBoxName) ?? new BoxObservation { BoxName = _currentBoxName };

            if (!boxData.ScannedIds.Any(s => s.BirdId == cleanEid))
            {
                var scanRecord = new ScanRecord
                {
                    BirdId = cleanEid, // Store full ID, never truncate
                    Timestamp = (isManualEntry && _appSettings.ActiveSessionTimeStampActive) ? TimeZoneInfo.ConvertTimeToUtc(_appSettings.ActiveSessionLocalTimeStamp, NzTimeZone) : DateTime.UtcNow,
                    Latitude = _currentLocation?.Latitude ?? 0,
                    Longitude = _currentLocation?.Longitude ?? 0,
                    Accuracy = _currentLocation?.Accuracy ?? -1
                };
                boxData.ScannedIds.Add(scanRecord);
                boxData.IsPendingUpload = true;
                boxData.PendingUploadSinceUtc ??= DateTime.UtcNow;
                boxData.ObserverName = _appSettings.ObserverName;
                _colonyState.SaveBoxObservation(_currentBoxName, boxData);
                SaveCurrentBoxData();
                RunOnUiThread(() =>
                {
                    // Enhanced toast message with life stage info
                    bool isReturning = false;
                    var displayId = cleanEid.Length >= 8 ? cleanEid.Substring(cleanEid.Length - 8) : cleanEid;
                    if (_remotePenguinData != null && _remotePenguinData.TryGetValue(cleanEid.ToUpper(), out var penguinCheck))
                    {
                        isReturning = penguinCheck.LastKnownLifeStage == LifeStage.Returnee ||
                                      (penguinCheck.LastKnownLifeStage == LifeStage.Chick &&
                                       penguinCheck.ChipDate > DateTime.MinValue &&
                                       (NzNow - penguinCheck.ChipDate).TotalDays > 90);
                    }
                    string birdIcon = isReturning ? "🔄🐧" : "🐧";
                    string toastMessage = $"{birdIcon} Bird {displayId} added to Box {_currentBoxName}";
                    if (_remotePenguinData != null && _remotePenguinData.TryGetValue(cleanEid.ToUpper(), out var penguin))
                    {
                        if (penguin.LastKnownLifeStage == LifeStage.Chick)
                        {
                            bool isOldEnoughToReturn = penguin.ChipDate > NzToday.AddYears(-20) && NzToday > penguin.ChipDate.AddMonths(3);
                            if (isOldEnoughToReturn)
                            {
                                // First return — chick is now an adult
                                _adultsEditText[0].Text = (int.Parse(_adultsEditText[0].Text ?? "0") + 1).ToString();
                                toastMessage += $" 🎉 FIRST RETURN!";
                                triggerAlertAsync();
                                // Update life_stage to Returnee on server
                                UpdatePenguinLifeStage(penguin.PengNum, "Returnee");
                                penguin.LastKnownLifeStage = LifeStage.Returnee;
                            }
                            else
                            {
                                // Still a chick
                                _chicksEditText[0].Text = (int.Parse(_chicksEditText[0].Text ?? "0") + 1).ToString();
                                toastMessage += $" (+1 Chick)";
                            }
                            SaveCurrentBoxData();
                        }
                        else if (penguin.LastKnownLifeStage == LifeStage.Adult ||
                                 penguin.LastKnownLifeStage == LifeStage.Returnee)
                        {
                            _adultsEditText[0].Text = (int.Parse(_adultsEditText[0].Text ?? "0") + 1).ToString();
                            SaveCurrentBoxData();

                            bool unsexed = !penguin.Sex.Equals("f", StringComparison.OrdinalIgnoreCase) && !penguin.Sex.Equals("m", StringComparison.OrdinalIgnoreCase);
                            if (unsexed)
                            {
                                triggerAlertAsync();
                                toastMessage += penguin.LastKnownLifeStage == LifeStage.Returnee ? $" unsexed returnee" : $" unsexed";
                            }
                            else
                                toastMessage += $" (+1 Adult)";
                        }
                        else
                        {
                            toastMessage += ", Not adult or chick.";
                            triggerAlertAsync();
                        }
                    }
                    else
                    {
                        toastMessage += ", Unknown scan ID!";
                        triggerAlertAsync();
                        ShowNewBirdDialog(displayId, cleanEid);
                    }
                    DrawPageLayouts();
                    Toast.MakeText(this, toastMessage, ToastLength.Short)?.Show();
                });
            }
        }
        private void ShowSaveFilenameDialog(bool upload = false)
        {
            var now = NzNow;
            string defaultFileName = $"PenguinMonitor {now:yyMMdd HHmmss}";            
            if (!string.IsNullOrEmpty((_colonyState.DailyLabel ?? "")))
            {
                if (!Regex.Match((_colonyState.DailyLabel ?? ""), @"-\d\d$").Success)   // string ends with -00 or -37
                {
                    defaultFileName = (_colonyState.DailyLabel ?? "") + "-01";
                }
                else
                {
                    defaultFileName = Regex.Replace((_colonyState.DailyLabel ?? ""), @"-(\d\d)$", match =>
                    {
                        int number = int.Parse(match.Groups[1].Value);
                        return "-" + (number + 1).ToString("D2");
                    });
                }
            }
            var input = new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassText,
                Text = defaultFileName,
                Hint = "Enter filename (without .json extension)"
            };
            input.SetTextColor(UIFactory.TEXT_PRIMARY);
            input.SetPadding(16, 16, 16, 16);
            input.Background = _uiFactory.CreateRoundedBackground(UIFactory.LIGHTER_GRAY, 8);


            var alertDialog = new AlertDialog.Builder(this)
                .SetTitle("Save Data File")
                .SetMessage("Enter a filename for your data export:")
                .SetView(input)
                .SetPositiveButton("Save", (s, e) =>
                {
                    var fileName = input.Text?.Trim();
                    if (string.IsNullOrEmpty(fileName))
                    {
                        Toast.MakeText(this, "Please enter a filename", ToastLength.Short)?.Show();
                        return;
                    }

                    // Clean filename - remove invalid characters
                    var invalidChars = System.IO.Path.GetInvalidFileNameChars();
                    foreach (var invalidChar in invalidChars)
                    {
                        fileName = fileName.Replace(invalidChar, '_');
                    }

                    // Ensure .json extension
                    if (!fileName.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                    {
                        fileName += ".json";
                    }
                    SaveDataWithFilename(fileName, upload);
                })
                .SetNegativeButton("Cancel", (s, e) => { })
                .Create();

            alertDialog?.Show();
            
            input.RequestFocus();
            input.SelectAll();

            var inputMethodManager = (Android.Views.InputMethods.InputMethodManager?)GetSystemService(InputMethodService);
            inputMethodManager?.ShowSoftInput(input, Android.Views.InputMethods.ShowFlags.Implicit);
        }
        private void SaveDataWithFilename(string fileName, bool upload)
        {
            try
            {
                _colonyState.DailyLabel = fileName.Replace(".json","");
                var jsonContents = JsonConvert.SerializeObject(_colonyState, Formatting.Indented);
                var downloadsPath = Android.OS.Environment.GetExternalStoragePublicDirectory(Android.OS.Environment.DirectoryDownloads)?.AbsolutePath;

                if (string.IsNullOrEmpty(downloadsPath))
                {
                    Toast.MakeText(this, "Downloads directory not accessible", ToastLength.Short)?.Show();
                    return;
                }

                var filePath = System.IO.Path.Combine(downloadsPath, fileName);

                // Check if file already exists
                if (File.Exists(filePath))
                {
                    ShowConfirmationDialog(
                        "File Exists",
                        $"A file named '{fileName}' already exists. Do you want to overwrite it?",
                        ("Overwrite", () => {
                            SaveJsonToPath(filePath, jsonContents);
                        }
                    ),
                        ("Cancel", () => ShowSaveFilenameDialog()) // Go back to filename dialog
                    );
                }
                else
                {
                    SaveJsonToPath(filePath, jsonContents);
                }
            }
            catch (Exception ex)
            {
                Toast.MakeText(this, $"❌ Export failed: {ex.Message}", ToastLength.Short)?.Show();
            }
        }
        private void SaveJsonToPath(string filePath, string json )
        {
            try
            {
                string fileName = System.IO.Path.GetFileName(filePath);
                File.WriteAllText(filePath, json);

                var totalBoxes = _colonyState.TodayBoxes.Count + _colonyState.PendingObservations.Select(o => o.BoxName).Distinct().Count();
                var totalBirds = _colonyState.TodayBoxes.Values.Sum(box => box.ScannedIds.Count) + _colonyState.PendingObservations.Sum(o => o.ScannedIds.Count);

                Toast.MakeText(this, $"💾 Data saved!\n📂 {fileName}\n📦 {totalBoxes} boxes, 🐧 {totalBirds} birds", ToastLength.Short)?.Show();
            }
            catch (Exception ex)
            {
                Toast.MakeText(this, $"❌ Failed to save file: {ex.Message}", ToastLength.Long)?.Show();
            }
        }
        public override void OnRequestPermissionsResult(int requestCode, string[] permissions, Android.Content.PM.Permission[] grantResults)
        {
            if (OperatingSystem.IsAndroidVersionAtLeast(23))
            {
                base.OnRequestPermissionsResult(requestCode, permissions, grantResults);

                if (requestCode == 1)
                {
                    bool allPermissionsGranted = grantResults.All(result => result == Android.Content.PM.Permission.Granted);

                    if (allPermissionsGranted)
                    {
                        if (_appSettings?.IsBlueToothEnabled == true) InitializeGPS();
                        Toast.MakeText(this, "✅ All permissions granted", ToastLength.Short)?.Show();
                    }
                    else
                    {
                        var deniedPermissions = permissions.Zip(grantResults, (perm, result) => new { Permission = perm, Granted = result == Permission.Granted })
                            .Where(x => !x.Granted)
                            .Select(x => x.Permission)
                            .ToArray();

                        Toast.MakeText(this, $"⚠️ Some permissions denied. App functionality may be limited.\nDenied: {string.Join(", ", deniedPermissions.Select(p => p.Split('.').Last()))}", ToastLength.Long)?.Show();
                    }
                }
                else if (requestCode == 2) // READ_EXTERNAL_STORAGE request from LoadJsonDataFromFile
                {
                    if (grantResults.Length > 0 && grantResults[0] == Permission.Granted)
                    {
                        Toast.MakeText(this, "✅ Storage permission granted. Try loading files again.", ToastLength.Short)?.Show();
                    }
                    else
                    {
                        Toast.MakeText(this, "❌ Storage permission denied. Cannot access Downloads folder.", ToastLength.Short)?.Show();
                    }
                }
            }
        }
        private bool CheckExternalStoragePermissions()
        {
            try
            {
                var sdkVersion = (int)Android.OS.Build.VERSION.SdkInt;
                System.Diagnostics.Debug.WriteLine($"Checking permissions for Android API {sdkVersion}");

                if (OperatingSystem.IsAndroidVersionAtLeast(30)) // Android 11+ (API 30+)
                {
                    // Android 11+ - Check if we have MANAGE_EXTERNAL_STORAGE
                    var hasManageStorage = Android.OS.Environment.IsExternalStorageManager;
                    System.Diagnostics.Debug.WriteLine($"Android 11+: MANAGE_EXTERNAL_STORAGE = {hasManageStorage}");
                    return hasManageStorage;
                }
                else if (OperatingSystem.IsAndroidVersionAtLeast(23)) // Android 6+ (API 23+)
                {
                    // Android 6-10 - Check READ_EXTERNAL_STORAGE permission using native API
                    var hasReadPermission = CheckSelfPermission(Android.Manifest.Permission.ReadExternalStorage) == Android.Content.PM.Permission.Granted;
                    System.Diagnostics.Debug.WriteLine($"Android 6-10: READ_EXTERNAL_STORAGE = {hasReadPermission}");
                    return hasReadPermission;
                }
                else
                {
                    // Pre-Android 6 - Permission granted at install time
                    System.Diagnostics.Debug.WriteLine("Pre-Android 6: Permissions granted at install time");
                    return true;
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Permission check failed: {ex.Message}");
                return false;
            }
        }
        private void ShowBoxJumpDialog()
        {
            var input = new EditText(this)
            {
                Text = _currentBoxIndex.ToString()
            };
            input.InputType = InputTypes.ClassText;      // numeric keyboard
            input.SetSelectAllOnFocus(true);               // easy overwrite
            input.ImeOptions = (ImeAction)ImeFlags.NoExtractUi | ImeAction.Go;

            var dialog = new AlertDialog.Builder(this)
                .SetTitle("Jump to Box")
                .SetMessage($"Enter box name in scope: " + _appSettings.BoxSetString)
                .SetView(input)
                .SetPositiveButton("Go", (s, e) =>
                {
                    var matchingKey = _boxNamesAndIndexes.Keys.FirstOrDefault(k => string.Equals(k, input.Text, StringComparison.OrdinalIgnoreCase));
                    if (matchingKey != null)
                    {
                        JumpToBox(matchingKey);
                    }
                    else
                    {
                        Toast.MakeText(this, $"Box number must be in scope: " + _appSettings.BoxSetString, ToastLength.Short)?.Show();
                    }
                })
                .SetNegativeButton("Cancel", (s, e) => { })
                .Create();

            dialog.Show();

            // Ensure the keyboard pops and the input is focused
            input.Post(() =>
            {
                input.RequestFocus();
                dialog.Window?.SetSoftInputMode(SoftInput.StateAlwaysVisible);

                var imm = (InputMethodManager)GetSystemService(Context.InputMethodService);
                imm?.ShowSoftInput(input, ShowFlags.Forced);
            });

            // Let the keyboard's Go/Done key trigger the positive button
            var btnGo = dialog.GetButton((int)DialogButtonType.Positive);
            input.EditorAction += (s, e) =>
            {
                if (e.ActionId == ImeAction.Go || e.ActionId == ImeAction.Done)
                {
                    btnGo?.PerformClick();
                    e.Handled = true;
                }
            };
        }
        private void JumpToBox(string targetBox)
        {
            if (targetBox == _currentBoxName)
            {
                Toast.MakeText(this, $"Already at Box {targetBox}", ToastLength.Short)?.Show();
                return;
            }
            if (!_isBoxLocked)
            {
                Toast.MakeText(this, $"Cannot change box while current box is unlocked.", ToastLength.Short)?.Show();
                return;
            }
            _currentBoxIndex = _boxNamesAndIndexes[targetBox];
            _currentBoxName = targetBox;
            // Box changed
            _singleBoxDataContentLayout.Visibility = ViewStates.Visible;
            DrawPageLayouts();
        }
        private string? GetSelectedStatus(Spinner spinner)
        {
            if (spinner?.SelectedItem != null)
            {
                var selected = spinner.SelectedItem.ToString() ?? "";
                return string.IsNullOrEmpty(selected) ? null : selected;
            }
            return null;
        }
        private void SetSpinnerStatus(Spinner spinner, string? gateStatus)
        {
            if (spinner?.Adapter != null)
            {
                var adapter = spinner.Adapter as ArrayAdapter<string>;
                if (adapter != null)
                {
                    var displayValue = gateStatus ?? "";
                    var position = adapter.GetPosition(displayValue);
                    if (position >= 0)
                        spinner.SetSelection(position);
                }
            }
        }
        private void OnManualAddClick(object? sender, EventArgs e)
        {
            if (_manualScanEditText == null) return;

            var inputText = _manualScanEditText.Text?.Trim() ?? "";

            if (string.IsNullOrEmpty(inputText))
            {
                Toast.MakeText(this, "Please enter a scan number", ToastLength.Short)?.Show();
                return;
            }

            // Validate 8-digit alphanumeric
            var cleanInput = new string(inputText.Where(char.IsLetterOrDigit).ToArray()).ToUpper();
            
            if (cleanInput.Length != 8)
            {
                Toast.MakeText(this, "Scan number must be exactly 8 digits/letters", ToastLength.Short)?.Show();
                _manualScanEditText.RequestFocus();
                return;
            }
            AddScannedId(cleanInput, 0, isManualEntry: true);
        }
        private void OnDataClick(object? sender, EventArgs e)
        {
            ShowDataOptionsDialog();
        }
        private void ShowDataOptionsDialog()
        {
            var options = new string[]
            {
                "📊 Monitor statistics",
                "💾 Save monitor",
                "📂 Open monitor file",
            };
            var builder = new AlertDialog.Builder(this);
            builder.SetTitle("Load & Save Options");            
            builder.SetItems(options, (sender, args) =>
            {
                switch (args.Which)
                {
                    case 0: // Summary
                        ShowBoxDataSummary();
                        break;
                    case 1: // Save data
                        OnSaveDataClick(null, EventArgs.Empty);
                        break;
                    case 2: // Load data
                        LoadJsonDataFromFile();
                        break;
                }
            });
            builder.SetNegativeButton("Cancel", (sender, args) => { });            
            var dialog = builder.Create();
            dialog?.Show();
        }
    }
}