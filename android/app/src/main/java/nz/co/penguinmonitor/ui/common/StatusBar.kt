package nz.co.penguinmonitor.ui.common

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
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
    val btColor = when (bluetoothState) {
        is BluetoothState.Connected -> SuccessGreen
        is BluetoothState.Connecting -> WarningYellow
        is BluetoothState.Error -> DangerRed
        else -> TextSecondary
    }

    val gpsText = if (locationState.isAvailable) {
        "GPS: ${locationState.accuracy.toInt()}m"
    } else {
        "GPS: unavailable"
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
    ) {
        Text(
            text = bluetoothState.statusText,
            color = btColor,
            fontSize = 12.sp
        )
        Text(
            text = gpsText,
            color = if (locationState.isAvailable) SuccessGreen else TextSecondary,
            fontSize = 12.sp
        )
    }
}
