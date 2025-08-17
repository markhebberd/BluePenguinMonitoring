using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Android.Bluetooth;
using Java.Util;

namespace BluePenguinMonitoring
{
    public class BluetoothManager : IDisposable
    {
        // Bluetooth components
        private BluetoothSocket? _bluetoothSocket;
        private Stream? _inputStream;
        private Stream? _outputStream;
        private bool _isConnected = false;
        private const string READER_BLUETOOTH_ADDRESS = "00:07:80:E6:95:52";

        // Events for communicating with MainActivity
        public event Action<string>? StatusChanged;
        public event Action<string>? EidDataReceived;

        public bool IsConnected => _isConnected;

        public async Task StartConnectionAsync()
        {
            await Task.Run(async () =>
            {
                await Task.Delay(3000);
                await ConnectToReaderBluetoothAsync();
            });
        }

        private async Task ConnectToReaderBluetoothAsync()
        {
            try
            {
                StatusChanged?.Invoke("Connecting to HR5...");

                var bluetoothAdapter = BluetoothAdapter.DefaultAdapter;
                if (bluetoothAdapter?.IsEnabled != true)
                {
                    StatusChanged?.Invoke("Bluetooth not available");
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

                    StatusChanged?.Invoke("HR5 Connected - Ready to scan");
                    await ListenForEidDataAsync();
                }
            }
            catch (Exception ex)
            {
                StatusChanged?.Invoke($"Connection failed: {ex.Message}");
            }
        }

        private async Task ListenForEidDataAsync()
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
                                EidDataReceived?.Invoke(cleanData);
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
                StatusChanged?.Invoke($"Scanning error: {ex.Message}");
            }
        }

        public void Disconnect()
        {
            _isConnected = false;
            _bluetoothSocket?.Close();
            _inputStream?.Dispose();
            _outputStream?.Dispose();
        }

        public void Dispose()
        {
            Disconnect();
        }
    }
}