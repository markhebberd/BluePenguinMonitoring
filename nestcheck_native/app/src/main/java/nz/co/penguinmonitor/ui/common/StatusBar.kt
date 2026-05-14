package nz.co.penguinmonitor.ui.common

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import nz.co.penguinmonitor.bluetooth.BluetoothState
import nz.co.penguinmonitor.location.LocationState
import nz.co.penguinmonitor.ui.theme.DangerRed
import nz.co.penguinmonitor.ui.theme.SuccessGreen
import nz.co.penguinmonitor.ui.theme.TextSecondary
import nz.co.penguinmonitor.ui.theme.WarningYellow

@Composable
fun StatusBar(
    bluetoothState: BluetoothState,
    locationState: LocationState,
    modifier: Modifier = Modifier
) {
    val btText = when (bluetoothState) {
        is BluetoothState.Connected -> "HR5 Connected"
        is BluetoothState.Connecting -> bluetoothState.statusText
        is BluetoothState.Error -> bluetoothState.statusText
        is BluetoothState.Disconnected -> "Bluetooth Disabled"
        is BluetoothState.Cancelled -> "Connection cancelled"
    }

    val gpsText = if (locationState.isAvailable) {
        "GPS: ±${String.format("%.1f", locationState.accuracy)}m"
    } else {
        "GPS: No signal"
    }

    // Combined status line matching C# format
    val combined = "$btText | $gpsText"
    val color = when {
        bluetoothState is BluetoothState.Connected && locationState.isAvailable -> SuccessGreen
        bluetoothState is BluetoothState.Connected -> WarningYellow
        bluetoothState is BluetoothState.Error -> DangerRed
        else -> TextSecondary
    }

    Text(
        text = combined,
        color = color,
        fontSize = 12.sp,
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
    )
}
