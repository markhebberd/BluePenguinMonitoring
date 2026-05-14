package nz.co.penguinmonitor.ui.overview.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun MonitorNavigationBar(
    currentMonitorIndex: Int,
    onPrevious: () -> Unit,
    onLatest: () -> Unit,
    onNext: () -> Unit,
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        OutlinedButton(
            onClick = onNext,
            modifier = Modifier.weight(1f)
        ) {
            Text("\u2190 Older")
        }
        Button(
            onClick = onLatest,
            enabled = currentMonitorIndex != 0,
            modifier = Modifier.weight(1f)
        ) {
            Text("Latest \u2192|")
        }
        OutlinedButton(
            onClick = onPrevious,
            enabled = currentMonitorIndex > 0,
            modifier = Modifier.weight(1f)
        ) {
            Text("Newer \u2192")
        }
    }
}
