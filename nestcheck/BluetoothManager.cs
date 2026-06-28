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
        private string? _deviceAddress;

        private const int ConnectTimeoutMs = 10000;
        private const int InitialRetryMs = 2000;
        private const int MaxRetryMs = 30000;

        public event Action<string>? StatusChanged;
        public event Action<string>? EidDataReceived;

        public bool IsConnected => _isConnected;
        public bool IsConnecting { get; private set; }
        public string? ConnectedDeviceName { get; private set; }

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
        public async Task ConnectAsync(string deviceAddress)
        {
            if (IsConnecting || _isConnected) return;

            _deviceAddress = deviceAddress;
            _shouldReconnect = true;
            _cts = new CancellationTokenSource();

            await ConnectLoop();
        }

        private async Task ConnectLoop()
        {
            IsConnecting = true;
            var attempt = 0;
            var retryMs = InitialRetryMs;

            try
            {
                var adapter = BluetoothAdapter.DefaultAdapter;
                if (adapter?.IsEnabled != true)
                {
                    StatusChanged?.Invoke("Bluetooth is off");
                    return;
                }

                while (!_isConnected && _cts?.Token.IsCancellationRequested != true)
                {
                    attempt++;
                    try
                    {
                        if (attempt > 1)
                        {
                            StatusChanged?.Invoke($"Retry {attempt} in {retryMs / 1000}s...");
                            await Task.Delay(retryMs, _cts!.Token);
                        }

                        var device = adapter.GetRemoteDevice(_deviceAddress);
                        if (device == null) throw new Exception($"Device {_deviceAddress} not found");

                        ConnectedDeviceName = device.Name ?? _deviceAddress;
                        StatusChanged?.Invoke($"Connecting to {ConnectedDeviceName}...");

                        adapter.CancelDiscovery();
                        CleanupSocket();

                        _socket = device.CreateRfcommSocketToServiceRecord(SppUuid);
                        if (_socket == null) throw new Exception("Failed to create socket");

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
                        StatusChanged?.Invoke($"Attempt {attempt}: {ex.Message}");
                        CleanupSocket();
                        retryMs = Math.Min((int)(retryMs * 1.5), MaxRetryMs);
                        if (attempt % 10 == 0) retryMs = InitialRetryMs;
                    }
                }
            }
            catch (OperationCanceledException) { }
            finally { IsConnecting = false; }
        }

        private async Task ListenLoop()
        {
            var buffer = new byte[1024];
            var sb = new StringBuilder();

            try
            {
                while (_isConnected && _socket?.IsConnected == true && _inputStream != null
                       && _cts?.Token.IsCancellationRequested != true)
                {
                    var n = await _inputStream.ReadAsync(buffer, 0, buffer.Length, _cts?.Token ?? CancellationToken.None);
                    if (n <= 0) continue;

                    sb.Append(Encoding.UTF8.GetString(buffer, 0, n));
                    var raw = sb.ToString();
                    var clean = new string(raw.Where(char.IsLetterOrDigit).ToArray());

                    if (clean.Length >= 10)
                    {
                        EidDataReceived?.Invoke(clean);
                        sb.Clear();
                    }
                    else if (sb.Length > 1000)
                    {
                        sb.Clear();
                    }

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
            if (_shouldReconnect && _cts?.Token.IsCancellationRequested != true && _deviceAddress != null)
            {
                StatusChanged?.Invoke($"{ConnectedDeviceName ?? "Scanner"} disconnected — reconnecting...");
                await Task.Delay(3000);
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
            if (IsConnecting || string.IsNullOrEmpty(_deviceAddress)) return;
            Disconnect();
            await Task.Delay(500);
            await ConnectAsync(_deviceAddress);
        }

        public void Dispose()
        {
            Disconnect();
            _cts?.Dispose();
        }
    }
}
