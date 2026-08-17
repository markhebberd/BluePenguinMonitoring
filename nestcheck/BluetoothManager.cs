using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Android.Bluetooth;
using Android.Content;
using Java.Util;

namespace PenguinMonitor
{
    public class BluetoothManager : IDisposable
    {
        private static readonly UUID SppUuid = UUID.FromString("00001101-0000-1000-8000-00805F9B34FB")!;

        private BluetoothSocket? _socket;
        private Stream? _inputStream;
        private CancellationTokenSource? _cts;
        private bool _isConnected;
        private bool _shouldReconnect = true;
        private List<string> _deviceAddresses = new();  // enabled scanners, tried in order

        private const int ConnectTimeoutMs = 10000;
        private const int InitialRetryMs = 2000;
        private const int MaxRetryMs = 30000;

        public event Action<string>? StatusChanged;
        public event Action<string>? EidDataReceived;

        public bool IsConnected => _isConnected;
        public bool IsConnecting { get; private set; }
        public string? ConnectedDeviceName { get; private set; }
        public string? ConnectedDeviceAddress { get; private set; }

        /// <summary>
        /// Returns all paired Bluetooth devices.
        /// </summary>
        public static List<(string Address, string Name)> GetPairedDevices()
        {
            var adapter = BluetoothAdapter.DefaultAdapter;
            if (adapter?.IsEnabled != true) return new();
            return (adapter.BondedDevices ?? Enumerable.Empty<BluetoothDevice>())
                .Where(d => d.Address != null)
                .Select(d => (d.Address!, d.Name ?? d.Address!))
                .OrderBy(d => d.Item2)
                .ToList();
        }

        /// <summary>
        /// Discovers nearby Bluetooth devices (paired and unpaired).
        /// Runs for ~12 seconds. Calls onDeviceFound for each device discovered.
        /// Call from an Activity context.
        /// </summary>
        public static IDisposable StartDiscovery(Context context, Action<string, string> onDeviceFound, Action? onFinished = null)
        {
            var adapter = BluetoothAdapter.DefaultAdapter;
            if (adapter?.IsEnabled != true)
            {
                onFinished?.Invoke();
                return new NoOpDisposable();
            }

            var seen = new HashSet<string>();
            try
            {
                // Include already-paired devices immediately
                foreach (var d in adapter.BondedDevices ?? Enumerable.Empty<BluetoothDevice>())
                {
                    if (d.Address != null && seen.Add(d.Address))
                        onDeviceFound(d.Address, d.Name ?? d.Address);
                }

                var receiver = new DiscoveryReceiver(seen, onDeviceFound, onFinished);
                var filter = new IntentFilter();
                filter.AddAction(BluetoothDevice.ActionFound);
                filter.AddAction(BluetoothAdapter.ActionDiscoveryFinished);
                context.RegisterReceiver(receiver, filter);

                adapter.CancelDiscovery();
                adapter.StartDiscovery();

                return new DiscoveryHandle(context, receiver, adapter);
            }
            catch (Exception ex)
            {
                // Missing BLUETOOTH_SCAN/CONNECT permission (SecurityException) or other failure —
                // don't crash; let the caller reset its UI.
                System.Diagnostics.Debug.WriteLine($"StartDiscovery failed: {ex.Message}");
                onFinished?.Invoke();
                return new NoOpDisposable();
            }
        }

        private class DiscoveryReceiver : BroadcastReceiver
        {
            private readonly HashSet<string> _seen;
            private readonly Action<string, string> _onFound;
            private readonly Action? _onFinished;

            public DiscoveryReceiver(HashSet<string> seen, Action<string, string> onFound, Action? onFinished)
            {
                _seen = seen; _onFound = onFound; _onFinished = onFinished;
            }

            public override void OnReceive(Context? context, Intent? intent)
            {
                if (intent?.Action == BluetoothDevice.ActionFound)
                {
                    var device = intent.GetParcelableExtra(BluetoothDevice.ExtraDevice) as BluetoothDevice;
                    if (device?.Address != null && _seen.Add(device.Address))
                        _onFound(device.Address, device.Name ?? device.Address);
                }
                else if (intent?.Action == BluetoothAdapter.ActionDiscoveryFinished)
                {
                    _onFinished?.Invoke();
                }
            }
        }

        private class DiscoveryHandle : IDisposable
        {
            private readonly Context _context;
            private readonly BroadcastReceiver _receiver;
            private readonly BluetoothAdapter _adapter;
            private bool _disposed;

            public DiscoveryHandle(Context context, BroadcastReceiver receiver, BluetoothAdapter adapter)
            {
                _context = context; _receiver = receiver; _adapter = adapter;
            }

            public void Dispose()
            {
                if (_disposed) return;
                _disposed = true;
                _adapter.CancelDiscovery();
                try { _context.UnregisterReceiver(_receiver); } catch { }
            }
        }

        private class NoOpDisposable : IDisposable { public void Dispose() { } }

        /// <summary>
        /// Connect to a Bluetooth device by MAC address. Retries with exponential backoff.
        /// </summary>
        public async Task ConnectAsync(string deviceAddress) =>
            await ConnectAsync(new List<string> { deviceAddress });

        /// <summary>
        /// Connect to the first reachable scanner, trying the given addresses in order.
        /// Reconnects automatically on drop and keeps retrying the whole list with backoff.
        /// </summary>
        public async Task ConnectAsync(IReadOnlyList<string> deviceAddresses)
        {
            if (IsConnecting || _isConnected) return;

            _deviceAddresses = (deviceAddresses ?? new List<string>())
                .Where(a => !string.IsNullOrEmpty(a)).Distinct().ToList();
            if (_deviceAddresses.Count == 0) { StatusChanged?.Invoke("No scanner selected"); return; }

            _shouldReconnect = true;
            _cts = new CancellationTokenSource();
            await ConnectLoop();
        }

        private async Task ConnectLoop()
        {
            IsConnecting = true;
            var pass = 0;
            var retryMs = InitialRetryMs;

            try
            {
                var adapter = BluetoothAdapter.DefaultAdapter;
                if (adapter?.IsEnabled != true)
                {
                    StatusChanged?.Invoke("Bluetooth is off");
                    return;
                }

                while (!_isConnected && _shouldReconnect && _cts?.Token.IsCancellationRequested != true)
                {
                    pass++;
                    if (pass > 1)
                    {
                        StatusChanged?.Invoke($"No scanner found — retry in {retryMs / 1000}s...");
                        try { await Task.Delay(retryMs, _cts!.Token); } catch (OperationCanceledException) { break; }
                    }

                    // Try each enabled scanner in order; the first to connect wins.
                    foreach (var addr in _deviceAddresses)
                    {
                        if (_cts?.Token.IsCancellationRequested == true) break;
                        try
                        {
                            var device = adapter.GetRemoteDevice(addr);
                            if (device == null) continue;

                            ConnectedDeviceName = device.Name ?? addr;
                            ConnectedDeviceAddress = addr;
                            StatusChanged?.Invoke($"Connecting to {ConnectedDeviceName}...");

                            adapter.CancelDiscovery();
                            CleanupSocket();

                            _socket = device.CreateRfcommSocketToServiceRecord(SppUuid);
                            if (_socket == null) continue;

                            var connectTask = Task.Run(() => _socket.Connect(), _cts!.Token);
                            if (await Task.WhenAny(connectTask, Task.Delay(ConnectTimeoutMs, _cts.Token)) != connectTask)
                                throw new TimeoutException("Connection timed out");
                            await connectTask; // propagate exceptions

                            if (!_socket.IsConnected) throw new Exception("Socket not connected");

                            _inputStream = _socket.InputStream;
                            _isConnected = true;
                            retryMs = InitialRetryMs;
                            StatusChanged?.Invoke($"{ConnectedDeviceName} connected");

                            _ = Task.Run(ListenLoop, _cts.Token);
                            return;
                        }
                        catch (OperationCanceledException) { break; }
                        catch (Exception ex)
                        {
                            StatusChanged?.Invoke($"{ConnectedDeviceName ?? addr}: {ex.Message}");
                            CleanupSocket();
                            // fall through to the next scanner in the list
                        }
                    }

                    // Nothing connected this pass — back off before trying the whole list again.
                    retryMs = Math.Min((int)(retryMs * 1.5), MaxRetryMs);
                    if (pass % 10 == 0) retryMs = InitialRetryMs;
                }
            }
            catch (OperationCanceledException) { }
            finally { IsConnecting = false; }
        }

        /// <summary>
        /// A complete EID carries exactly 15 digits: the HR5's ASCII form is
        /// "LA" + 15 digits (17 chars, e.g. LA123456789012345), or a bare 15-digit
        /// ISO number if the reader omits the prefix. Anything else is a partial/
        /// corrupted read — a truncated box tag would otherwise fail the 9000250
        /// prefix test and be recorded as a penguin.
        /// </summary>
        public static bool IsCompleteEid(string clean)
        {
            if (clean.Length == 15) return clean.All(char.IsDigit);
            if (clean.Length == 17)
                return char.IsLetter(clean[0]) && char.IsLetter(clean[1]) && clean.Skip(2).All(char.IsDigit);
            return false;
        }

        /// <summary>
        /// The tag as everything downstream knows it: its 15 ISO digits.
        ///
        /// The reader prepends its own two-letter manufacturer code ("LA"), which is not part of
        /// the ISO number and is not printed on the chip label — so it can't be typed, only
        /// scanned, and a bird identified by label and a bird identified by reader used to be two
        /// different strings. It comes off here, at the one point every scan passes through, and
        /// the app has one spelling of a tag from that point on.
        /// </summary>
        public static string BareEid(string clean)
        {
            int i = 0;
            while (i < clean.Length && char.IsLetter(clean[i])) i++;
            if (i == 0) return clean;
            // Only a letter prefix sitting on the ISO digits comes off. Anything else — a
            // NOSCAN placeholder, a corrupted read — is handed back exactly as it came, because
            // rewriting a value we don't recognise is worse than carrying it unchanged.
            var digits = clean.Substring(i);
            return digits.Length > 0 && digits.All(char.IsDigit) ? digits : clean;
        }

        private async Task ListenLoop()
        {
            var buffer = new byte[1024];
            var sb = new StringBuilder();
            var lastDataUtc = DateTime.UtcNow;

            try
            {
                while (_isConnected && _socket?.IsConnected == true && _inputStream != null
                       && _cts?.Token.IsCancellationRequested != true)
                {
                    var n = await _inputStream.ReadAsync(buffer, 0, buffer.Length, _cts?.Token ?? CancellationToken.None);
                    if (n <= 0) continue;

                    // A fragment that has sat unterminated through >1.5s of silence is a
                    // broken transmission (e.g. the scanner slept mid-send). Drop it rather
                    // than glue it onto the front of the next scan.
                    if (sb.Length > 0 && (DateTime.UtcNow - lastDataUtc).TotalMilliseconds > 1500)
                    {
                        StatusChanged?.Invoke("Ignored partial scan — please scan again");
                        sb.Clear();
                    }
                    lastDataUtc = DateTime.UtcNow;

                    sb.Append(Encoding.UTF8.GetString(buffer, 0, n));

                    // Frame on CR/LF — the reader terminates each tag with a newline. Only
                    // complete lines are judged; a partial line stays buffered until its
                    // remainder arrives (or staleness discards it above).
                    var text = sb.ToString();
                    int nl;
                    while ((nl = text.IndexOfAny(new[] { '\r', '\n' })) >= 0)
                    {
                        var line = text.Substring(0, nl);
                        text = text.Substring(nl + 1);
                        var clean = new string(line.Where(char.IsLetterOrDigit).ToArray());
                        if (clean.Length == 0) continue;
                        if (IsCompleteEid(clean))
                            EidDataReceived?.Invoke(BareEid(clean));
                        else
                            StatusChanged?.Invoke($"Ignored partial scan ({clean.Length} chars) — please scan again");
                    }
                    sb.Clear();
                    sb.Append(text);

                    // No terminator seen (reader configured without CR/LF): emit as soon as
                    // the buffer holds one complete, valid EID (17-char LA form first, then
                    // the bare 15-digit form).
                    var pending = new string(sb.ToString().Where(char.IsLetterOrDigit).ToArray());
                    var take = pending.Length >= 17 && IsCompleteEid(pending.Substring(0, 17)) ? 17
                             : pending.Length >= 15 && IsCompleteEid(pending.Substring(0, 15)) ? 15 : 0;
                    if (take > 0)
                    {
                        EidDataReceived?.Invoke(BareEid(pending.Substring(0, take)));
                        sb.Clear();
                        if (pending.Length > take) sb.Append(pending.Substring(take));
                    }

                    if (sb.Length > 1000) sb.Clear();

                    await Task.Delay(100, _cts?.Token ?? CancellationToken.None);
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                StatusChanged?.Invoke($"Read error: {ex.Message}");
            }

            // Auto-reconnect on disconnect
            _isConnected = false;
            if (_shouldReconnect && _cts?.Token.IsCancellationRequested != true && _deviceAddresses.Count > 0)
            {
                StatusChanged?.Invoke($"{ConnectedDeviceName ?? "Scanner"} disconnected — reconnecting...");
                try { await Task.Delay(3000, _cts?.Token ?? CancellationToken.None); } catch (OperationCanceledException) { return; }
                if (_shouldReconnect && _cts?.Token.IsCancellationRequested != true)
                    await ConnectLoop();
            }
        }

        private void CleanupSocket()
        {
            _isConnected = false;
            try { _inputStream?.Dispose(); } catch { }
            try { _socket?.Close(); } catch { }
            try { _socket?.Dispose(); } catch { }
            _socket = null;
            _inputStream = null;
        }

        public void Disconnect()
        {
            _shouldReconnect = false;
            _cts?.Cancel();
            CleanupSocket();
            ConnectedDeviceName = null;
        }

        public async Task RetryAsync()
        {
            if (IsConnecting || _deviceAddresses.Count == 0) return;
            var addresses = _deviceAddresses.ToList();
            Disconnect();
            await Task.Delay(500);
            await ConnectAsync(addresses);
        }

        public void Dispose()
        {
            Disconnect();
            _cts?.Dispose();
        }
    }
}
