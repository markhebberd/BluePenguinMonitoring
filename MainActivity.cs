using Android;
using Android.App;
using Android.Content;
using Android.Graphics;
using Android.Graphics.Drawables;
using Android.Locations;
using Android.OS;
using Android.Text;
using Android.Views;
using Android.Widget;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace BluePenguinMonitoring
{
    [Activity(
        Label = "@string/app_name",
        MainLauncher = true,
        Theme = "@android:style/Theme.NoTitleBar",
        ScreenOrientation = Android.Content.PM.ScreenOrientation.Portrait,
        WindowSoftInputMode = SoftInput.AdjustResize
    )]
    public class MainActivity : Activity, ILocationListener
    {
        // Modern color palette
        private static readonly Color PRIMARY_COLOR = Color.ParseColor("#2196F3");
        private static readonly Color PRIMARY_DARK = Color.ParseColor("#1976D2");
        private static readonly Color SUCCESS_COLOR = Color.ParseColor("#4CAF50");
        private static readonly Color WARNING_COLOR = Color.ParseColor("#FF9800");
        private static readonly Color DANGER_COLOR = Color.ParseColor("#F44336");
        private static readonly Color TEXT_FIELD_BACKGROUND_COLOR = Color.ParseColor("#F0F0F0");
        private static readonly Color BACKGROUND_COLOR = Color.LightGray;
        private static readonly Color CARD_COLOR = Color.White;
        private static readonly Color TEXT_PRIMARY = Color.ParseColor("#212121");
        private static readonly Color TEXT_SECONDARY = Color.ParseColor("#757575");
        
        // Add alternating row colors for bird scans
        private static readonly Color SCAN_ROW_EVEN = Color.ParseColor("#FAFAFA");
        private static readonly Color SCAN_ROW_ODD = Color.ParseColor("#F5F5F5");

        // Bluetooth manager
        private BluetoothManager? _bluetoothManager;

        // GPS components
        private LocationManager? _locationManager;
        private Location? _currentLocation;
        private float _gpsAccuracy = -1;

        // UI Components
        private TextView? _statusText;
        private TextView? _boxNumberText;
        private LinearLayout? _scannedIdsContainer;
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

        // High value confirmation tracking - reset on each entry
        private bool _isProcessingConfirmation = false;

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

        // Add a field for the data card title so it can be updated dynamically
        private TextView? _dataCardTitle;

        protected override void OnCreate(Bundle? savedInstanceState)
        {
            base.OnCreate(savedInstanceState);

            RequestPermissions();
            LoadDataFromInternalStorage();
            CreateDataRecordingUI();
            LoadBoxData();
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
            var scrollView = new ScrollView(this);
            scrollView.SetBackgroundColor(BACKGROUND_COLOR);

            scrollView.SetOnApplyWindowInsetsListener(new ViewInsetsListener());

            var layout = new LinearLayout(this)
            {
                Orientation = Orientation.Vertical
            };

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
            statusParams.SetMargins(0, 20, 0, 0);
            _statusText.LayoutParameters = statusParams;
            headerCard.AddView(_statusText);
            layout.AddView(headerCard);

            // Action buttons   
            var topButtonLayout = CreateStyledButtonLayout(
                ("Clear All", OnClearBoxesClick, DANGER_COLOR),
                ("Clear Box", OnClearBoxClick, WARNING_COLOR),
                ("Save Data", OnSaveDataClick, SUCCESS_COLOR)
            );
            topButtonLayout.LayoutParameters = statusParams;
            headerCard.AddView(topButtonLayout);

            // Navigation card
            var boxNavLayout = CreateNavigationLayout();
            boxNavLayout.LayoutParameters = statusParams;
            headerCard.AddView(boxNavLayout);

            // Data card
            var dataCard = CreateCard();

            // Data entry fields and scanned birds
            CreateBoxDataCard(dataCard);

            layout.AddView(dataCard);

            scrollView.AddView(layout);
            SetContentView(scrollView);

            scrollView.SetOnApplyWindowInsetsListener(new ViewInsetsListener());
        }

        private class ViewInsetsListener : Java.Lang.Object, View.IOnApplyWindowInsetsListener
        {
            public WindowInsets OnApplyWindowInsets(View v, WindowInsets insets)
            {
                int topInset = insets.SystemWindowInsetTop;
                int bottomInset = insets.SystemWindowInsetBottom;
                
                if (Android.OS.Build.VERSION.SdkInt >= Android.OS.BuildVersionCodes.P && insets.DisplayCutout != null)
                {
                    topInset = Math.Max(topInset, insets.DisplayCutout.SafeInsetTop);
                }

                // Apply padding to avoid content being hidden behind system UI
                v.SetPadding(20, topInset + 20, 20, bottomInset + 20);

                return insets;
            }
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

            _prevBoxButton = CreateStyledButton("← Prev box", PRIMARY_COLOR);
            _prevBoxButton.Click += OnPrevBoxClick;
            var prevParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1);
            _prevBoxButton.LayoutParameters = prevParams;

            _boxNumberText = new TextView(this)
            {
                Text = "Select Box",
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

            _nextBoxButton = CreateStyledButton("Next box →", PRIMARY_COLOR);
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

        private void CreateBoxDataCard(LinearLayout layout)
        {
            _dataCardTitle = new TextView(this)
            {
                Text = $"Box {_currentBox}",
                TextSize = 30,
                Gravity = GravityFlags.CenterHorizontal // Center horizontally
            };
            _dataCardTitle.SetTextColor(TEXT_PRIMARY);
            _dataCardTitle.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            var dataTitleParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            dataTitleParams.SetMargins(0, 0, 0, 16); // More space below title
            _dataCardTitle.LayoutParameters = dataTitleParams;
            layout.AddView(_dataCardTitle);

            // Scanned birds container - no nested ScrollView needed
            _scannedIdsContainer = new LinearLayout(this)
            {
                Orientation = Orientation.Vertical
            };
            _scannedIdsContainer.SetPadding(16, 16, 16, 16);
            _scannedIdsContainer.Background = CreateRoundedBackground(TEXT_FIELD_BACKGROUND_COLOR, 8);
            var idsParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            idsParams.SetMargins(0, 0, 0, 16); // More space below scanned birds
            _scannedIdsContainer.LayoutParameters = idsParams;
            layout.AddView(_scannedIdsContainer);

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
            inputFieldsParams.SetMargins(0, 0, 0, 16); // More space below number fields
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
            notesLabelParams.SetMargins(0, 0, 0, 8); // More space below notes label
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
            _notesEditText.Background = CreateRoundedBackground(TEXT_FIELD_BACKGROUND_COLOR, 8);
            var notesEditParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            notesEditParams.SetMargins(0, 0, 0, 8); // More space below notes field
            _notesEditText.LayoutParameters = notesEditParams;
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
            editText.Background = CreateRoundedBackground(TEXT_FIELD_BACKGROUND_COLOR, 8); // <-- updated
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
                }
            ),
                ("No", () => { }
            )
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
                }
            ),
                ("Cancel", () => { }
            )
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
                    }
                ),
                    ("Skip", () => { }
                )
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
            var totalAdults = _boxDataStorage.Values.Sum(box => box.Adults);
            var totalEggs = _boxDataStorage.Values.Sum(box => box.Eggs);
            var totalChicks = _boxDataStorage.Values.Sum(box => box.Chicks);

            ShowConfirmationDialog(
                "Save All Data",
                $"Save data to Downloads folder?\n\n📦 {totalBoxes} boxes\n🐧 {totalBirds} bird scans\n👥 {totalAdults} adults\n🥚 {totalEggs} eggs\n🐣 {totalChicks} chicks",
                ("Save", SaveAllData),
                ("Cancel", () => { }
            )
            );
        }

        private void ShowConfirmationDialog(string title, string message, (string text, Action action) positiveButton, (string text, Action action) negativeButton)
        {
            var dialogView = new LinearLayout(this)
            {
                Orientation = Orientation.Vertical
            };
            dialogView.SetPadding(30, 30, 30, 30);

            var titleText = new TextView(this)
            {
                Text = title,
                TextSize = 24, // Increased from default (50% bigger)
                Gravity = GravityFlags.Center
            };
            titleText.SetTextColor(TEXT_PRIMARY);
            titleText.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            var titleParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            titleParams.SetMargins(0, 0, 0, 24);
            titleText.LayoutParameters = titleParams;
            dialogView.AddView(titleText);

            var messageText = new TextView(this)
            {
                Text = message,
                TextSize = 21, // Increased from default 14 (50% bigger)
                Gravity = GravityFlags.Start
            };
            messageText.SetTextColor(TEXT_PRIMARY);
            var messageParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            messageParams.SetMargins(0, 0, 0, 24);
            messageText.LayoutParameters = messageParams;
            dialogView.AddView(messageText);

            var alertDialog = new AlertDialog.Builder(this, Android.Resource.Style.ThemeDeviceDefaultLightDialog)
                .SetView(dialogView)
                .SetPositiveButton(positiveButton.text, (s, e) => positiveButton.action())
                .SetNegativeButton(negativeButton.text, (s, e) => negativeButton.action())
                .Create();

            alertDialog.ShowEvent += (sender, args) =>
            {
                // Increase button text size by 50%
                var positiveBtn = alertDialog.GetButton((int)DialogButtonType.Positive);
                var negativeBtn = alertDialog.GetButton((int)DialogButtonType.Negative);

                if (positiveBtn != null)
                {
                    positiveBtn.TextSize = 21; // Increased from default 14 (50% bigger)
                }
                if (negativeBtn != null)
                {
                    negativeBtn.TextSize = 21; // Increased from default 14 (50% bigger)
                }
            };

            alertDialog?.Show();
        }

        private void OnDataChanged(object? sender, TextChangedEventArgs e)
        {
            if (_isProcessingConfirmation)
                return;

            CheckForHighValueConfirmation();
        }

        private void CheckForHighValueConfirmation()
        {
            int adults, eggs, chicks;
            int.TryParse(_adultsEditText?.Text ?? "0", out adults);
            int.TryParse(_eggsEditText?.Text ?? "0", out eggs);
            int.TryParse(_chicksEditText?.Text ?? "0", out chicks);

            // Check if any values are 3 or greater - no state tracking, ask every time
            var highValues = new List<(string type, int count)>();
            if (adults >= 3) highValues.Add(("adults", adults));
            if (eggs >= 3) highValues.Add(("eggs", eggs));
            if (chicks >= 3) highValues.Add(("chicks", chicks));

            if (highValues.Count > 0)
            {
                ShowHighValueConfirmationDialog(highValues);
            }
            else
            {
                // No high values, save normally
                SaveCurrentBoxData();
            }
        }

        private void ShowHighValueConfirmationDialog(List<(string type, int count)> highValues)
        {
            _isProcessingConfirmation = true;

            var message = "Are you sure you have found:\n\n";
            foreach (var (type, count) in highValues)
            {
                message += $"• {count} {type}\n";
            }
            message += "\nThis is a high count. Please confirm this is correct.";

            ShowConfirmationDialog(
                "High Value Confirmation",
                message,
                ("Yes, Correct", () =>
                {
                    _isProcessingConfirmation = false;
                    SaveCurrentBoxData();
                }
            ),
                ("No, Let me fix", () =>
                {
                    _isProcessingConfirmation = false;
                    // Don't save, let user modify the values
                }
            )
            );
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

        // Update the title when the box changes
        private void UpdateUI()
        {
            if (_dataCardTitle != null) _dataCardTitle.Text = $"Box {_currentBox}";
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
            if (_scannedIdsContainer == null) return;

            // Clear existing views
            _scannedIdsContainer.RemoveAllViews();

            if (scans.Count == 0)
            {
                var emptyText = new TextView(this)
                {
                    Text = "No birds scanned yet",
                    TextSize = 14
                };
                emptyText.SetTextColor(TEXT_SECONDARY);
                _scannedIdsContainer.AddView(emptyText);
            }
            else
            {
                // Header text
                var headerText = new TextView(this)
                {
                    Text = $"🐧 {scans.Count} bird{(scans.Count == 1 ? "" : "s")} scanned:",
                    TextSize = 14
                };
                headerText.SetTextColor(TEXT_PRIMARY);
                headerText.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
                var headerParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
                headerParams.SetMargins(0, 0, 0, 12);
                headerText.LayoutParameters = headerParams;
                _scannedIdsContainer.AddView(headerText);

                // Individual scan records with delete buttons
                for (int i = 0; i < scans.Count; i++)
                {
                    var scan = scans[i];
                    var scanLayout = CreateScanRecordView(scan, i);
                    _scannedIdsContainer.AddView(scanLayout);
                }
            }
        }

        private LinearLayout CreateScanRecordView(ScanRecord scan, int index)
        {
            var scanLayout = new LinearLayout(this)
            {
                Orientation = Orientation.Horizontal
            };

            var layoutParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            layoutParams.SetMargins(0, 2, 0, 2);
            scanLayout.LayoutParameters = layoutParams;

            // Add alternating background colors and padding for better visual separation
            var backgroundColor = index % 2 == 0 ? SCAN_ROW_EVEN : SCAN_ROW_ODD;
            scanLayout.Background = CreateRoundedBackground(backgroundColor, 4);
            scanLayout.SetPadding(12, 8, 12, 8);

            // Scan info text
            var timeStr = scan.Timestamp.ToString("MMM dd, HH:mm");
            var scanText = new TextView(this)
            {
                Text = $"• {scan.BirdId} at {timeStr}",
                TextSize = 14
            };
            scanText.SetTextColor(TEXT_PRIMARY);
            var textParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1);
            scanText.LayoutParameters = textParams;
            scanLayout.AddView(scanText);

            // Move button
            var moveButton = new Button(this)
            {
                Text = "Move",
                TextSize = 12
            };
            moveButton.SetTextColor(Color.White);
            moveButton.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            moveButton.SetPadding(12, 8, 12, 8);
            moveButton.Background = CreateRoundedBackground(PRIMARY_COLOR, 6);
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
            deleteButton.Background = CreateRoundedBackground(DANGER_COLOR, 6);
            deleteButton.SetAllCaps(false);

            var deleteButtonParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent);
            deleteButtonParams.SetMargins(4, 0, 0, 0);
            deleteButton.LayoutParameters = deleteButtonParams;

            // Set up delete functionality
            deleteButton.Click += (sender, e) => OnDeleteScanClick(scan);

            scanLayout.AddView(deleteButton);

            return scanLayout;
        }

        private void OnDeleteScanClick(ScanRecord scanToDelete)
        {
            ShowConfirmationDialog(
                "Delete Bird Scan",
                $"Are you sure you want to delete the scan for bird {scanToDelete.BirdId}?",
                ("Yes, Delete", () =>
                {
                    if (_boxDataStorage.ContainsKey(_currentBox))
                    {
                        var boxData = _boxDataStorage[_currentBox];
                        var scanToRemove = boxData.ScannedIds.FirstOrDefault(s =>
                            s.BirdId == scanToDelete.BirdId &&
                            s.Timestamp == scanToDelete.Timestamp);

                        if (scanToRemove != null)
                        {
                            boxData.ScannedIds.Remove(scanToRemove);
                            SaveDataToInternalStorage();
                            UpdateScannedIdsDisplay(boxData.ScannedIds);

                            Toast.MakeText(this, $"🗑️ Bird {scanToDelete.BirdId} deleted from Box {_currentBox}", ToastLength.Short)?.Show();
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
            var dialogView = new LinearLayout(this)
            {
                Orientation = Orientation.Vertical
            };
            dialogView.SetPadding(30, 30, 30, 30);

            var titleText = new TextView(this)
            {
                Text = $"Move Bird {scanToMove.BirdId}",
                TextSize = 24,
                Gravity = GravityFlags.Center
            };
            titleText.SetTextColor(TEXT_PRIMARY);
            titleText.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            var titleParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            titleParams.SetMargins(0, 0, 0, 16);
            titleText.LayoutParameters = titleParams;
            dialogView.AddView(titleText);

            var instructionText = new TextView(this)
            {
                Text = $"Move from Box {_currentBox} to:",
                TextSize = 18
            };
            instructionText.SetTextColor(TEXT_PRIMARY);
            var instructionParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            instructionParams.SetMargins(0, 0, 0, 16);
            instructionText.LayoutParameters = instructionParams;
            dialogView.AddView(instructionText);

            var boxNumberInput = new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassNumber,
                Text = "",
                Hint = "Enter box number (1-150)",
                TextSize = 21
            };
            boxNumberInput.SetTextColor(TEXT_PRIMARY);
            boxNumberInput.SetPadding(16, 16, 16, 16);
            dialogView.AddView(boxNumberInput);

            var alertDialog = new AlertDialog.Builder(this, Android.Resource.Style.ThemeDeviceDefaultLightDialog)
                .SetView(dialogView)
                .SetPositiveButton("Move", (s, e) =>
                {
                    if (int.TryParse(boxNumberInput.Text, out int targetBox))
                    {
                        if (targetBox >= 1 && targetBox <= 150)
                        {
                            if (targetBox == _currentBox)
                            {
                                Toast.MakeText(this, "Bird is already in this box", ToastLength.Short)?.Show();
                            }
                            else
                            {
                                MoveScanToBox(scanToMove, targetBox);
                            }
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
                // Increase button text size by 50%
                var positiveBtn = alertDialog.GetButton((int)DialogButtonType.Positive);
                var negativeBtn = alertDialog.GetButton((int)DialogButtonType.Negative);

                if (positiveBtn != null)
                {
                    positiveBtn.TextSize = 21;
                }
                if (negativeBtn != null)
                {
                    negativeBtn.TextSize = 21;
                }

                boxNumberInput.RequestFocus();
                var inputMethodManager = (Android.Views.InputMethods.InputMethodManager?)GetSystemService(InputMethodService);
                inputMethodManager?.ShowSoftInput(boxNumberInput, Android.Views.InputMethods.ShowFlags.Implicit);
            };

            alertDialog.Show();
        }

        private void MoveScanToBox(ScanRecord scanToMove, int targetBox)
        {
            ShowConfirmationDialog(
                "Move Bird Scan",
                $"Move bird {scanToMove.BirdId} from Box {_currentBox} to Box {targetBox}?",
                ("Yes, Move", () =>
                {
                    // Remove from current box
                    if (_boxDataStorage.ContainsKey(_currentBox))
                    {
                        var currentBoxData = _boxDataStorage[_currentBox];
                        var scanToRemove = currentBoxData.ScannedIds.FirstOrDefault(s =>
                            s.BirdId == scanToMove.BirdId &&
                            s.Timestamp == scanToMove.Timestamp);

                        if (scanToRemove != null)
                        {
                            currentBoxData.ScannedIds.Remove(scanToRemove);

                            // Add to target box
                            if (!_boxDataStorage.ContainsKey(targetBox))
                                _boxDataStorage[targetBox] = new BoxData();

                            var targetBoxData = _boxDataStorage[targetBox];
                            
                            // Check if bird already exists in target box
                            if (!targetBoxData.ScannedIds.Any(s => s.BirdId == scanToMove.BirdId))
                            {
                                targetBoxData.ScannedIds.Add(scanToMove);
                                
                                SaveDataToInternalStorage();
                                UpdateScannedIdsDisplay(currentBoxData.ScannedIds);

                                Toast.MakeText(this, $"🔄 Bird {scanToMove.BirdId} moved from Box {_currentBox} to Box {targetBox}", ToastLength.Long)?.Show();
                            }
                            else
                            {
                                // Restore to current box since target already has this bird
                                currentBoxData.ScannedIds.Add(scanToRemove);
                                Toast.MakeText(this, $"❌ Bird {scanToMove.BirdId} already exists in Box {targetBox}", ToastLength.Long)?.Show();
                            }
                        }
                    }
                }),
                ("Cancel", () => { })
            );
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
                        Toast.MakeText(this, $"📱 Data restored...", ToastLength.Short)?.Show();
                    }
                }
            }
            catch (Exception ex)
            {
                _currentBox = 1;
                _boxDataStorage = new Dictionary<int, BoxData>();
                System.Diagnostics.Debug.WriteLine($"Failed to load data: {ex.Message}");
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
            dialogView.SetPadding(30, 30, 30, 30);

            var instructionText = new TextView(this)
            {
                Text = "Enter box number (1-150):",
                TextSize = 24
            };
            instructionText.SetTextColor(TEXT_PRIMARY);
            var instructionParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            instructionParams.SetMargins(0, 0, 0, 16);
            instructionText.LayoutParameters = instructionParams;
            dialogView.AddView(instructionText);

            var boxNumberInput = new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassNumber,
                Text = _currentBox.ToString(),
                Hint = "Box number",
                TextSize = 21
            };
            boxNumberInput.SetTextColor(TEXT_PRIMARY);
            boxNumberInput.SetPadding(16, 16, 16, 16);
            dialogView.AddView(boxNumberInput);

            var alertDialog = new AlertDialog.Builder(this, Android.Resource.Style.ThemeDeviceDefaultLightDialog)
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
                var positiveBtn = alertDialog.GetButton((int)DialogButtonType.Positive);
                var negativeBtn = alertDialog.GetButton((int)DialogButtonType.Negative);

                if (positiveBtn != null)
                {
                    positiveBtn.TextSize = 21;
                }
                if (negativeBtn != null)
                {
                    negativeBtn.TextSize = 21;
                }

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

            var editTexts = new []
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