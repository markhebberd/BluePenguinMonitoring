using Android;
using Android.App;
using Android.Content;
using Android.Graphics;
using Android.Graphics.Drawables;
using Android.Locations;
using Android.Media;
using Android.OS;
using Android.Text;
using Android.Views;
using Android.Widget;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Net.Http;
using System.Threading.Tasks;
using System.Text;

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

        // Add sex-based background colors
        private static readonly Color FEMALE_BACKGROUND = Color.ParseColor("#FFE4E1"); // Light pink
        private static readonly Color MALE_BACKGROUND = Color.ParseColor("#E6F3FF"); // Light blue
        private static readonly Color CHICK_BACKGROUND = Color.ParseColor("#FFFFE6");   // Light yellow

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
        private Spinner? _gateStatusSpinner;
        private EditText? _notesEditText;
        private Button? _prevBoxButton;
        private Button? _nextBoxButton;
        private Button? _clearBoxButton;
        private EditText? _manualScanEditText;

        // Add gesture detection components
        private GestureDetector? _gestureDetector;
        private LinearLayout? _dataCard;

        // HTTP client for CSV downloads
        private static readonly HttpClient _httpClient = new HttpClient();
        private const string GOOGLE_SHEETS_URL = "https://docs.google.com/spreadsheets/d/1A2j56iz0_VNHiWNJORAzGDqTbZsEd76j-YI_gQZsDEE/edit?usp=sharing";

        // Data storage
        private Dictionary<int, BoxData> _boxDataStorage = new Dictionary<int, BoxData>();
        private List<CsvRowData> _downloadedCsvData = new List<CsvRowData>();
        private Dictionary<string, PenguinData> _remotePenguinData = new Dictionary<string, PenguinData>();

        private int _currentBox = 1;
        private const string AUTO_SAVE_FILENAME = "penguin_data_autosave.json";
        private const string REMOTE_BIRD_DATA_FILENAME = "remotePenguinData.json";

        // High value confirmation tracking - reset on each entry
        private bool _isProcessingConfirmation = false;

        // Vibration and sound components
        private Vibrator? _vibrator;
        private MediaPlayer? _alertMediaPlayer;

        // Data model classes
        public class BoxData
        {
            public List<ScanRecord> ScannedIds { get; set; } = new List<ScanRecord>();
            public int Adults { get; set; } = 0;
            public int Eggs { get; set; } = 0;
            public int Chicks { get; set; } = 0;
            public string? GateStatus { get; set; } = null; 
            public string Notes { get; set; } = "";
        }
        private class SwipeGestureDetector : GestureDetector.SimpleOnGestureListener
        {
            private readonly MainActivity _activity;
            private const int SWIPE_THRESHOLD = 100;
            private const int SWIPE_VELOCITY_THRESHOLD = 100;

            public SwipeGestureDetector(MainActivity activity)
            {
                _activity = activity;
            }

            public override bool OnFling(MotionEvent? e1, MotionEvent e2, float velocityX, float velocityY)
            {
                if (e1 == null || e2 == null) return false;

                float diffX = e2.GetX() - e1.GetX();
                float diffY = e2.GetY() - e1.GetY();

                // Check if it's a horizontal swipe (not vertical)
                if (Math.Abs(diffX) > Math.Abs(diffY))
                {
                    // Check if swipe distance and velocity are sufficient
                    if (Math.Abs(diffX) > SWIPE_THRESHOLD && Math.Abs(velocityX) > SWIPE_VELOCITY_THRESHOLD)
                    {
                        if (diffX > 0)
                        {
                            // Swipe right → Previous box
                            _activity.OnSwipePrevious();
                        }
                        else
                        {
                            // Swipe left → Next box
                            _activity.OnSwipeNext();
                        }
                        return true;
                    }
                }
                return false;
            }
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

        public class CsvRowData
        {
            public string Number { get; set; } = "";
            public string ScannedId { get; set; } = "";
            public string ChipDate { get; set; } = "";
            public string Sex { get; set; } = "";
            public string VidForScanner { get; set; } = "";
            public string PlusBoxes { get; set; } = "";
            public string ChipBox { get; set; } = "";
            public string BreedBox2021 { get; set; } = "";
            public string BreedBox2022 { get; set; } = "";
            public string BreedBox2023 { get; set; } = "";
            public string BreedBox2024 { get; set; } = "";
            public string BreedBox2025 { get; set; } = "";
            public string LastKnownLifeStage { get; set; } = "";
            public string NestSuccess2021 { get; set; } = "";
            public string ReClutch21 { get; set; } = "";
            public string NestSuccess2022 { get; set; } = "";
            public string ReClutch22 { get; set; } = "";
            public string NestSuccess2023 { get; set; } = "";
            public string ReClutch23 { get; set; } = "";
            public string NestSuccess2024 { get; set; } = "";
            public string ReClutch24 { get; set; } = "";
            public string ChipBy { get; set; } = "";
            public string ChipAs { get; set; } = "";
            public string ChipOk { get; set; } = "";
            public string ChipWeight { get; set; } = "";
            public string FlipperLength { get; set; } = "";
            public string Persistence { get; set; } = "";
            public string AlarmsScanner { get; set; } = "";
            public string WasSingle { get; set; } = "";
            public string ChickSizeSex { get; set; } = "";
            public string ChickReturnDate { get; set; } = "";
            public string ReChip { get; set; } = "";
            public string ReChipBy { get; set; } = "";
            public string ActiveChip2 { get; set; } = "";
            public string RechipDate { get; set; } = "";
            public string FullIso15Digits { get; set; } = "";
            public string Solo { get; set; } = "";
            public string Kommentar { get; set; } = "";
        }

        public enum LifeStage
        {
            Adult,
            Chick,
            Returnee
        }

        public class PenguinData
        {
            public string ScannedId { get; set; } = "";
            public LifeStage LastKnownLifeStage { get; set; }
            public string Sex { get; set; } = "";
            public string VidForScanner { get; set; } = "";
        }

        // Add a field for the data card title so it can be updated dynamically
        private TextView? _dataCardTitle;
        private void OnSwipePrevious()
        {
            if (_currentBox > 1)
            {
                NavigateToBox(_currentBox - 1, () => _currentBox > 1);
            }
            else
            {
                Toast.MakeText(this, "Already at first box", ToastLength.Short)?.Show();
            }
        }

        private void OnSwipeNext()
        {
            if (_currentBox < 150)
            {
                NavigateToBox(_currentBox + 1, () => _currentBox < 150);
            }
            else
            {
                Toast.MakeText(this, "Already at last box", ToastLength.Short)?.Show();
            }
        }
        protected override void OnCreate(Bundle? savedInstanceState)
        {
            base.OnCreate(savedInstanceState);

            RequestPermissions();
            LoadDataFromInternalStorage();
            CreateDataRecordingUI();
            LoadBoxData();
            InitializeVibrationAndSound();
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
                Android.Manifest.Permission.AccessCoarseLocation,
                Android.Manifest.Permission.Internet // Add internet permission for CSV download
            });

            if (Android.OS.Build.VERSION.SdkInt >= Android.OS.BuildVersionCodes.M)
            {
                RequestPermissions(permissions.ToArray(), 1);
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
                    _alertMediaPlayer = MediaPlayer.Create(this, notificationUri);
                    _alertMediaPlayer?.SetAudioAttributes(
                        new AudioAttributes.Builder()
                            .SetUsage(AudioUsageKind.Alarm)
                            .SetContentType(AudioContentType.Sonification)
                            .Build()
                    );
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
            _ = _bluetoothManager.StartConnectionAsync();
        }

        private void OnBluetoothStatusChanged(string status)
        {
            RunOnUiThread(() => UpdateStatusText(status));
        }

        private void OnEidDataReceived(string eidData)
        {
            AddScannedId(eidData);
        }

        // ILocationListener implementation
        public void OnLocationChanged(Location location)
        {
            _currentLocation = location;
            _gpsAccuracy = location.Accuracy;
            UpdateStatusText();
        }

        public void OnProviderDisabled(string provider)
        {
            // Handle provider disabled
        }

        public void OnProviderEnabled(string provider)
        {
            // Handle provider enabled
        }

        public void OnStatusChanged(string? provider, Availability status, Bundle? extras)
        {
            // Handle status change
        }

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
        private void LoadJsonDataFromFile()
        {
            try
            {
                var downloadsPath = Android.OS.Environment.GetExternalStoragePublicDirectory(Android.OS.Environment.DirectoryDownloads)?.AbsolutePath;

                if (string.IsNullOrEmpty(downloadsPath))
                {
                    Toast.MakeText(this, "Downloads directory not accessible", ToastLength.Long)?.Show();
                    return;
                }

                // Look for the most recent penguin monitoring JSON file
                var files = Directory.GetFiles(downloadsPath, "PenguinMonitoring *.json")
                    .OrderByDescending(f => File.GetCreationTime(f))
                    .ToArray();

                if (files.Length == 0)
                {
                    Toast.MakeText(this, "No penguin monitoring JSON files found in Downloads", ToastLength.Long)?.Show();
                    return;
                }

                // Show file selection dialog
                ShowFileSelectionDialog(files);
            }
            catch (Exception ex)
            {
                Toast.MakeText(this, $"❌ Failed to browse files: {ex.Message}", ToastLength.Long)?.Show();
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
                
                ShowConfirmationDialog(
                    "Load JSON Data",
                    $"Load data from:\n{fileName}\n\nThis will replace current box data.",
                    ("Load", () => LoadJsonFileData(selectedFile)),
                    ("Cancel", () => { })
                );
            });

            builder.SetNegativeButton("Cancel", (sender, args) => { });
            
            var dialog = builder.Create();
            dialog?.Show();
        }
        private void LoadJsonFileData(string filePath)
        {
            try
            {
                var json = File.ReadAllText(filePath);
                var loadedData = JsonSerializer.Deserialize<JsonNode>(json);

                if (loadedData == null)
                {
                    Toast.MakeText(this, "❌ Invalid JSON file format", ToastLength.Long)?.Show();
                    return;
                }

                // Extract box data from the JSON structure
                var boxesNode = loadedData["Boxes"];
                if (boxesNode == null)
                {
                    Toast.MakeText(this, "❌ No box data found in JSON file", ToastLength.Long)?.Show();
                    return;
                }

                var newBoxDataStorage = new Dictionary<int, BoxData>();
                int boxCount = 0;
                int birdCount = 0;

                foreach (var boxItem in boxesNode.AsArray())
                {
                    var boxNumber = boxItem?["BoxNumber"]?.GetValue<int>() ?? 0;
                    var dataNode = boxItem?["Data"];

                    if (boxNumber > 0 && dataNode != null)
                    {
                        var boxData = new BoxData
                        {
                            Adults = dataNode["Adults"]?.GetValue<int>() ?? 0,
                            Eggs = dataNode["Eggs"]?.GetValue<int>() ?? 0,
                            Chicks = dataNode["Chicks"]?.GetValue<int>() ?? 0,
                            GateStatus = dataNode["GateStatus"]?.GetValue<string>(),
                            Notes = dataNode["Notes"]?.GetValue<string>() ?? ""
                        };

                        // Load scanned IDs
                        var scannedIdsNode = dataNode["ScannedIds"];
                        if (scannedIdsNode != null)
                        {
                            foreach (var scanItem in scannedIdsNode.AsArray())
                            {
                                var scanRecord = new ScanRecord
                                {
                                    BirdId = scanItem?["BirdId"]?.GetValue<string>() ?? "",
                                    Timestamp = scanItem?["Timestamp"]?.GetValue<DateTime>() ?? DateTime.Now,
                                    Latitude = scanItem?["Latitude"]?.GetValue<double>() ?? 0,
                                    Longitude = scanItem?["Longitude"]?.GetValue<double>() ?? 0,
                                    Accuracy = scanItem?["Accuracy"]?.GetValue<float>() ?? -1
                                };

                                boxData.ScannedIds.Add(scanRecord);
                                birdCount++;
                            }
                        }

                        newBoxDataStorage[boxNumber] = boxData;
                        boxCount++;
                    }
                }

                // Replace current data with loaded data
                _boxDataStorage = newBoxDataStorage;

                // Update current box if it exists in loaded data, otherwise go to first box
                if (!_boxDataStorage.ContainsKey(_currentBox))
                {
                    _currentBox = _boxDataStorage.Keys.Any() ? _boxDataStorage.Keys.Min() : 1;
                }

                // Refresh UI
                LoadBoxData();
                UpdateUI();
                SaveDataToInternalStorage(); // Auto-save the loaded data

                var fileName = System.IO.Path.GetFileName(filePath);
                Toast.MakeText(this, $"✅ Loaded {boxCount} boxes, {birdCount} birds\nFrom: {fileName}", ToastLength.Long)?.Show();
            }
            catch (Exception ex)
            {
                Toast.MakeText(this, $"❌ Failed to load JSON: {ex.Message}", ToastLength.Long)?.Show();
            }
        }

        private void ShowBoxDataSummary()
        {
            if (_boxDataStorage.Count == 0)
            {
                Toast.MakeText(this, "No box data to display", ToastLength.Short)?.Show();
                return;
            }

            var totalBirds = _boxDataStorage.Values.Sum(box => box.ScannedIds.Count);
            var totalAdults = _boxDataStorage.Values.Sum(box => box.Adults);
            var totalEggs = _boxDataStorage.Values.Sum(box => box.Eggs);
            var totalChicks = _boxDataStorage.Values.Sum(box => box.Chicks);
            var gateUpCount = _boxDataStorage.Values.Count(box => box.GateStatus == "gate up");
            var regateCount = _boxDataStorage.Values.Count(box => box.GateStatus == "regate");

            var summary = $"📊 Data Summary:\n\n" +
                         $"📦 {_boxDataStorage.Count} boxes with data\n" +
                         $"🐧 {totalBirds} bird scans\n" +
                         $"👥 {totalAdults} adults\n" +
                         $"🥚 {totalEggs} eggs\n" +
                         $"🐣 {totalChicks} chicks\n" +
                         $"🚪 Gate: {gateUpCount} up, {regateCount} regate\n\n" +
                         $"Box range: {(_boxDataStorage.Keys.Any() ? _boxDataStorage.Keys.Min() : 0)} - {(_boxDataStorage.Keys.Any() ? _boxDataStorage.Keys.Max() : 0)}";

            ShowConfirmationDialog(
                "Box Data Summary",
                summary,
                ("OK", () => { }
            ),
                ("Load JSON", LoadJsonDataFromFile)
            );
        }
        private string ConvertToGoogleSheetsCsvUrl(string shareUrl)
        {
            // Extract the spreadsheet ID from the sharing URL
            var uri = new Uri(shareUrl);
            var pathSegments = uri.AbsolutePath.Split('/');
            var spreadsheetId = "";
            
            for (int i = 0; i < pathSegments.Length; i++)
            {
                if (pathSegments[i] == "d" && i + 1 < pathSegments.Length)
                {
                    spreadsheetId = pathSegments[i + 1];
                    break;
                }
            }

            if (string.IsNullOrEmpty(spreadsheetId))
            {
                throw new ArgumentException("Could not extract spreadsheet ID from URL");
            }

            // Return the CSV export URL
            return $"https://docs.google.com/spreadsheets/d/{spreadsheetId}/export?format=csv";
        }
        private async Task DownloadCsvDataAsync()
        {
            try
            {
                var csvUrl = ConvertToGoogleSheetsCsvUrl(GOOGLE_SHEETS_URL);

                RunOnUiThread(() =>
                {
                    Toast.MakeText(this, "📥 Downloading CSV data...", ToastLength.Short)?.Show();
                });

                var response = await _httpClient.GetAsync(csvUrl);
                response.EnsureSuccessStatusCode();

                var csvContent = await response.Content.ReadAsStringAsync();
                var parsedData = ParseCsvData(csvContent);

                _downloadedCsvData = parsedData;

                // Populate the penguin data dictionary
                _remotePenguinData.Clear();
                foreach (var row in parsedData)
                {
                    if (!string.IsNullOrEmpty(row.ScannedId) && row.ScannedId.Length >= 8)
                    {
                        // Extract the 8-digit ID (take last 8 characters to match scanning behavior)
                        var cleanId = new string(row.ScannedId.Where(char.IsLetterOrDigit).ToArray());
                        var eightDigitId = cleanId.Length >= 8 ? cleanId.Substring(cleanId.Length - 8).ToUpper() : cleanId.ToUpper();

                        if (eightDigitId.Length == 8)
                        {
                            // Parse life stage
                            var lifeStage = LifeStage.Adult; // Default
                            if (!string.IsNullOrEmpty(row.LastKnownLifeStage))
                            {
                                if (Enum.TryParse<LifeStage>(row.LastKnownLifeStage, true, out var parsedLifeStage))
                                {
                                    lifeStage = parsedLifeStage;
                                }
                            }

                            var penguinData = new PenguinData
                            {
                                ScannedId = eightDigitId,
                                LastKnownLifeStage = lifeStage,
                                Sex = row.Sex ?? "",
                                VidForScanner = row.VidForScanner ?? ""
                            };

                            _remotePenguinData[eightDigitId] = penguinData;
                        }
                    }
                }

                // Save the remote penguin data to internal storage
                SaveRemotePenguinDataToInternalStorage();

                RunOnUiThread(() =>
                {
                    Toast.MakeText(this, $"✅ Downloaded {parsedData.Count} rows, {_remotePenguinData.Count} penguin records", ToastLength.Short)?.Show();
                });
            }
            catch (Exception ex)
            {
                RunOnUiThread(() =>
                {
                    Toast.MakeText(this, $"❌ Download failed: {ex.Message}", ToastLength.Long)?.Show();
                });
            }
        }
        private List<CsvRowData> ParseCsvData(string csvContent)
        {
            var result = new List<CsvRowData>();

            try
            {
                var lines = csvContent.Split('\n', StringSplitOptions.RemoveEmptyEntries);

                if (lines.Length <= 1)
                {
                    return result; // No data rows
                }

                // Skip header row (first line)
                for (int i = 1; i < lines.Length; i++)
                {
                    var line = lines[i].Trim();
                    if (string.IsNullOrEmpty(line))
                        continue;

                    var columns = ParseCsvLine(line);

                    // Ensure we have enough columns (should have 36 based on header)
                    while (columns.Count < 36)
                    {
                        columns.Add("");
                    }

                    var csvRow = new CsvRowData
                    {
                        Number = columns[0],
                        ScannedId = columns[1],
                        ChipDate = columns[2],
                        Sex = columns[3],
                        VidForScanner = columns[4],
                        PlusBoxes = columns[5],
                        ChipBox = columns[6],
                        BreedBox2021 = columns[7],
                        BreedBox2022 = columns[8],
                        BreedBox2023 = columns[9],
                        BreedBox2024 = columns[10],
                        BreedBox2025 = columns[11],
                        LastKnownLifeStage = columns[12],
                        NestSuccess2021 = columns[13],
                        ReClutch21 = columns[14],
                        NestSuccess2022 = columns[15],
                        ReClutch22 = columns[16],
                        NestSuccess2023 = columns[17],
                        ReClutch23 = columns[18],
                        NestSuccess2024 = columns[19],
                        ReClutch24 = columns[20],
                        ChipBy = columns[21],
                        ChipAs = columns[22],
                        ChipOk = columns[23],
                        ChipWeight = columns[24],
                        FlipperLength = columns[25],
                        Persistence = columns[26],
                        AlarmsScanner = columns[27],
                        WasSingle = columns[28],
                        ChickSizeSex = columns[29],
                        ChickReturnDate = columns[30],
                        ReChip = columns[31],
                        ReChipBy = columns[32],
                        ActiveChip2 = columns[33],
                        RechipDate = columns[34],
                        FullIso15Digits = columns[35],
                        Solo = columns.Count > 36 ? columns[36] : "",
                        Kommentar = columns.Count > 37 ? columns[37] : ""
                    };

                    result.Add(csvRow);
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"CSV parsing error: {ex.Message}");
            }

            return result;
        }

        private List<string> ParseCsvLine(string line)
        {
            var result = new List<string>();
            var currentField = new StringBuilder();
            var inQuotes = false;

            for (int i = 0; i < line.Length; i++)
            {
                var c = line[i];

                if (c == '"')
                {
                    if (inQuotes && i + 1 < line.Length && line[i + 1] == '"')
                    {
                        // Escaped quote
                        currentField.Append('"');
                        i++; // Skip next quote
                    }
                    else
                    {
                        inQuotes = !inQuotes;
                    }
                }
                else if (c == ',' && !inQuotes)
                {
                    result.Add(currentField.ToString());
                    currentField.Clear();
                }
                else
                {
                    currentField.Append(c);
                }
            }

            result.Add(currentField.ToString());
            return result;
        }
        private void OnDownloadCsvClick(object? sender, EventArgs e)
        {
            _ = Task.Run(async () => await DownloadCsvDataAsync());
        }
        private void SaveRemotePenguinDataToInternalStorage()
        {
            try
            {
                var internalPath = FilesDir?.AbsolutePath;
                if (string.IsNullOrEmpty(internalPath))
                    return;

                var json = JsonSerializer.Serialize(_remotePenguinData, new JsonSerializerOptions { WriteIndented = true });
                var filePath = System.IO.Path.Combine(internalPath, REMOTE_BIRD_DATA_FILENAME);

                File.WriteAllText(filePath, json);

                RunOnUiThread(() =>
                {
                    Toast.MakeText(this, $"💾 Bird stats saved! ({_remotePenguinData.Count} records)", ToastLength.Short)?.Show();
                });
            }
            catch (Exception ex)
            {
                RunOnUiThread(() =>
                {
                    Toast.MakeText(this, $"❌ Failed to save bird stats: {ex.Message}", ToastLength.Long)?.Show();
                });
            }
        }
        private void CreateDataRecordingUI()
        {
            var scrollView = new ScrollView(this);
            scrollView.SetBackgroundColor(BACKGROUND_COLOR);

            // Initialize gesture detector and apply to ScrollView
            _gestureDetector = new GestureDetector(this, new SwipeGestureDetector(this));
            scrollView.Touch += OnScrollViewTouch;

            var layout = new LinearLayout(this)
            {
                Orientation = Android.Widget.Orientation.Vertical
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
                ("Bird Stats", OnDownloadCsvClick, PRIMARY_DARK),
                ("Data", OnDataClick, SUCCESS_COLOR)
            );
            topButtonLayout.LayoutParameters = statusParams;
            headerCard.AddView(topButtonLayout);

            // Navigation card
            var boxNavLayout = CreateNavigationLayout();
            boxNavLayout.LayoutParameters = statusParams;
            headerCard.AddView(boxNavLayout);

            // Data card (remove gesture detection from here)
            _dataCard = CreateCard();
            CreateBoxDataCard(_dataCard);

            layout.AddView(_dataCard);
            scrollView.AddView(layout);
            SetContentView(scrollView);

            scrollView.SetOnApplyWindowInsetsListener(new ViewInsetsListener());
        }
        private void OnScrollViewTouch(object? sender, View.TouchEventArgs e)
        {
            if (_gestureDetector != null && e.Event != null)
            {
                _gestureDetector.OnTouchEvent(e.Event);
            }
            e.Handled = false; // Allow scrolling to continue
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
                Orientation = Android.Widget.Orientation.Vertical
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
                Orientation = Android.Widget.Orientation.Horizontal
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
                Orientation = Android.Widget.Orientation.Horizontal
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
                Gravity = GravityFlags.CenterHorizontal
            };
            _dataCardTitle.SetTextColor(TEXT_PRIMARY);
            _dataCardTitle.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            var dataTitleParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            dataTitleParams.SetMargins(0, 0, 0, 16);
            _dataCardTitle.LayoutParameters = dataTitleParams;
            layout.AddView(_dataCardTitle);

            // Scanned birds container
            _scannedIdsContainer = new LinearLayout(this)
            {
                Orientation = Android.Widget.Orientation.Vertical
            };
            _scannedIdsContainer.SetPadding(16, 16, 16, 16);
            _scannedIdsContainer.Background = CreateRoundedBackground(TEXT_FIELD_BACKGROUND_COLOR, 8);
            var idsParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            idsParams.SetMargins(0, 0, 0, 16);
            _scannedIdsContainer.LayoutParameters = idsParams;
            layout.AddView(_scannedIdsContainer);

            // Headings row: Adults, Eggs, Chicks, Gate Status
            var headingsLayout = new LinearLayout(this)
            {
                Orientation = Android.Widget.Orientation.Horizontal
            };
            var headingsParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            headingsParams.SetMargins(0, 0, 0, 8);
            headingsLayout.LayoutParameters = headingsParams;

            var adultsLabel = CreateDataLabel("Adults");
            var eggsLabel = CreateDataLabel("Eggs");
            var chicksLabel = CreateDataLabel("Chicks");
            var gateLabel = CreateDataLabel("Gate Status");
// ------------ ^ Added Gate Status label ------------ //

            headingsLayout.AddView(adultsLabel);
            headingsLayout.AddView(eggsLabel);
            headingsLayout.AddView(chicksLabel);
            headingsLayout.AddView(gateLabel);
            layout.AddView(headingsLayout);

            // Input fields row: Adults, Eggs, Chicks inputs, Gate Status spinner
            var inputFieldsLayout = new LinearLayout(this)
            {
                Orientation = Android.Widget.Orientation.Horizontal
            };
            var inputFieldsParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            inputFieldsParams.SetMargins(0, 0, 0, 16);
            inputFieldsLayout.LayoutParameters = inputFieldsParams;

            _adultsEditText = CreateStyledNumberField();
            _eggsEditText = CreateStyledNumberField();
            _chicksEditText = CreateStyledNumberField();
            _gateStatusSpinner = CreateGateStatusSpinner();

            // Set the spinner to have the same layout weight as the input fields
            var spinnerParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1);
            spinnerParams.SetMargins(4, 0, 4, 0);
            _gateStatusSpinner.LayoutParameters = spinnerParams;

            inputFieldsLayout.AddView(_adultsEditText);
            inputFieldsLayout.AddView(_eggsEditText);
            inputFieldsLayout.AddView(_chicksEditText);
            inputFieldsLayout.AddView(_gateStatusSpinner);
            layout.AddView(inputFieldsLayout);

            var notesLabel = new TextView(this)
            {
                Text = "Notes:",
                TextSize = 16
            };
            notesLabel.SetTextColor(TEXT_PRIMARY);
            notesLabel.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            var notesLabelParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            notesLabelParams.SetMargins(0, 0, 0, 8);
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
            notesEditParams.SetMargins(0, 0, 0, 8);
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
            
            // Only count actual gate status values - ignore nulls
            var gateUpCount = _boxDataStorage.Values.Count(box => box.GateStatus == "gate up");
            var regateCount = _boxDataStorage.Values.Count(box => box.GateStatus == "regate");

            ShowConfirmationDialog(
                "Save All Data",
                $"Save data to Downloads folder?\n\n📦 {totalBoxes} boxes\n🐧 {totalBirds} bird scans\n👥 {totalAdults} adults\n🥚 {totalEggs} eggs\n🐣 {totalChicks} chicks\n🚪 Gate: {gateUpCount} up, {regateCount} regate",
                ("Save", SaveAllData),
                ("Cancel", () => { }
            )
            );
        }

        private void ShowConfirmationDialog(string title, string message, (string text, Action action) positiveButton, (string text, Action action) negativeButton)
        {
            var alertDialog = new AlertDialog.Builder(this)
                .SetTitle(title)
                .SetMessage(message)
                .SetPositiveButton(positiveButton.text, (s, e) => positiveButton.action())
                .SetNegativeButton(negativeButton.text, (s, e) => negativeButton.action())
                .SetCancelable(true)
                .Create();

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
            boxData.GateStatus = GetSelectedGateStatus();
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

            if (_gateStatusSpinner != null)
                _gateStatusSpinner.ItemSelected -= OnGateStatusChanged;

            if (_boxDataStorage.ContainsKey(_currentBox))
            {
                var boxData = _boxDataStorage[_currentBox];
                if (_adultsEditText != null) _adultsEditText.Text = boxData.Adults.ToString();
                if (_eggsEditText != null) _eggsEditText.Text = boxData.Eggs.ToString();
                if (_chicksEditText != null) _chicksEditText.Text = boxData.Chicks.ToString();
                SetSelectedGateStatus(boxData.GateStatus);
                if (_notesEditText != null) _notesEditText.Text = boxData.Notes;
                UpdateScannedIdsDisplay(boxData.ScannedIds);
            }
            else
            {
                if (_adultsEditText != null) _adultsEditText.Text = "0";
                if (_eggsEditText != null) _eggsEditText.Text = "0";
                if (_chicksEditText != null) _chicksEditText.Text = "0";
                SetSelectedGateStatus(null);
                if (_notesEditText != null) _notesEditText.Text = "";
                UpdateScannedIdsDisplay(new List<ScanRecord>());
            }

            foreach (var editText in editTexts)
            {
                if (editText != null) editText.TextChanged += OnDataChanged;
            }

            if (_gateStatusSpinner != null)
                _gateStatusSpinner.ItemSelected += OnGateStatusChanged;
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

            // Add manual input section at the bottom
            var manualInputLayout = new LinearLayout(this)
            {
                Orientation = Android.Widget.Orientation.Horizontal
            };
            var manualInputParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            manualInputParams.SetMargins(0, 12, 0, 0);
            manualInputLayout.LayoutParameters = manualInputParams;

            _manualScanEditText = new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassText | Android.Text.InputTypes.TextFlagCapCharacters,
                Hint = "Enter 8-digit scan number",
                TextSize = 14
            };
            _manualScanEditText.SetTextColor(TEXT_PRIMARY);
            _manualScanEditText.SetHintTextColor(TEXT_SECONDARY);
            _manualScanEditText.SetPadding(12, 12, 12, 12);
            _manualScanEditText.Background = CreateRoundedBackground(Color.White, 6);
            _manualScanEditText.SetFilters(new IInputFilter[] { new InputFilterLengthFilter(8) });

            var editTextParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1);
            editTextParams.SetMargins(0, 0, 8, 0);
            _manualScanEditText.LayoutParameters = editTextParams;

            var addButton = new Button(this)
            {
                Text = "Add",
                TextSize = 12
            };
            addButton.SetTextColor(Color.White);
            addButton.SetTypeface(Android.Graphics.Typeface.DefaultBold, Android.Graphics.TypefaceStyle.Normal);
            addButton.SetPadding(16, 12, 16, 12); addButton.Background = CreateRoundedBackground(SUCCESS_COLOR, 6);
            addButton.SetAllCaps(false);

            var addButtonParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent);
            addButton.LayoutParameters = addButtonParams;

            addButton.Click += OnManualAddClick;

            manualInputLayout.AddView(_manualScanEditText);
            manualInputLayout.AddView(addButton);
            _scannedIdsContainer.AddView(manualInputLayout);
        }

        private LinearLayout CreateScanRecordView(ScanRecord scan, int index)
        {
            var scanLayout = new LinearLayout(this)
            {
                Orientation = Android.Widget.Orientation.Horizontal
            };

            var layoutParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);
            layoutParams.SetMargins(0, 2, 0, 2);
            scanLayout.LayoutParameters = layoutParams;

            // Determine background color based on penguin sex data
            Color backgroundColor;
            string additionalInfo = "";
            
            if (_remotePenguinData.TryGetValue(scan.BirdId, out var penguinData))
            {
                // Penguin found in remote data - prioritize life stage over sex
                if (penguinData.LastKnownLifeStage == LifeStage.Chick)
                {
                    backgroundColor = CHICK_BACKGROUND;
                    additionalInfo = " 🐣"; // Chick emoji
                }
                else if (penguinData.Sex.Equals("F", StringComparison.OrdinalIgnoreCase))
                {
                    backgroundColor = FEMALE_BACKGROUND;
                    additionalInfo = " ♀";
                }
                else if (penguinData.Sex.Equals("M", StringComparison.OrdinalIgnoreCase))
                {
                    backgroundColor = MALE_BACKGROUND;
                    additionalInfo = " ♂";
                }
                else
                {
                    // Unknown sex, use alternating colors
                    backgroundColor = index % 2 == 0 ? SCAN_ROW_EVEN : SCAN_ROW_ODD;
                }
            }
            else
            {
                // Penguin not found in remote data, use alternating colors
                backgroundColor = index % 2 == 0 ? SCAN_ROW_EVEN : SCAN_ROW_ODD;
            }

            scanLayout.Background = CreateRoundedBackground(backgroundColor, 4);
            scanLayout.SetPadding(12, 8, 12, 8);

            // Scan info text with additional penguin information
            var timeStr = scan.Timestamp.ToString("MMM dd, HH:mm");
            var scanText = new TextView(this)
            {
                Text = $"• {scan.BirdId}{additionalInfo} at {timeStr}",
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
            var input = new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassNumber,
                Hint = "Enter box number (1-150)"
            };
            input.SetTextColor(TEXT_PRIMARY);

            var alertDialog = new AlertDialog.Builder(this)
                .SetTitle($"Move Bird {scanToMove.BirdId}")
                .SetMessage($"Move from Box {_currentBox} to:")
                .SetView(input)
                .SetPositiveButton("Move", (s, e) =>
                {
                    if (int.TryParse(input.Text, out int targetBox))
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

            alertDialog?.Show();
            
            input.RequestFocus();
            var inputMethodManager = (Android.Views.InputMethods.InputMethodManager?)GetSystemService(InputMethodService);
            inputMethodManager?.ShowSoftInput(input, Android.Views.InputMethods.ShowFlags.Implicit);
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

                // Load main app data
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

                // Load remote penguin data
                var remoteBirdDataPath = System.IO.Path.Combine(internalPath, REMOTE_BIRD_DATA_FILENAME);
                if (File.Exists(remoteBirdDataPath))
                {
                    var remoteBirdJson = File.ReadAllText(remoteBirdDataPath);
                    var remotePenguinData = JsonSerializer.Deserialize<Dictionary<string, PenguinData>>(remoteBirdJson);
                    
                    if (remotePenguinData != null)
                    {
                        _remotePenguinData = remotePenguinData;
                        Toast.MakeText(this, $"🐧 {_remotePenguinData.Count} bird records loaded", ToastLength.Short)?.Show();
                    }
                }
            }
            catch (Exception ex)
            {
                _currentBox = 1;
                _boxDataStorage = new Dictionary<int, BoxData>();
                _remotePenguinData = new Dictionary<string, PenguinData>();
                System.Diagnostics.Debug.WriteLine($"Failed to load data: {ex.Message}");
            }
        }
        private void TriggerChickAlert()
        {
            try
            {
                // Vibrate for 500ms
                if (_vibrator != null)
                {
                    if (Android.OS.Build.VERSION.SdkInt >= Android.OS.BuildVersionCodes.O)
                    {
                        // Use VibrationEffect for API 26+
                        var vibrationEffect = VibrationEffect.CreateOneShot(500, VibrationEffect.DefaultAmplitude);
                        _vibrator.Vibrate(vibrationEffect);
                    }
                    else
                    {
                        // Use deprecated method for older APIs
#pragma warning disable CS0618 // Type or member is obsolete
                        _vibrator.Vibrate(500);
#pragma warning restore CS0618 // Type or member is obsolete
                    }
                }

                // Play alert sound
                if (_alertMediaPlayer != null)
                {
                    try
                    {
                        if (_alertMediaPlayer.IsPlaying)
                        {
                            _alertMediaPlayer.Stop();
                            _alertMediaPlayer.Prepare();
                        }
                        _alertMediaPlayer.Start();
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

        private void AddScannedId(String fullEid)
        {
            var cleanEid = new String(fullEid.Where(char.IsLetterOrDigit).ToArray());
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

                // Check if this penguin should auto-increment Adults count
                if (_remotePenguinData.TryGetValue(shortId, out var penguinData))
                {
                    if (penguinData.LastKnownLifeStage == LifeStage.Adult || 
                        penguinData.LastKnownLifeStage == LifeStage.Returnee)
                    {
                        boxData.Adults++;
                        
                        RunOnUiThread(() =>
                        {
                            // Update the Adults field in the UI
                            if (_adultsEditText != null)
                            {
                                _adultsEditText.Text = boxData.Adults.ToString();
                            }
                        });
                    }
                }

                SaveDataToInternalStorage();

                RunOnUiThread(() =>
                {
                    UpdateScannedIdsDisplay(boxData.ScannedIds);
                    
                    // Enhanced toast message with life stage info
                    string toastMessage = $"🐧 Bird {shortId} added to Box {_currentBox}";
                    if (_remotePenguinData.TryGetValue(shortId, out var penguin))
                    {
                        if (penguin.LastKnownLifeStage == LifeStage.Adult || 
                            penguin.LastKnownLifeStage == LifeStage.Returnee)
                        {
                            toastMessage += $" (+1 Adult)";
                        }
                        else if (penguin.LastKnownLifeStage == LifeStage.Chick)
                        {
                            toastMessage += $" (Chick)";
                            TriggerChickAlert();
                        }
                    }
                    
                    Toast.MakeText(this, toastMessage, ToastLength.Short)?.Show();
                });
            }
        }

        private void SaveAllData()
        {
            ShowSaveFilenameDialog();
        }

        private void ShowSaveFilenameDialog()
        {
            var now = DateTime.Now;
            var defaultFileName = $"PenguinMonitoring {now:yyMMdd HHmmss}";

            var input = new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassText,
                Text = defaultFileName,
                Hint = "Enter filename (without .json extension)"
            };
            input.SetTextColor(TEXT_PRIMARY);
            input.SetPadding(16, 16, 16, 16);
            input.Background = CreateRoundedBackground(TEXT_FIELD_BACKGROUND_COLOR, 8);

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

                    SaveDataWithFilename(fileName);
                })
                .SetNegativeButton("Cancel", (s, e) => { })
                .Create();

            alertDialog?.Show();
            
            input.RequestFocus();
            input.SelectAll();

            var inputMethodManager = (Android.Views.InputMethods.InputMethodManager?)GetSystemService(InputMethodService);
            inputMethodManager?.ShowSoftInput(input, Android.Views.InputMethods.ShowFlags.Implicit);
        }

        private void SaveDataWithFilename(string fileName)
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

                var filePath = System.IO.Path.Combine(downloadsPath, fileName);

                // Check if file already exists
                if (File.Exists(filePath))
                {
                    ShowConfirmationDialog(
                        "File Exists",
                        $"A file named '{fileName}' already exists. Do you want to overwrite it?",
                        ("Overwrite", () => SaveFileToPath(filePath, json, fileName)),
                        ("Cancel", () => ShowSaveFilenameDialog()) // Go back to filename dialog
                    );
                }
                else
                {
                    SaveFileToPath(filePath, json, fileName);
                }
            }
            catch (Exception ex)
            {
                Toast.MakeText(this, $"❌ Export failed: {ex.Message}", ToastLength.Long)?.Show();
            }
        }

        private void SaveFileToPath(string filePath, string json, string fileName)
        {
            try
            {
                File.WriteAllText(filePath, json);

                var totalBoxes = _boxDataStorage.Count;
                var totalBirds = _boxDataStorage.Values.Sum(box => box.ScannedIds.Count);

                Toast.MakeText(this, $"💾 Data saved!\n📂 {fileName}\n📦 {totalBoxes} boxes, 🐧 {totalBirds} birds", ToastLength.Long)?.Show();
            }
            catch (Exception ex)
            {
                Toast.MakeText(this, $"❌ Failed to save file: {ex.Message}", ToastLength.Long)?.Show();
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
            var input = new EditText(this)
            {
                InputType = Android.Text.InputTypes.ClassNumber,
                Text = _currentBox.ToString(),
                Hint = "Box number"
            };
            input.SetTextColor(TEXT_PRIMARY);

            var alertDialog = new AlertDialog.Builder(this)
                .SetTitle("Jump to Box")
                .SetMessage("Enter box number (1-150):")
                .SetView(input)
                .SetPositiveButton("Go", (s, e) =>
                {
                    if (int.TryParse(input.Text, out int targetBox))
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

            alertDialog?.Show();
            
            input.RequestFocus();
            input.SelectAll();

            var inputMethodManager = (Android.Views.InputMethods.InputMethodManager?)GetSystemService(InputMethodService);
            inputMethodManager?.ShowSoftInput(input, Android.Views.InputMethods.ShowFlags.Implicit);
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

            // Clean up gesture detector
            if (_dataCard != null)
            {
                _dataCard.Touch -= OnScrollViewTouch;
            }

            var editTexts = new[]
            {
                (_adultsEditText, true), (_eggsEditText, true), (_chicksEditText, true), (_notesEditText, false), (_manualScanEditText, false)
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

            if (_gateStatusSpinner != null)
                _gateStatusSpinner.ItemSelected -= OnGateStatusChanged;

            if (_prevBoxButton != null) _prevBoxButton.Click -= OnPrevBoxClick;
            if (_nextBoxButton != null) _nextBoxButton.Click -= OnNextBoxClick;
            if (_clearBoxButton != null) _clearBoxButton.Click -= OnClearBoxesClick;
            if (_boxNumberText != null) _boxNumberText.Click -= OnBoxNumberClick;

            _locationManager?.RemoveUpdates(this);

            base.OnDestroy();
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
            
            if ( cleanInput.Length != 8)
            {
                Toast.MakeText(this, "Scan number must be exactly 8 digits/letters", ToastLength.Short)?.Show();
                _manualScanEditText.RequestFocus();
                return;
            }

            // Check if bird already exists in current box
            if (!_boxDataStorage.ContainsKey(_currentBox))
                _boxDataStorage[_currentBox] = new BoxData();

            var boxData = _boxDataStorage[_currentBox];

            if (boxData.ScannedIds.Any(s => s.BirdId == cleanInput))
            {
                Toast.MakeText(this, $"Bird {cleanInput} already scanned in this box", ToastLength.Short)?.Show();
                _manualScanEditText.Text = "";
                return;
            }

            // Add the scan record
            var scanRecord = new ScanRecord
            {
                BirdId = cleanInput,
                Timestamp = DateTime.Now,
                Latitude = _currentLocation?.Latitude ?? 0,
                Longitude = _currentLocation?.Longitude ?? 0,
                Accuracy = _currentLocation?.Accuracy ?? -1
            };

            boxData.ScannedIds.Add(scanRecord);

            // Check if this penguin should auto-increment Adults count
            if (_remotePenguinData.TryGetValue(cleanInput, out var penguinData))
            {
                if (penguinData.LastKnownLifeStage == LifeStage.Adult || 
                    penguinData.LastKnownLifeStage == LifeStage.Returnee)
                {
                    boxData.Adults++;
                    
                    // Update the Adults field in the UI
                    if (_adultsEditText != null)
                    {
                        _adultsEditText.Text = boxData.Adults.ToString();
                    }
                }
            }

            SaveDataToInternalStorage();

            // Clear input and update display
            _manualScanEditText.Text = "";
            UpdateScannedIdsDisplay(boxData.ScannedIds);

            // Enhanced toast message with life stage info
            string toastMessage = $"🐧 Bird {cleanInput} manually added to Box {_currentBox}";
            if (_remotePenguinData.TryGetValue(cleanInput, out var penguin))
            {
                if (penguin.LastKnownLifeStage == LifeStage.Adult || 
                    penguin.LastKnownLifeStage == LifeStage.Returnee)
                {
                    toastMessage += $" (+1 Adult)";
                }
                else if (penguin.LastKnownLifeStage == LifeStage.Chick)
                {
                    toastMessage += $" (Chick)";
                    //vibrate adn play an alert here. 
                }
            }
            
            Toast.MakeText(this, toastMessage, ToastLength.Short)?.Show();
        }

        private string? GetSelectedGateStatus()
        {
            if (_gateStatusSpinner?.SelectedItem != null)
            {
                var selected = _gateStatusSpinner.SelectedItem.ToString() ?? "";
                return string.IsNullOrEmpty(selected) ? null : selected;
            }
            return null;
        }

        private void SetSelectedGateStatus(string? gateStatus)
        {
            if (_gateStatusSpinner?.Adapter != null)
            {
                var adapter = _gateStatusSpinner.Adapter as ArrayAdapter<string>;
                if (adapter != null)
                {
                    var displayValue = gateStatus ?? "";
                    var position = adapter.GetPosition(displayValue);
                    if (position >= 0)
                        _gateStatusSpinner.SetSelection(position);
                }
            }
        }

        private Spinner CreateGateStatusSpinner()
        {
            var spinner = new Spinner(this);
            spinner.SetPadding(16, 20, 16, 20);
            spinner.Background = CreateRoundedBackground(TEXT_FIELD_BACKGROUND_COLOR, 8);
            
            // Create options with blank first option instead of "null"
            var gateStatusOptions = new string[] { "", "gate up", "regate" };
            var adapter = new ArrayAdapter<string>(this, Android.Resource.Layout.SimpleSpinnerItem, gateStatusOptions);
            adapter.SetDropDownViewResource(Android.Resource.Layout.SimpleSpinnerDropDownItem);
            spinner.Adapter = adapter;
            
            spinner.ItemSelected += OnGateStatusChanged;
            
            return spinner;
        }

        private void OnGateStatusChanged(object? sender, AdapterView.ItemSelectedEventArgs e)
        {
            // Only save if a real gate status is selected (not the blank option)
            var selectedItem = _gateStatusSpinner?.SelectedItem?.ToString() ?? "";
            if (!string.IsNullOrEmpty(selectedItem))
            {
                SaveCurrentBoxData();
            }
        }

        private void OnDataClick(object? sender, EventArgs e)
        {
            ShowDataOptionsDialog();
        }

        private void ShowDataOptionsDialog()
        {
            var options = new string[] 
            {
                "📊 Summary - View data overview",
                "💾 Save Data - Export to file", 
                "📂 Load Data - Import from file"
            };

            var builder = new AlertDialog.Builder(this);
            builder.SetTitle("Data Options");
            
            builder.SetItems(options, (sender, args) =>
            {
                switch (args.Which)
                {
                    case 0: // Summary
                        ShowBoxDataSummary();
                        break;
                    case 1: // Save Data
                        OnSaveDataClick(null, EventArgs.Empty);
                        break;
                    case 2: // Load Data
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