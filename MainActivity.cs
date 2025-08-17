using System;
using System.Text;
using System.Threading.Tasks;
using Android.App;
using Android.OS;
using Android.Widget;
using Java.Util;
using Android.Bluetooth;
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
        // Bluetooth components
        private BluetoothSocket? _bluetoothSocket;
        private Stream? _inputStream;
        private Stream? _outputStream;
        private bool _isConnected = false;
        private const string READER_BLUETOOTH_ADDRESS = "00:07:80:E6:95:52";

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

        public void OnLocationChanged(Location location)
        {
            _currentLocation = location;
            _gpsAccuracy = location.Accuracy;
            UpdateStatusText();
        }

        public void OnStatusChanged(string? provider, Availability status, Bundle? extras) { }
        public void OnProviderEnabled(string provider) { }
        public void OnProviderDisabled(string provider) { }

        private void UpdateStatusText()
        {
            var bluetoothStatus = _isConnected ? "HR5 Connected - Ready to scan" : "Connecting to HR5...";
            var gpsStatus = _gpsAccuracy > 0 ? $" | GPS: ±{_gpsAccuracy:F1}m" : " | GPS: No signal";

            RunOnUiThread(() =>
            {
                if (_statusText != null)
                    _statusText.Text = bluetoothStatus + gpsStatus;
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
            var topButtonLayout = new LinearLayout(this)
            {
                Orientation = Orientation.Horizontal
            };

            _clearBoxButton = new Button(this)
            {
                Text = "Clear all box data",
                LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1)
            };
            _clearBoxButton.Click += OnClearBoxClick;

            var saveDataButton = new Button(this)
            {
                Text = "Save all data to file",
                LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1)
            };
            saveDataButton.Click += OnSaveDataClick;

            topButtonLayout.AddView(_clearBoxButton);
            topButtonLayout.AddView(saveDataButton);
            layout.AddView(topButtonLayout);

            // Box navigation section
            var boxNavLayout = new LinearLayout(this)
            {
                Orientation = Orientation.Horizontal
            };

            _prevBoxButton = new Button(this)
            {
                Text = "← Prev",
                LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1)
            };
            _prevBoxButton.Click += OnPrevBoxClick;

            _boxNumberText = new TextView(this)
            {
                Text = "Box 1",
                TextSize = 32,
                Gravity = Android.Views.GravityFlags.Center,
                LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 2)
            };
            _boxNumberText.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);

            _nextBoxButton = new Button(this)
            {
                Text = "Next →",
                LayoutParameters = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1)
            };
            _nextBoxButton.Click += OnNextBoxClick;

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

        private void CreateDataEntryFields(LinearLayout layout)
        {
            // Adults field
            var adultsLabel = new TextView(this) { Text = "Number of Adults:", TextSize = 16 };
            layout.AddView(adultsLabel);
            _adultsEditText = new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassNumber,
                Text = "0"
            };
            _adultsEditText.TextChanged += OnDataChanged;
            _adultsEditText.Click += OnNumberFieldClick;
            _adultsEditText.FocusChange += OnNumberFieldFocus;
            layout.AddView(_adultsEditText);

            // Eggs field
            var eggsLabel = new TextView(this) { Text = "Number of Eggs:", TextSize = 16 };
            layout.AddView(eggsLabel);
            _eggsEditText = new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassNumber,
                Text = "0"
            };
            _eggsEditText.TextChanged += OnDataChanged;
            _eggsEditText.Click += OnNumberFieldClick;
            _eggsEditText.FocusChange += OnNumberFieldFocus;
            layout.AddView(_eggsEditText);

            // Chicks field
            var chicksLabel = new TextView(this) { Text = "Number of Chicks:", TextSize = 16 };
            layout.AddView(chicksLabel);
            _chicksEditText = new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassNumber,
                Text = "0"
            };
            _chicksEditText.TextChanged += OnDataChanged;
            _chicksEditText.Click += OnNumberFieldClick;
            _chicksEditText.FocusChange += OnNumberFieldFocus;
            layout.AddView(_chicksEditText);

            // Notes field
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
            if (_currentBox > 1)
            {
                if (!_boxDataStorage.ContainsKey(_currentBox))
                {
                    var alertDialog = new AlertDialog.Builder(this)
                        .SetTitle("Empty Box Confirmation")
                        .SetMessage("Please confirm this box has been inspected and is empty")
                        .SetPositiveButton("Confirm Empty", (s, e) =>
                        {
                            SaveCurrentBoxData();
                            _currentBox--;
                            LoadBoxData();
                            UpdateUI();
                        })
                        .SetNegativeButton("Skip", (s, e) => 
                        {
                            _currentBox--;
                            LoadBoxData();
                            UpdateUI();
                        })
                        .Create();
                    alertDialog?.Show();
                }
                else
                {
                    SaveCurrentBoxData();
                    _currentBox--;
                    LoadBoxData();
                    UpdateUI();
                    SaveDataToInternalStorage(); // Auto-save after navigation
                }
            }
        }

        private void OnNextBoxClick(object? sender, EventArgs e)
        {
            if (_currentBox < 150)
            {
                if (!_boxDataStorage.ContainsKey(_currentBox))
                {
                    var alertDialog = new AlertDialog.Builder(this)
                        .SetTitle("Empty Box Confirmation")
                        .SetMessage("Please confirm this box has been inspected and is empty")
                        .SetPositiveButton("Confirm Empty", (s, e) =>
                        {
                            SaveCurrentBoxData();
                            _currentBox++;
                            LoadBoxData();
                            UpdateUI();
                        })
                        .SetNegativeButton("Skip", (s, e) => 
                        {
                            _currentBox++;
                            LoadBoxData();
                            UpdateUI();
                        })
                        .Create();
                    alertDialog?.Show();
                }
                else
                {
                    SaveCurrentBoxData();
                    _currentBox++;
                    LoadBoxData();
                    UpdateUI();
                    SaveDataToInternalStorage(); // Auto-save after navigation
                }
            }
        }

        private void OnClearBoxClick(object? sender, EventArgs e)
        {
            var alertDialog = new AlertDialog.Builder(this)
                .SetTitle("Clear Box Data")
                .SetMessage($"Are you sure you want to clear data for all Boxes!?")
                .SetPositiveButton("Yes", (s, e) =>
                {
                    // Clear all box data from memory
                    _boxDataStorage.Clear();
                    
                    // Reset to box 1
                    _currentBox = 1;
                    
                    // Load empty data for current box (which will clear UI fields)
                    LoadBoxData();

                    // Clear auto-save file as well
                    ClearInternalStorageData();

                    UpdateUI();                    
                })
                .SetNegativeButton("Nope", (s, e) => { })
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
            // Temporarily remove event handlers to prevent unwanted saves during loading
            if (_adultsEditText != null) _adultsEditText.TextChanged -= OnDataChanged;
            if (_eggsEditText != null) _eggsEditText.TextChanged -= OnDataChanged;
            if (_chicksEditText != null) _chicksEditText.TextChanged -= OnDataChanged;
            if (_notesEditText != null) _notesEditText.TextChanged -= OnDataChanged;

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

            // Re-attach event handlers after loading is complete
            if (_adultsEditText != null) _adultsEditText.TextChanged += OnDataChanged;
            if (_eggsEditText != null) _eggsEditText.TextChanged += OnDataChanged;
            if (_chicksEditText != null) _chicksEditText.TextChanged += OnDataChanged;
            if (_notesEditText != null) _notesEditText.TextChanged += OnDataChanged;
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
                    var timeStr = scan.Timestamp.ToString("HH:mm:ss");
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

        private void StartBluetoothConnection()
        {
            Task.Run(async () =>
            {
                await Task.Delay(3000);
                await ConnectToReaderBluetooth();
            });
        }

        private async Task ConnectToReaderBluetooth()
        {
            try
            {
                RunOnUiThread(() => UpdateStatusText());

                var bluetoothAdapter = BluetoothAdapter.DefaultAdapter;
                if (bluetoothAdapter?.IsEnabled != true)
                {
                    RunOnUiThread(() => {
                        if (_statusText != null) _statusText.Text = "Bluetooth not available";
                    });
                    return;
                }

                var device = bluetoothAdapter.GetRemoteDevice(READER_BLUETOOTH_ADDRESS);
                var uuid = UUID.FromString("00001101-0000-1000-8000-00805f9b34fb");
                _bluetoothSocket = device?.CreateRfcommSocketToServiceRecord(uuid);

                if (_bluetoothSocket != null)
                {
                    await Task.Run(() => _bluetoothSocket.Connect());
                    _inputStream = _bluetoothSocket.InputStream;
                    _isConnected = true;

                    RunOnUiThread(() => UpdateStatusText());
                    await ListenForEidData();
                }
            }
            catch (Exception ex)
            {
                RunOnUiThread(() => {
                    if (_statusText != null) _statusText.Text = $"Connection failed: {ex.Message}";
                });
            }
        }

        private async Task ListenForEidData()
        {
            var buffer = new byte[1024];
            var receivedData = new StringBuilder();

            try
            {
                while (_isConnected && _bluetoothSocket?.IsConnected == true && _inputStream != null)
                {
                    var bytesRead = await _inputStream.ReadAsync(buffer, 0, buffer.Length);

                    if (bytesRead > 0)
                    {
                        var data = Encoding.UTF8.GetString(buffer, 0, bytesRead);
                        receivedData.Append(data);

                        var completeData = receivedData.ToString();

                        if (completeData.Length >= 10)
                        {
                            var cleanData = new string(completeData.Where(c => char.IsLetterOrDigit(c)).ToArray());
                            if (cleanData.Length >= 10)
                            {
                                AddScannedId(cleanData);
                                receivedData.Clear();
                            }
                        }

                        if (receivedData.Length > 1000)
                        {
                            receivedData.Clear();
                        }
                    }

                    await Task.Delay(100);
                }
            }
            catch (Exception ex)
            {
                RunOnUiThread(() => {
                    if (_statusText != null) _statusText.Text = $"Scanning error: {ex.Message}";
                });
            }
        }

        private void OnSaveDataClick(object? sender, EventArgs e)
        {
            // Check if current box has been processed before saving
            if (!_boxDataStorage.ContainsKey(_currentBox))
            {
                var alertDialog = new AlertDialog.Builder(this)
                    .SetTitle("Empty Box Confirmation")
                    .SetMessage("Confirm this box has been inspected, and is empty")
                    .SetPositiveButton("Confirm Empty", (s, e) =>
                    {
                        SaveCurrentBoxData();
                        ShowSaveConfirmation();
                    })
                    .SetNegativeButton("Skip", (s, e) => { })
                    .Create();
                alertDialog?.Show();
            }
            else
            {
                SaveCurrentBoxData();
                ShowSaveConfirmation();
            }
        }

        private void ShowSaveConfirmation()
        {
            var alertDialog = new AlertDialog.Builder(this)
                .SetTitle("Save All Data")
                .SetMessage($"Are you sure you want to save all collected data? This includes data from {_boxDataStorage.Count} boxes.")
                .SetPositiveButton("Save", (s, e) =>
                {
                    SaveAllData();
                })
                .SetNegativeButton("Cancel", (s, e) => { })
                .Create();
            alertDialog?.Show();
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
                    StartBluetoothConnection();
                }
                else
                {
                    Toast.MakeText(this, "Required permissions not granted. App functionality will be limited.", ToastLength.Long)?.Show();
                }
            }
        }

        protected override void OnDestroy()
        {
            _isConnected = false;
    
            // Unsubscribe from event handlers to prevent memory leaks
            if (_adultsEditText != null) 
            {
                _adultsEditText.TextChanged -= OnDataChanged;
                _adultsEditText.Click -= OnNumberFieldClick;
                _adultsEditText.FocusChange -= OnNumberFieldFocus;
            }
            if (_eggsEditText != null) 
            {
                _eggsEditText.TextChanged -= OnDataChanged;
                _eggsEditText.Click -= OnNumberFieldClick;
                _eggsEditText.FocusChange -= OnNumberFieldFocus;
            }
            if (_chicksEditText != null) 
            {
                _chicksEditText.TextChanged -= OnDataChanged;
                _chicksEditText.Click -= OnNumberFieldClick;
                _chicksEditText.FocusChange -= OnNumberFieldFocus;
            }
            if (_notesEditText != null) 
            {
                _notesEditText.TextChanged -= OnDataChanged;
            }
            if (_prevBoxButton != null) _prevBoxButton.Click -= OnPrevBoxClick;
            if (_nextBoxButton != null) _nextBoxButton.Click -= OnNextBoxClick;
            if (_clearBoxButton != null) _clearBoxButton.Click -= OnClearBoxClick;
            
            _bluetoothSocket?.Close();
            _inputStream?.Dispose();
            _outputStream?.Dispose();
            _locationManager?.RemoveUpdates(this);
            
            base.OnDestroy();
        }
    }
}