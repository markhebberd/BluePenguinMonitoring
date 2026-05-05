package nz.co.penguinmonitor.bluetooth

sealed class BluetoothState(val statusText: String) {
    data object Disconnected : BluetoothState("Not connected")
    data class Connecting(val attempt: Int, val message: String) : BluetoothState(message)
    data class Connected(val deviceName: String) : BluetoothState("Connected to $deviceName - Ready to scan")
    data class Error(val message: String) : BluetoothState(message)
    data object Cancelled : BluetoothState("Connection cancelled")
}
