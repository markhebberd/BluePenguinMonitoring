using System;
using System.Text;
using System.Threading.Tasks;
using Android.App;
using Android.OS;
using Android.Widget;
using System.Linq;
using System.IO;
using System.Collections.Generic;
using Android.Views;
using Android.Locations;
using Android;
using Android.Text;
using System.Text.Json;
using Android.Graphics.Drawables;
using Android.Graphics;

namespace BluePenguinMonitoring
{
    [Activity(Label = "@string/app_name", MainLauncher = true, Theme = "@android:style/Theme.Light.NoTitleBar.Fullscreen", ScreenOrientation = Android.Content.PM.ScreenOrientation.Portrait)]
    public class MainActivity : Activity, ILocationListener
    {
        // Modern color palette
        private static readonly Color PRIMARY_COLOR = Color.ParseColor("#2196F3");
        private static readonly Color PRIMARY_DARK = Color.ParseColor("#1976D2");
        private static readonly Color ACCENT_COLOR = Color.ParseColor("#FF4081");
        private static readonly Color SUCCESS_COLOR = Color.ParseColor("#4CAF50");
        private static readonly Color WARNING_COLOR = Color.ParseColor("#FF9800");
        private static readonly Color DANGER_COLOR = Color.ParseColor("#F44336");
        private static readonly Color BACKGROUND_COLOR = Color.ParseColor("#F5F5F5");
        private static readonly Color CARD_COLOR = Color.White;
        private static readonly Color TEXT_PRIMARY = Color.ParseColor("#212121");
        private static readonly Color TEXT_SECONDARY = Color.ParseColor("#757575");

        // Bluetooth manager
        private BluetoothManager? _bluetoothManager;

        // GPS components
        private LocationManager? _locationManager;
        private Location? _currentLocation;
        private float _gpsAccuracy = -1;

        // UI Components
        private TextView? _statusText;
        private TextView? _boxNumberText;
        private TextView? _scannedIdsText;
        private EditText? _adultsEditText;
        private EditText? _eggsEditText;
        private EditText? _chicksEditText;
        private EditText? _notesEditText;
        private Button? _prevBoxButton;
        private Button? _nextBoxButton;
        private Button? _clearBoxButton;

        // Data storage
        private Dictionary<int, BoxData> _boxDataStorage = new Dictionary<int, BoxData>();
        private int _currentBox = 1;
        private const string AUTO_SAVE_FILENAME = "penguin_data_autosave.json";

        // Data model classes remain the same
        public class BoxData
        {
            public List<ScanRecord> ScannedIds { get; set; } = new List<ScanRecord>();
            public int Adults { get; set; } = 0;
            public int Eggs { get; set; } = 0;
            public int Chicks { get; set; } = 0;
            public string Notes { get; set; } = "";
        }

        public class ScanRecord
        {
            public string BirdId { get; set; } = "";
            public DateTime Timestamp { get; set; }
            public double Latitude { get; set; }
            public double Longitude { get; set; }
            public float Accuracy { get; set; }
        }

        public class AppDataState
        {
            public int CurrentBox { get; set; } = 1;
            public DateTime LastSaved { get; set; }
            public Dictionary<int, BoxData> BoxData { get; set; } = new Dictionary<int, BoxData>();
        }

        protected override void OnCreate(Bundle? savedInstanceState)
        {
            base.OnCreate(savedInstanceState);
            
            LoadDataFromInternalStorage();
            CreateDataRecordingUI();
            LoadBoxData();
            RequestPermissions();
        }

        private void RequestPermissions()
        {
            var permissions = new List<string>();

            if (Android.OS.Build.VERSION.SdkInt >= Android.OS.BuildVersionCodes.S)
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
                Android.Manifest.Permission.AccessCoarseLocation
            });

            RequestPermissions(permissions.ToArray(), 1);
        }

        private void InitializeGPS()
        {
            _locationManager = (LocationManager?)GetSystemService(LocationService);

            if (_locationManager?.IsProviderEnabled(LocationManager.GpsProvider) != true &&
                _locationManager?.IsProviderEnabled(LocationManager.NetworkProvider) != true)
            {
                Toast.MakeText(this, "Please enable location services for accurate positioning", ToastLength.Long)?.Show();
                return;
            }

            if (CheckSelfPermission(Android.Manifest.Permission.AccessFineLocation) == Android.Content.PM.Permission.Granted)
            {
                _locationManager?.RequestLocationUpdates(LocationManager.GpsProvider, 1000, 1, this);
                _locationManager?.RequestLocationUpdates(LocationManager.NetworkProvider, 1000, 1, this);
            }
        }

        private void InitializeBluetooth()
        {
            _bluetoothManager = new BluetoothManager();
            _bluetoothManager.StatusChanged += OnBluetoothStatusChanged;
            _bluetoothManager.EidDataReceived += OnEidDataReceived;
            _bluetoothManager.StartConnectionAsync();
        }

        private void OnBluetoothStatusChanged(string status)
        {
            RunOnUiThread(() => UpdateStatusText(status));
        }

        private void OnEidDataReceived(string eidData)
        {
            AddScannedId(eidData);
        }

        public void OnLocationChanged(Location location)
        {
            _currentLocation = location;
            _gpsAccuracy = location.Accuracy;
            UpdateStatusText();
        }

        public void OnStatusChanged(string? provider, Availability status, Bundle? extras) { }
        public void OnProviderEnabled(string provider) { }
        public void OnProviderDisabled(string provider) { }

        private void UpdateStatusText(string? bluetoothStatus = null)
        {
            var btStatus = bluetoothStatus ?? (_bluetoothManager?.IsConnected == true ? "HR5 Connected" : "Connecting to HR5...");
            var gpsStatus = _gpsAccuracy > 0 ? $" | GPS: ±{_gpsAccuracy:F1}m" : " | GPS: No signal";

            RunOnUiThread(() =>
            {
                if (_statusText != null)
                {
                    _statusText.Text = btStatus + gpsStatus;
                    
                    // Update status color based on connection state
                    if (btStatus.Contains("Connected") && _gpsAccuracy > 0)
                        _statusText.SetTextColor(SUCCESS_COLOR);
                    else if (btStatus.Contains("Connected"))
                        _statusText.SetTextColor(WARNING_COLOR);
                    else
                        _statusText.SetTextColor(TEXT_SECONDARY);
                }
            });
        }

        private void CreateDataRecordingUI()
        {
            // Set status bar color
            Window?.SetStatusBarColor(PRIMARY_DARK);
            
            var scrollView = new ScrollView(this);
            scrollView.SetBackgroundColor(BACKGROUND_COLOR);
            
            var layout = new LinearLayout(this)
            {
                Orientation = Orientation.Vertical
            };
            layout.SetPadding(20, 40, 20, 20);

            // App header
            var headerCard = CreateCard();
            var titleText = new TextView(this)
            {
                Text = "🐧 Penguin Monitoring",
                TextSize = 24,
                Gravity = GravityFlags.Center
            };
            titleText.SetTextColor(PRIMARY_COLOR);
            titleText.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            headerCard.AddView(titleText);

            _statusText = new TextView(this)
            {
                Text = "Connecting to HR5... | GPS: No signal",
                TextSize = 14,
                Gravity = GravityFlags.Center
            };
            _statusText.SetTextColor(TEXT_SECONDARY);
            var statusParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            statusParams.SetMargins(0, 8, 0, 0);
            _statusText.LayoutParameters = statusParams;
            headerCard.AddView(_statusText);
            layout.AddView(headerCard);

            // Action buttons card
            var actionsCard = CreateCard();
            var actionsTitle = CreateSectionTitle("Quick Actions");
            actionsCard.AddView(actionsTitle);
            
            var topButtonLayout = CreateStyledButtonLayout(
                ("Clear All", OnClearBoxesClick, DANGER_COLOR),
                ("Clear Box", OnClearBoxClick, WARNING_COLOR),
                ("Save Data", OnSaveDataClick, SUCCESS_COLOR)
            );
            actionsCard.AddView(topButtonLayout);
            layout.AddView(actionsCard);

            // Navigation card
            var navCard = CreateCard();
            var navTitle = CreateSectionTitle("Box Navigation");
            navCard.AddView(navTitle);
            
            var boxNavLayout = CreateNavigationLayout();
            navCard.AddView(boxNavLayout);
            layout.AddView(navCard);

            // Scanned IDs card
            var idsCard = CreateCard();
            var idsTitle = CreateSectionTitle("Scanned Bird IDs");
            idsCard.AddView(idsTitle);

            _scannedIdsText = new TextView(this)
            {
                Text = "No birds scanned yet",
                TextSize = 14
            };
            _scannedIdsText.SetTextColor(TEXT_SECONDARY);
            _scannedIdsText.SetPadding(16, 16, 16, 16);
            _scannedIdsText.Background = CreateRoundedBackground(BACKGROUND_COLOR, 8);
            
            var idsParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            idsParams.SetMargins(0, 8, 0, 0);
            _scannedIdsText.LayoutParameters = idsParams;
            idsCard.AddView(_scannedIdsText);
            layout.AddView(idsCard);

            // Data entry card
            var dataCard = CreateCard();
            CreateDataEntryFields(dataCard);
            layout.AddView(dataCard);

            scrollView.AddView(layout);
            SetContentView(scrollView);

            UpdateUI();
        }

        private LinearLayout CreateCard()
        {
            var card = new LinearLayout(this)
            {
                Orientation = Orientation.Vertical
            };
            
            card.SetPadding(20, 16, 20, 16);
            card.Background = CreateCardBackground();
            
            var cardParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            cardParams.SetMargins(0, 0, 0, 16);
            card.LayoutParameters = cardParams;
            
            return card;
        }

        private GradientDrawable CreateCardBackground()
        {
            var drawable = new GradientDrawable();
            drawable.SetColor(CARD_COLOR);
            drawable.SetCornerRadius(12 * Resources?.DisplayMetrics?.Density ?? 12);
            drawable.SetStroke(1, Color.ParseColor("#E0E0E0"));
            return drawable;
        }

        private TextView CreateSectionTitle(string title)
        {
            var titleView = new TextView(this)
            {
                Text = title,
                TextSize = 18
            };
            titleView.SetTextColor(TEXT_PRIMARY);
            titleView.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            
            var titleParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            titleParams.SetMargins(0, 0, 0, 12);
            titleView.LayoutParameters = titleParams;
            
            return titleView;
        }

        private GradientDrawable CreateRoundedBackground(Color color, int radiusDp)
        {
            var drawable = new GradientDrawable();
            drawable.SetColor(color);
            drawable.SetCornerRadius(radiusDp * Resources?.DisplayMetrics?.Density ?? 8);
            return drawable;
        }

        private LinearLayout CreateStyledButtonLayout(params (string text, EventHandler handler, Color color)[] buttons)
        {
            var layout = new LinearLayout(this)
            {
                Orientation = Orientation.Horizontal
            };

            for (int i = 0; i < buttons.Length; i++)
            {
                var (text, handler, color) = buttons[i];
                var button = CreateStyledButton(text, color);
                button.Click += handler;
                
                var buttonParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1);
                if (i > 0) buttonParams.SetMargins(8, 0, 0, 0);
                button.LayoutParameters = buttonParams;
                
                layout.AddView(button);
                
                if (text.Contains("Clear"))
                    _clearBoxButton = button;
            }

            return layout;
        }

        private LinearLayout CreateNavigationLayout()
        {
            var layout = new LinearLayout(this)
            {
                Orientation = Orientation.Horizontal
            };

            _prevBoxButton = CreateStyledButton("← Prev", PRIMARY_COLOR);
            _prevBoxButton.Click += OnPrevBoxClick;
            var prevParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1);
            _prevBoxButton.LayoutParameters = prevParams;

            _boxNumberText = new TextView(this)
            {
                Text = "Box 1",
                TextSize = 20,
                Gravity = GravityFlags.Center,
                Clickable = true,
                Focusable = true
            };
            _boxNumberText.SetTextColor(Color.White);
            _boxNumberText.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            _boxNumberText.SetPadding(16, 24, 16, 24);
            _boxNumberText.Background = CreateRoundedBackground(PRIMARY_COLOR, 8);
            _boxNumberText.Click += OnBoxNumberClick;
            var boxParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1);
            boxParams.SetMargins(8, 0, 8, 0);
            _boxNumberText.LayoutParameters = boxParams;

            _nextBoxButton = CreateStyledButton("Next →", PRIMARY_COLOR);
            _nextBoxButton.Click += OnNextBoxClick;
            var nextParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1);
            _nextBoxButton.LayoutParameters = nextParams;

            layout.AddView(_prevBoxButton);
            layout.AddView(_boxNumberText);
            layout.AddView(_nextBoxButton);

            return layout;
        }

        private Button CreateStyledButton(string text, Color backgroundColor)
        {
            var button = new Button(this)
            {
                Text = text,
                TextSize = 14
            };
            
            button.SetTextColor(Color.White);
            button.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            button.SetPadding(16, 20, 16, 20);
            button.Background = CreateRoundedBackground(backgroundColor, 8);
            button.SetAllCaps(false);
            
            return button;
        }

        private LinearLayout CreateHorizontalButtonLayout(params (string text, EventHandler handler)[] buttons)
        {
            var layout = new LinearLayout(this)
            {
                Orientation = Orientation.Horizontal
            };

            foreach (var (text, handler) in buttons)
            {
                var button = new Button(this)
                {
                    Text = text,
                    LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1)
                };
                
                if (text.StartsWith("Box "))
                {
                    button.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
                }
                
                button.Click += handler;
                layout.AddView(button);
                
                if (text.Contains("Clear"))
                    _clearBoxButton = button;
            }

            return layout;
        }

        private void CreateDataEntryFields(LinearLayout layout)
        {
            var dataTitle = CreateSectionTitle("Box Data");
            layout.AddView(dataTitle);
            
            var headingsLayout = new LinearLayout(this)
            {
                Orientation = Orientation.Horizontal
            };
            var headingsParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            headingsParams.SetMargins(0, 0, 0, 8);
            headingsLayout.LayoutParameters = headingsParams;
            
            var adultsLabel = CreateDataLabel("Adults");
            var eggsLabel = CreateDataLabel("Eggs");
            var chicksLabel = CreateDataLabel("Chicks");
            
            headingsLayout.AddView(adultsLabel);
            headingsLayout.AddView(eggsLabel);
            headingsLayout.AddView(chicksLabel);
            layout.AddView(headingsLayout);
            
            var inputFieldsLayout = new LinearLayout(this)
            {
                Orientation = Orientation.Horizontal
            };
            var inputFieldsParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            inputFieldsParams.SetMargins(0, 0, 0, 16);
            inputFieldsLayout.LayoutParameters = inputFieldsParams;
            
            _adultsEditText = CreateStyledNumberField();
            _eggsEditText = CreateStyledNumberField();
            _chicksEditText = CreateStyledNumberField();
            
            inputFieldsLayout.AddView(_adultsEditText);
            inputFieldsLayout.AddView(_eggsEditText);
            inputFieldsLayout.AddView(_chicksEditText);
            layout.AddView(inputFieldsLayout);
            
            var notesLabel = new TextView(this) 
            { 
                Text = "Notes:", 
                TextSize = 16 
            };
            notesLabel.SetTextColor(TEXT_PRIMARY);
            notesLabel.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            var notesLabelParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            notesLabelParams.SetMargins(0, 8, 0, 8);
            notesLabel.LayoutParameters = notesLabelParams;
            layout.AddView(notesLabel);
            
            _notesEditText = new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassText | Android.Text.InputTypes.TextFlagMultiLine | Android.Text.InputTypes.TextFlagCapSentences,
                Hint = "Enter any additional notes...",
                Gravity = Android.Views.GravityFlags.Top | Android.Views.GravityFlags.Start
            };
            _notesEditText.SetLines(3);
            _notesEditText.SetTextColor(TEXT_PRIMARY);
            _notesEditText.SetHintTextColor(TEXT_SECONDARY);
            _notesEditText.SetPadding(16, 16, 16, 16);
            _notesEditText.Background = CreateRoundedBackground(BACKGROUND_COLOR, 8);
            _notesEditText.TextChanged += OnDataChanged;
            layout.AddView(_notesEditText);
        }

        private TextView CreateDataLabel(string text)
        {
            var label = new TextView(this) 
            { 
                Text = text, 
                TextSize = 14,
                Gravity = GravityFlags.Center,
                LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1)
            };
            label.SetTextColor(TEXT_PRIMARY);
            label.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            return label;
        }

        private EditText CreateStyledNumberField()
        {
            var editText = new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassNumber,
                Text = "0",
                Gravity = GravityFlags.Center,
                LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1)
            };
            
            editText.SetTextColor(TEXT_PRIMARY);
            editText.SetTextSize(Android.Util.ComplexUnitType.Sp, 16);
            editText.SetPadding(16, 20, 16, 20);
            editText.Background = CreateRoundedBackground(BACKGROUND_COLOR, 8);
            editText.TextChanged += OnDataChanged;
            editText.Click += OnNumberFieldClick;
            editText.FocusChange += OnNumberFieldFocus;
            
            var layoutParams = (LinearLayout.LayoutParams)editText.LayoutParameters;
            layoutParams.SetMargins(4, 0, 4, 0);
            
            return editText;
        }

        private EditText CreateInlineNumberField()
        {
            var editText = new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassNumber,
                Text = "0",
                Gravity = GravityFlags.Center,
                LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1)
            };
            editText.TextChanged += OnDataChanged;
            editText.Click += OnNumberFieldClick;
            editText.FocusChange += OnNumberFieldFocus;
            
            var layoutParams = (LinearLayout.LayoutParams)editText.LayoutParameters;
            layoutParams.SetMargins(5, 0, 5, 0);
            
            return editText;
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

        private void OnPrevBoxClick(object? sender, EventArgs e)
        {
            NavigateToBox(_currentBox - 1, () => _currentBox > 1);
        }

        private void OnNextBoxClick(object? sender, EventArgs e)
        {
            NavigateToBox(_currentBox + 1, () => _currentBox < 150);
        }

        private void NavigateToBox(int targetBox, Func<bool> canNavigate)
        {
            if (!canNavigate())
                return;

            if (!_boxDataStorage.ContainsKey(_currentBox))
            {
                ShowEmptyBoxDialog(() =>
                {
                    SaveCurrentBoxData();
                    _currentBox = targetBox;
                    CompleteNavigation();
                }, () =>
                {
                    _currentBox = targetBox;
                    CompleteNavigation();
                });
            }
            else
            {
                SaveCurrentBoxData();
                _currentBox = targetBox;
                CompleteNavigation();
            }
        }

        private void CompleteNavigation()
        {
            LoadBoxData();
            UpdateUI();
        }

        private void ShowEmptyBoxDialog(Action onConfirm, Action onSkip)
        {
            ShowConfirmationDialog(
                "Empty Box Confirmation",
                "Please confirm this box has been inspected and is empty",
                ("Confirm Empty", onConfirm),
                ("Skip", onSkip)
            );
        }

        private void OnClearBoxClick(object? sender, EventArgs e)
        {
            ShowConfirmationDialog(
                "Clear Box Data",
                "Are you sure you want to clear data for box " + _currentBox + "?",
                ("Yes", () =>
                {
                    _boxDataStorage.Remove(_currentBox);
                    LoadBoxData();
                    UpdateUI();
                }),
                ("No", () => { })
            );
        }
        
        private void OnClearBoxesClick(object? sender, EventArgs e)
        {
            ShowConfirmationDialog(
                "Clear All Data",
                "Are you sure you want to clear data for ALL boxes? This cannot be undone!",
                ("Yes, Clear All", () =>
                {
                    _boxDataStorage.Clear();
                    _currentBox = 1;
                    LoadBoxData();
                    ClearInternalStorageData();
                    UpdateUI();
                }),
                ("Cancel", () => { })
            );
        }

        private void OnSaveDataClick(object? sender, EventArgs e)
        {
            if (!_boxDataStorage.ContainsKey(_currentBox))
            {
                ShowConfirmationDialog(
                    "Empty Box Confirmation",
                    "Confirm this box has been inspected, and is empty",
                    ("Confirm Empty", () =>
                    {
                        SaveCurrentBoxData();
                        ShowSaveConfirmation();
                    }),
                    ("Skip", () => { })
                );
            }
            else
            {
                SaveCurrentBoxData();
                ShowSaveConfirmation();
            }
        }

        private void ShowSaveConfirmation()
        {
            var totalBoxes = _boxDataStorage.Count;
            var totalBirds = _boxDataStorage.Values.Sum(box => box.ScannedIds.Count);
            
            ShowConfirmationDialog(
                "Save All Data",
                $"Save data to Downloads folder?\n\n📦 {totalBoxes} boxes\n🐧 {totalBirds} bird scans",
                ("Save", SaveAllData),
                ("Cancel", () => { })
            );
        }

        private void ShowConfirmationDialog(string title, string message, (string text, Action action) positiveButton, (string text, Action action) negativeButton)
        {
            var alertDialog = new AlertDialog.Builder(this, Android.Resource.Style.ThemeDeviceDefaultLightDialog)
                .SetTitle(title)
                .SetMessage(message)
                .SetPositiveButton(positiveButton.text, (s, e) => positiveButton.action())
                .SetNegativeButton(negativeButton.text, (s, e) => negativeButton.action())
                .Create();
            alertDialog?.Show();
        }

        private void OnDataChanged(object? sender, TextChangedEventArgs e)
        {
            SaveCurrentBoxData();
        }

        private void SaveCurrentBoxData()
        {
            if (!_boxDataStorage.ContainsKey(_currentBox))
                _boxDataStorage[_currentBox] = new BoxData();

            var boxData = _boxDataStorage[_currentBox];

            int adults, eggs, chicks;
            int.TryParse(_adultsEditText?.Text ?? "0", out adults);
            int.TryParse(_eggsEditText?.Text ?? "0", out eggs);
            int.TryParse(_chicksEditText?.Text ?? "0", out chicks);

            boxData.Adults = adults;
            boxData.Eggs = eggs;
            boxData.Chicks = chicks;
            boxData.Notes = _notesEditText?.Text ?? "";

            SaveDataToInternalStorage();
        }

        private void LoadBoxData()
        {
            var editTexts = new[] { _adultsEditText, _eggsEditText, _chicksEditText, _notesEditText };
            
            foreach (var editText in editTexts)
            {
                if (editText != null) editText.TextChanged -= OnDataChanged;
            }

            if (_boxDataStorage.ContainsKey(_currentBox))
            {
                var boxData = _boxDataStorage[_currentBox];
                if (_adultsEditText != null) _adultsEditText.Text = boxData.Adults.ToString();
                if (_eggsEditText != null) _eggsEditText.Text = boxData.Eggs.ToString();
                if (_chicksEditText != null) _chicksEditText.Text = boxData.Chicks.ToString();
                if (_notesEditText != null) _notesEditText.Text = boxData.Notes;
                UpdateScannedIdsDisplay(boxData.ScannedIds);
            }
            else
            {
                if (_adultsEditText != null) _adultsEditText.Text = "0";
                if (_eggsEditText != null) _eggsEditText.Text = "0";
                if (_chicksEditText != null) _chicksEditText.Text = "0";
                if (_notesEditText != null) _notesEditText.Text = "";
                UpdateScannedIdsDisplay(new List<ScanRecord>());
            }

            foreach (var editText in editTexts)
            {
                if (editText != null) editText.TextChanged += OnDataChanged;
            }
        }

        private void UpdateUI()
        {
            if (_boxNumberText != null) _boxNumberText.Text = $"Box {_currentBox}";
            if (_prevBoxButton != null) 
            {
                _prevBoxButton.Enabled = _currentBox > 1;
                _prevBoxButton.Alpha = _currentBox > 1 ? 1.0f : 0.5f;
            }
            if (_nextBoxButton != null) 
            {
                _nextBoxButton.Enabled = _currentBox < 150;
                _nextBoxButton.Alpha = _currentBox < 150 ? 1.0f : 0.5f;
            }
        }

        private void UpdateScannedIdsDisplay(List<ScanRecord> scans)
        {
            if (_scannedIdsText == null) return;

            if (scans.Count == 0)
            {
                _scannedIdsText.Text = "No birds scanned yet";
                _scannedIdsText.SetTextColor(TEXT_SECONDARY);
            }
            else
            {
                var displayText = $"🐧 {scans.Count} bird{(scans.Count == 1 ? "" : "s")} scanned:\n\n";
                foreach (var scan in scans)
                {
                    var timeStr = scan.Timestamp.ToString("MMM dd, HH:mm");
                    displayText += $"• {scan.BirdId} at {timeStr}\n";
                }
                _scannedIdsText.Text = displayText.TrimEnd('\n');
                _scannedIdsText.SetTextColor(TEXT_PRIMARY);
            }
        }

        private void AddScannedId(string fullEid)
        {
            var cleanEid = new string(fullEid.Where(char.IsLetterOrDigit).ToArray());
            var shortId = cleanEid.Length >= 8 ? cleanEid.Substring(cleanEid.Length - 8) : cleanEid;

            if (!_boxDataStorage.ContainsKey(_currentBox))
                _boxDataStorage[_currentBox] = new BoxData();

            var boxData = _boxDataStorage[_currentBox];

            if (!boxData.ScannedIds.Any(s => s.BirdId == shortId))
            {
                var scanRecord = new ScanRecord
                {
                    BirdId = shortId,
                    Timestamp = DateTime.Now,
                    Latitude = _currentLocation?.Latitude ?? 0,
                    Longitude = _currentLocation?.Longitude ?? 0,
                    Accuracy = _currentLocation?.Accuracy ?? -1
                };

                boxData.ScannedIds.Add(scanRecord);
                SaveDataToInternalStorage();

                RunOnUiThread(() =>
                {
                    UpdateScannedIdsDisplay(boxData.ScannedIds);
                    Toast.MakeText(this, $"🐧 Bird {shortId} added to Box {_currentBox}", ToastLength.Short)?.Show();
                });
            }
        }

        private void SaveDataToInternalStorage()
        {
            try
            {
                var internalPath = FilesDir?.AbsolutePath;
                if (string.IsNullOrEmpty(internalPath))
                    return;

                var appState = new AppDataState
                {
                    CurrentBox = _currentBox,
                    LastSaved = DateTime.Now,
                    BoxData = _boxDataStorage
                };

                var json = JsonSerializer.Serialize(appState, new JsonSerializerOptions { WriteIndented = true });
                var filePath = System.IO.Path.Combine(internalPath, AUTO_SAVE_FILENAME);
                
                File.WriteAllText(filePath, json);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Auto-save failed: {ex.Message}");
            }
        }

        private void LoadDataFromInternalStorage()
        {
            try
            {
                var internalPath = FilesDir?.AbsolutePath;
                if (string.IsNullOrEmpty(internalPath))
                    return;

                var filePath = System.IO.Path.Combine(internalPath, AUTO_SAVE_FILENAME);
                
                if (File.Exists(filePath))
                {
                    var json = File.ReadAllText(filePath);
                    var appState = JsonSerializer.Deserialize<AppDataState>(json);
                    
                    if (appState != null)
                    {
                        _currentBox = appState.CurrentBox;
                        _boxDataStorage = appState.BoxData ?? new Dictionary<int, BoxData>();
                        
                        Toast.MakeText(this, $"📱 Data restored from {appState.LastSaved:MMM dd, HH:mm} - {_boxDataStorage.Count} boxes", ToastLength.Short)?.Show();
                    }
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to load auto-saved data: {ex.Message}");
                _currentBox = 1;
                _boxDataStorage = new Dictionary<int, BoxData>();
            }
        }

        private void ClearInternalStorageData()
        {
            try
            {
                var internalPath = FilesDir?.AbsolutePath;
                if (!string.IsNullOrEmpty(internalPath))
                {
                    var filePath = System.IO.Path.Combine(internalPath, AUTO_SAVE_FILENAME);
                    if (File.Exists(filePath))
                    {
                        File.Delete(filePath);
                    }
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to clear auto-save file: {ex.Message}");
            }
        }

        private void SaveAllData()
        {
            try
            {
                var exportData = new
                {
                    ExportTimestamp = DateTime.Now,
                    TotalBoxes = _boxDataStorage.Count,
                    TotalBirds = _boxDataStorage.Values.Sum(box => box.ScannedIds.Count),
                    Boxes = _boxDataStorage.Select(kvp => new
                    {
                        BoxNumber = kvp.Key,
                        Data = kvp.Value
                    }).OrderBy(b => b.BoxNumber).ToList()
                };

                var json = JsonSerializer.Serialize(exportData, new JsonSerializerOptions { WriteIndented = true });

                var downloadsPath = Android.OS.Environment.GetExternalStoragePublicDirectory(Android.OS.Environment.DirectoryDownloads)?.AbsolutePath;
                
                if (string.IsNullOrEmpty(downloadsPath))
                {
                    Toast.MakeText(this, "Downloads directory not accessible", ToastLength.Long)?.Show();
                    return;
                }

                var now = DateTime.Now;
                var fileName = $"PenguinMonitoring {now:yyMMdd HHmmss}.json";
                var filePath = System.IO.Path.Combine(downloadsPath, fileName);

                File.WriteAllText(filePath, json);

                var totalBoxes = _boxDataStorage.Count;
                var totalBirds = _boxDataStorage.Values.Sum(box => box.ScannedIds.Count);

                Toast.MakeText(this, $"💾 Data saved!\n📂 {fileName}\n📦 {totalBoxes} boxes, 🐧 {totalBirds} birds", ToastLength.Long)?.Show();
            }
            catch (Exception ex)
            {
                Toast.MakeText(this, $"❌ Export failed: {ex.Message}", ToastLength.Long)?.Show();
            }
        }

        public override void OnRequestPermissionsResult(int requestCode, string[] permissions, Android.Content.PM.Permission[] grantResults)
        {
            base.OnRequestPermissionsResult(requestCode, permissions, grantResults);
            
            if (requestCode == 1)
            {
                bool allPermissionsGranted = grantResults.All(result => result == Android.Content.PM.Permission.Granted);
                
                if (allPermissionsGranted)
                {
                    InitializeGPS();
                    InitializeBluetooth();
                }
                else
                {
                    Toast.MakeText(this, "Required permissions not granted. App functionality will be limited.", ToastLength.Long)?.Show();
                }
            }
        }

        private void OnBoxNumberClick(object? sender, EventArgs e)
        {
            ShowBoxJumpDialog();
        }

        private void ShowBoxJumpDialog()
        {
            var dialogView = new LinearLayout(this)
            {
                Orientation = Orientation.Vertical
            };
            dialogView.SetPadding(20, 20, 20, 20);

            var instructionText = new TextView(this)
            {
                Text = "Enter box number (1-150):",
                TextSize = 16
            };
            dialogView.AddView(instructionText);

            var boxNumberInput = new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassNumber,
                Text = _currentBox.ToString(),
                Hint = "Box number"
            };
            dialogView.AddView(boxNumberInput);

            var alertDialog = new AlertDialog.Builder(this, Android.Resource.Style.ThemeDeviceDefaultLightDialog)
                .SetTitle("Jump to Box")
                .SetView(dialogView)
                .SetPositiveButton("Go", (s, e) =>
                {
                    if (int.TryParse(boxNumberInput.Text, out int targetBox))
                    {
                        if (targetBox >= 1 && targetBox <= 150)
                        {
                            JumpToBox(targetBox);
                        }
                        else
                        {
                            Toast.MakeText(this, "Box number must be between 1 and 150", ToastLength.Short)?.Show();
                        }
                    }
                    else
                    {
                        Toast.MakeText(this, "Please enter a valid box number", ToastLength.Short)?.Show();
                    }
                })
                .SetNegativeButton("Cancel", (s, e) => { })
                .Create();

            alertDialog.ShowEvent += (sender, args) =>
            {
                boxNumberInput.RequestFocus();
                boxNumberInput.SelectAll();

                var inputMethodManager = (Android.Views.InputMethods.InputMethodManager?)GetSystemService(InputMethodService);
                inputMethodManager?.ShowSoftInput(boxNumberInput, Android.Views.InputMethods.ShowFlags.Implicit);
            };

            alertDialog.Show();
        }

        private void JumpToBox(int targetBox)
        {
            if (targetBox == _currentBox)
            {
                Toast.MakeText(this, $"Already at Box {_currentBox}", ToastLength.Short)?.Show();
                return;
            }
            
            _currentBox = targetBox;
            LoadBoxData();
            UpdateUI();
            
            Toast.MakeText(this, $"📦 Jumped to Box {_currentBox}", ToastLength.Short)?.Show();
        }

        protected override void OnDestroy()
        {
            _bluetoothManager?.Dispose();

            var editTexts = new[] 
            { 
                (_adultsEditText, true), (_eggsEditText, true), (_chicksEditText, true), (_notesEditText, false) 
            };
            
            foreach (var (editText, hasNumberEvents) in editTexts)
            {
                if (editText != null)
                {
                    editText.TextChanged -= OnDataChanged;
                    if (hasNumberEvents)
                    {
                        editText.Click -= OnNumberFieldClick;
                        editText.FocusChange -= OnNumberFieldFocus;
                    }
                }
            }
            
            if (_prevBoxButton != null) _prevBoxButton.Click -= OnPrevBoxClick;
            if (_nextBoxButton != null) _nextBoxButton.Click -= OnNextBoxClick;
            if (_clearBoxButton != null) _clearBoxButton.Click -= OnClearBoxesClick;
            if (_boxNumberText != null) _boxNumberText.Click -= OnBoxNumberClick;
    
            _locationManager?.RemoveUpdates(this);
            
            base.OnDestroy();
        }
    }
}