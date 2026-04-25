package nz.co.penguinmonitor.bluetooth

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothSocket
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import nz.co.penguinmonitor.util.Constants
import java.io.InputStream
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.min

@Singleton
class BluetoothManagerService @Inject constructor() {

    private val _state = MutableStateFlow<BluetoothState>(BluetoothState.Disconnected)
    val state: StateFlow<BluetoothState> = _state.asStateFlow()

    private val _eidData = MutableSharedFlow<String>(extraBufferCapacity = 10)
    val eidData: SharedFlow<String> = _eidData.asSharedFlow()

    private var socket: BluetoothSocket? = null
    private var inputStream: InputStream? = null
    private var connectionJob: Job? = null
    private var shouldAutoReconnect = true

    val isConnected: Boolean get() = _state.value is BluetoothState.Connected
    val isConnecting: Boolean get() = _state.value is BluetoothState.Connecting

    @SuppressLint("MissingPermission")
    fun startConnection(scope: CoroutineScope) {
        if (isConnecting || isConnected) return
        shouldAutoReconnect = true
        connectionJob = scope.launch(Dispatchers.IO) {
            connectWithRetry()
        }
    }

    @SuppressLint("MissingPermission")
    private suspend fun connectWithRetry() {
        var attempt = 0
        var currentRetryDelay = Constants.INITIAL_RETRY_DELAY_MS

        val bluetoothAdapter = BluetoothAdapter.getDefaultAdapter()
        if (bluetoothAdapter?.isEnabled != true) {
            _state.value = BluetoothState.Error("Bluetooth not available")
            return
        }

        while (shouldAutoReconnect && currentCoroutineContext().isActive) {
            attempt++

            try {
                if (attempt > 1) {
                    _state.value = BluetoothState.Connecting(attempt, "Retry $attempt (waiting ${currentRetryDelay / 1000}s)...")
                    delay(currentRetryDelay)
                } else {
                    _state.value = BluetoothState.Connecting(attempt, "Connecting to HR5...")
                }

                val device = bluetoothAdapter.getRemoteDevice(Constants.HR5_BLUETOOTH_ADDRESS)
                    ?: throw Exception("HR5 device not found")

                if (device.bondState != android.bluetooth.BluetoothDevice.BOND_BONDED) {
                    _state.value = BluetoothState.Error("HR5 not paired - check Android Bluetooth settings")
                    delay(5000)
                    continue
                }

                _state.value = BluetoothState.Connecting(attempt, "Connecting to ${device.name ?: "HR5"} (attempt $attempt)...")

                cleanupConnection()

                val uuid = UUID.fromString(Constants.SERIAL_PORT_PROFILE_UUID)
                val newSocket = device.createRfcommSocketToServiceRecord(uuid)
                socket = newSocket

                // Connect with timeout
                val connected = withTimeoutOrNull(Constants.CONNECTION_TIMEOUT_MS) {
                    withContext(Dispatchers.IO) {
                        newSocket.connect()
                    }
                    true
                } ?: false

                if (!connected) {
                    throw Exception("Connection timeout after ${Constants.CONNECTION_TIMEOUT_MS / 1000} seconds")
                }

                if (newSocket.isConnected) {
                    inputStream = newSocket.inputStream
                    _state.value = BluetoothState.Connected(
                        device.name ?: "HR5"
                    )
                    currentRetryDelay = Constants.INITIAL_RETRY_DELAY_MS
                    listenForEidData()
                    return
                }
            } catch (_: CancellationException) {
                break
            } catch (e: Exception) {
                _state.value = BluetoothState.Connecting(attempt, "Attempt $attempt failed: ${e.message}")
                cleanupConnection()

                currentRetryDelay = min(
                    (currentRetryDelay * Constants.BACKOFF_MULTIPLIER).toLong(),
                    Constants.MAX_RETRY_DELAY_MS
                )

                if (attempt % 10 == 0) {
                    currentRetryDelay = Constants.INITIAL_RETRY_DELAY_MS
                    _state.value = BluetoothState.Connecting(attempt, "Reset retry timing after $attempt attempts")
                }
            }
        }

        if (!shouldAutoReconnect) {
            _state.value = BluetoothState.Cancelled
        }
    }

    private suspend fun listenForEidData() {
        val buffer = ByteArray(1024)
        val receivedData = StringBuilder()

        try {
            while (isConnected && socket?.isConnected == true && inputStream != null) {
                if (!currentCoroutineContext().isActive) break

                try {
                    val stream = inputStream ?: break
                    val bytesRead = withContext(Dispatchers.IO) {
                        stream.read(buffer)
                    }

                    if (bytesRead > 0) {
                        val data = String(buffer, 0, bytesRead, Charsets.UTF_8)
                        receivedData.append(data)

                        val completeData = receivedData.toString()
                        if (completeData.length >= 10) {
                            val cleanData = completeData.filter { it.isLetterOrDigit() }
                            if (cleanData.length >= 10) {
                                _eidData.emit(cleanData)
                                receivedData.clear()
                            }
                        }

                        if (receivedData.length > 1000) {
                            receivedData.clear()
                        }
                    }
                } catch (_: CancellationException) {
                    break
                } catch (e: Exception) {
                    _state.value = BluetoothState.Error("Scanning error: ${e.message}")
                    break
                }

                delay(100)
            }
        } catch (_: CancellationException) {
            // Normal cancellation
        } catch (e: Exception) {
            _state.value = BluetoothState.Error("Scanning error: ${e.message}")
        } finally {
            if (isConnected) {
                _state.value = BluetoothState.Disconnected
                if (shouldAutoReconnect) {
                    delay(3000)
                    if (shouldAutoReconnect) {
                        connectWithRetry()
                    }
                }
            }
        }
    }

    private fun cleanupConnection() {
        try {
            socket?.close()
            inputStream?.close()
            socket = null
            inputStream = null
        } catch (_: Exception) { }
    }

    fun disconnect() {
        shouldAutoReconnect = false
        connectionJob?.cancel()
        cleanupConnection()
        _state.value = BluetoothState.Disconnected
    }

    fun retryConnection(scope: CoroutineScope) {
        disconnect()
        scope.launch {
            delay(1000)
            startConnection(scope)
        }
    }
}
