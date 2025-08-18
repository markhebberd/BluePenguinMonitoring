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

namespace BluePenguinMonitoring
{
    [Activity(Label = "@string/app_name", MainLauncher = true, Theme = "@android:style/Theme.Light.NoTitleBar.Fullscreen")]
    public class MainActivity : Activity, ILocationListener
    {
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

        // Data model
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
            
            // Load any existing data before creating UI
            LoadDataFromInternalStorage();
            
            CreateDataRecordingUI();
            
            // Load the current box data into the UI after it's created
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

            // Add storage permission for saving files
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
                // Location services are disabled
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
            var btStatus = bluetoothStatus ?? (_bluetoothManager?.IsConnected == true ? "HR5 Connected - Ready to scan" : "Connecting to HR5...");
            var gpsStatus = _gpsAccuracy > 0 ? $" | GPS: ±{_gpsAccuracy:F1}m" : " | GPS: No signal";

            RunOnUiThread(() =>
            {
                if (_statusText != null)
                    _statusText.Text = btStatus + gpsStatus;
            });
        }

        private void CreateDataRecordingUI()
        {
            var scrollView = new ScrollView(this);
            var layout = new LinearLayout(this)
            {
                Orientation = Orientation.Vertical
            };
            layout.SetPadding(30, 100, 30, 30);

            // Connection status
            _statusText = new TextView(this)
            {
                Text = "Connecting to HR5... | GPS: No signal",
                TextSize = 16
            };
            layout.AddView(_statusText);

            // Button section (Clear Box and Save Data)
            var topButtonLayout = CreateHorizontalButtonLayout(
                ("Clear all box data", OnClearBoxClick),
                ("Save all data to file", OnSaveDataClick)
            );
            layout.AddView(topButtonLayout);

            // Box navigation section - all consistently styled
            var boxNavLayout = new LinearLayout(this)
            {
                Orientation = Orientation.Horizontal
            };

            _prevBoxButton = CreateUniformNavigationButton("← Prev", OnPrevBoxClick);
            _nextBoxButton = CreateUniformNavigationButton("Next →", OnNextBoxClick);
            
            // Create box number as a button-styled TextView to match others
            _boxNumberText = new TextView(this)
            {
                Text = "Box 1",
                TextSize = 18, // Reduced from 32 to match button text size
                Gravity = Android.Views.GravityFlags.Center,
                LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 2),
                Clickable = true,
                Focusable = true
            };
            _boxNumberText.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            _boxNumberText.SetBackgroundResource(Android.Resource.Drawable.ButtonDefault);
            _boxNumberText.SetPadding(20, 20, 20, 20); // Add padding to match button appearance
            _boxNumberText.Click += OnBoxNumberClick;

            boxNavLayout.AddView(_prevBoxButton);
            boxNavLayout.AddView(_boxNumberText);
            boxNavLayout.AddView(_nextBoxButton);
            layout.AddView(boxNavLayout);

            // Scanned IDs section
            var idsLabel = new TextView(this)
            {
                Text = "Scanned Bird IDs:",
                TextSize = 16
            };
            idsLabel.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            layout.AddView(idsLabel);

            _scannedIdsText = new TextView(this)
            {
                Text = "No birds scanned yet",
                TextSize = 14
            };
            _scannedIdsText.SetBackgroundColor(Android.Graphics.Color.LightGray);
            _scannedIdsText.SetPadding(10, 10, 10, 10);
            layout.AddView(_scannedIdsText);

            // Data entry fields
            CreateDataEntryFields(layout);

            scrollView.AddView(layout);
            SetContentView(scrollView);

            UpdateUI();
        }

        private Button CreateUniformNavigationButton(string text, EventHandler handler)
        {
            var button = new Button(this)
            {
                Text = text,
                TextSize = 18, // Consistent text size
                LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1)
            };
            button.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            button.Click += handler;
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
                button.Click += handler;
                layout.AddView(button);
                
                if (text.Contains("Clear"))
                    _clearBoxButton = button;
            }

            return layout;
        }

        private void CreateDataEntryFields(LinearLayout layout)
        {
            // Create headings row
            var headingsLayout = new LinearLayout(this)
            {
                Orientation = Orientation.Horizontal
            };
            
            var adultsLabel = new TextView(this) 
            { 
                Text = "Adults", 
                TextSize = 16,
                Gravity = GravityFlags.Center,
                LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1)
            };
            adultsLabel.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            
            var eggsLabel = new TextView(this) 
            { 
                Text = "Eggs", 
                TextSize = 16,
                Gravity = GravityFlags.Center,
                LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1)
            };
            eggsLabel.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            
            var chicksLabel = new TextView(this) 
            { 
                Text = "Chicks", 
                TextSize = 16,
                Gravity = GravityFlags.Center,
                LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1)
            };
            chicksLabel.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            
            headingsLayout.AddView(adultsLabel);
            headingsLayout.AddView(eggsLabel);
            headingsLayout.AddView(chicksLabel);
            layout.AddView(headingsLayout);
            
            // Create input fields row
            var inputFieldsLayout = new LinearLayout(this)
            {
                Orientation = Orientation.Horizontal
            };
            
            _adultsEditText = CreateInlineNumberField();
            _eggsEditText = CreateInlineNumberField();
            _chicksEditText = CreateInlineNumberField();
            
            inputFieldsLayout.AddView(_adultsEditText);
            inputFieldsLayout.AddView(_eggsEditText);
            inputFieldsLayout.AddView(_chicksEditText);
            layout.AddView(inputFieldsLayout);
            
            // Notes field (unchanged)
            var notesLabel = new TextView(this) { Text = "Notes:", TextSize = 16 };
            layout.AddView(notesLabel);
            _notesEditText = new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassText | Android.Text.InputTypes.TextFlagMultiLine | Android.Text.InputTypes.TextFlagCapSentences,
                Hint = "Enter any additional notes...",
                Gravity = Android.Views.GravityFlags.Top | Android.Views.GravityFlags.Start
            };
            _notesEditText.SetLines(3);
            _notesEditText.TextChanged += OnDataChanged;
            layout.AddView(_notesEditText);
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
            
            // Add some margin between fields for better spacing
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
                "Are you sure you want to clear data for all boxes!?",
                ("Yes", () =>
                {
                    _boxDataStorage.Clear();
                    _currentBox = 1;
                    LoadBoxData();
                    ClearInternalStorageData();
                    UpdateUI();
                }),
                ("Nope", () => { })
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
            ShowConfirmationDialog(
                "Save All Data",
                $"Are you sure you want to save all collected data? This includes data from {_boxDataStorage.Count} boxes.",
                ("Save", SaveAllData),
                ("Cancel", () => { })
            );
        }

        private void ShowConfirmationDialog(string title, string message, (string text, Action action) positiveButton, (string text, Action action) negativeButton)
        {
            var alertDialog = new AlertDialog.Builder(this)
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

            // Auto-save to disk whenever data is saved to memory
            SaveDataToInternalStorage();
        }

        private void LoadBoxData()
        {
            var editTexts = new[] { _adultsEditText, _eggsEditText, _chicksEditText, _notesEditText };
            
            // Temporarily remove event handlers
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

            // Re-attach event handlers
            foreach (var editText in editTexts)
            {
                if (editText != null) editText.TextChanged += OnDataChanged;
            }
        }

        private void ClearCurrentBoxData()
        {
            _boxDataStorage.Remove(_currentBox);
            LoadBoxData();
        }

        private void UpdateUI()
        {
            if (_boxNumberText != null) _boxNumberText.Text = $"Box {_currentBox}";
            if (_prevBoxButton != null) _prevBoxButton.Enabled = _currentBox > 1;
            if (_nextBoxButton != null) _nextBoxButton.Enabled = _currentBox < 150;
        }

        private void UpdateScannedIdsDisplay(List<ScanRecord> scans)
        {
            if (_scannedIdsText == null) return;

            if (scans.Count == 0)
            {
                _scannedIdsText.Text = "No birds scanned yet";
            }
            else
            {
                var displayText = $"Scanned IDs ({scans.Count}):\n";
                foreach (var scan in scans)
                {
                    var timeStr = scan.Timestamp.ToString("f");
                    displayText += $"{scan.BirdId} at {timeStr}\n";
                }
                _scannedIdsText.Text = displayText.TrimEnd('\n');
            }
        }

        private void AddScannedId(string fullEid)
        {
            var cleanEid = new string(fullEid.Where(char.IsLetterOrDigit).ToArray());
            var shortId = cleanEid.Length >= 8 ? cleanEid.Substring(cleanEid.Length - 8) : cleanEid;

            if (!_boxDataStorage.ContainsKey(_currentBox))
                _boxDataStorage[_currentBox] = new BoxData();

            var boxData = _boxDataStorage[_currentBox];

            // Check if this ID is already scanned in this box
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

                // Auto-save to disk after modifying data in memory
                SaveDataToInternalStorage();

                RunOnUiThread(() =>
                {
                    UpdateScannedIdsDisplay(boxData.ScannedIds);
                    Toast.MakeText(this, $"Bird ID {shortId} added to Box {_currentBox}", ToastLength.Short)?.Show();
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
                var filePath = Path.Combine(internalPath, AUTO_SAVE_FILENAME);
                
                File.WriteAllText(filePath, json);
            }
            catch (Exception ex)
            {
                // Log error but don't show toast to avoid interrupting user workflow
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

                var filePath = Path.Combine(internalPath, AUTO_SAVE_FILENAME);
                
                if (File.Exists(filePath))
                {
                    var json = File.ReadAllText(filePath);
                    var appState = JsonSerializer.Deserialize<AppDataState>(json);
                    
                    if (appState != null)
                    {
                        _currentBox = appState.CurrentBox;
                        _boxDataStorage = appState.BoxData ?? new Dictionary<int, BoxData>();
                        
                        Toast.MakeText(this, $"Restored data from {appState.LastSaved:MMM dd, HH:mm} - {_boxDataStorage.Count} boxes", ToastLength.Short)?.Show();
                    }
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to load auto-saved data: {ex.Message}");
                // Reset to defaults if loading fails
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
                    var filePath = Path.Combine(internalPath, AUTO_SAVE_FILENAME);
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
                // Create export data structure
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

                // Convert to JSON
                var json = JsonSerializer.Serialize(exportData, new JsonSerializerOptions { WriteIndented = true });

                // Get Downloads directory path
                var downloadsPath = Android.OS.Environment.GetExternalStoragePublicDirectory(Android.OS.Environment.DirectoryDownloads)?.AbsolutePath;
                
                if (string.IsNullOrEmpty(downloadsPath))
                {
                    Toast.MakeText(this, "Downloads directory not accessible", ToastLength.Long)?.Show();
                    return;
                }

                // Create filename with specified format: PenguinMonitoring YYMMdd HHmmss.json
                var now = DateTime.Now;
                var fileName = $"PenguinMonitoring {now:yyMMdd HHmmss}.json";
                var filePath = Path.Combine(downloadsPath, fileName);

                // Save JSON file
                File.WriteAllText(filePath, json);

                var totalBoxes = _boxDataStorage.Count;
                var totalBirds = _boxDataStorage.Values.Sum(box => box.ScannedIds.Count);

                Toast.MakeText(this, $"Data saved successfully!\nFile: {fileName}\nBoxes: {totalBoxes}, Birds: {totalBirds}", ToastLength.Long)?.Show();

                // Note: Data is NOT cleared after saving - it remains available for continued use
            }
            catch (Exception ex)
            {
                Toast.MakeText(this, $"Export failed: {ex.Message}", ToastLength.Long)?.Show();
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
            // Create a custom view for the dialog
            var dialogView = new LinearLayout(this)
            {
                Orientation = Orientation.Vertical
            };
            dialogView.SetPadding(20, 20, 20, 20);

            // Add instruction text
            var instructionText = new TextView(this)
            {
                Text = "Enter box number (1-150):",
                TextSize = 16
            };
            dialogView.AddView(instructionText);

            // Add input field
            var boxNumberInput = new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassNumber,
                Text = _currentBox.ToString(),
                Hint = "Box number"
            };
            dialogView.AddView(boxNumberInput);

            // Create and show dialog using an explicit light theme
            var alertDialog = new AlertDialog.Builder(this, Android.Resource.Style.ThemeDeviceDefaultLightDialogAlert)
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
                .SetNegativeButton("Stay", (s, e) => { })
                .Create();

            // Use the ShowEvent to handle actions after the dialog is displayed
            alertDialog.ShowEvent += (sender, args) =>
            {
                // Request focus on the input field
                boxNumberInput.RequestFocus();
                
                // Select all text for easy replacement
                boxNumberInput.SelectAll();

                // Force the soft keyboard to appear
                var inputMethodManager = (Android.Views.InputMethods.InputMethodManager?)GetSystemService(InputMethodService);
                inputMethodManager?.ShowSoftInput(boxNumberInput, Android.Views.InputMethods.ShowFlags.Implicit);
            };

            // Show the dialog
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
            
            Toast.MakeText(this, $"Jumped to Box {_currentBox}", ToastLength.Short)?.Show();
        }

        protected override void OnDestroy()
        {
            // Dispose Bluetooth manager
            _bluetoothManager?.Dispose();

            // Unsubscribe from event handlers to prevent memory leaks
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
            if (_clearBoxButton != null) _clearBoxButton.Click -= OnClearBoxClick;
            if (_boxNumberText != null) _boxNumberText.Click -= OnBoxNumberClick; // Add this line
    
            _locationManager?.RemoveUpdates(this);
            
            base.OnDestroy();
        }
    }
}