package nz.co.penguinmonitor.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import nz.co.penguinmonitor.ui.common.BoxSetEditorDialog
import nz.co.penguinmonitor.ui.common.StatusBar
import nz.co.penguinmonitor.ui.theme.PrimaryBlue
import nz.co.penguinmonitor.ui.theme.WarningYellow

@Composable
fun SettingsScreen(
    viewModel: SettingsViewModel = hiltViewModel()
) {
    val settings by viewModel.settings.collectAsState()
    val bluetoothState by viewModel.bluetoothState.collectAsState()
    val locationState by viewModel.locationState.collectAsState()
    val isSyncing by viewModel.isSyncing.collectAsState()
    val editBoxTagsMode by viewModel.editBoxTagsMode.collectAsState()
    val syncStatusMessage by viewModel.syncStatusMessage.collectAsState()

    var showBoxSetEditor by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp)
    ) {
        StatusBar(bluetoothState = bluetoothState, locationState = locationState)

        Spacer(modifier = Modifier.height(8.dp))

        Card(
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = "Settings",
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.padding(bottom = 16.dp)
                )

                Text(
                    text = "v1.0",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )

                Spacer(modifier = Modifier.height(16.dp))

                // Bluetooth toggle
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Checkbox(
                        checked = settings.isBluetoothEnabled,
                        onCheckedChange = { viewModel.toggleBluetooth(it) }
                    )
                    Text("Enable Bluetooth (HR5 Reader)")
                }

                // Active session timestamp
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Checkbox(
                        checked = settings.activeSessionTimeStampActive,
                        onCheckedChange = { active ->
                            viewModel.updateActiveSessionTimestamp(
                                if (active) kotlinx.datetime.Clock.System.now() else null,
                                active
                            )
                        }
                    )
                    Text("Set time for monitor")
                }

                if (settings.activeSessionTimeStampActive && settings.activeSessionLocalTimeStamp != null) {
                    Text(
                        text = "Session: ${settings.activeSessionLocalTimeStamp}",
                        fontSize = 12.sp,
                        modifier = Modifier.padding(start = 48.dp)
                    )
                }

                // Show box tag delete button
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Checkbox(
                        checked = settings.showBoxTagDeleteButton,
                        onCheckedChange = { viewModel.toggleShowBoxTagDeleteButton(it) }
                    )
                    Text("Show box tag delete button")
                }

                // Show differences with previous monitor
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Checkbox(
                        checked = settings.showBreedingDatesTimeline,
                        onCheckedChange = { viewModel.updateTimelineSettings(showTimeline = it) }
                    )
                    Text("Show breeding dates timeline")
                }

                Spacer(modifier = Modifier.height(16.dp))

                // Edit Box Tags Mode
                OutlinedButton(
                    onClick = { viewModel.toggleEditBoxTagsMode() },
                    colors = if (editBoxTagsMode) {
                        ButtonDefaults.outlinedButtonColors(containerColor = WarningYellow)
                    } else {
                        ButtonDefaults.outlinedButtonColors()
                    },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(if (editBoxTagsMode) "Exit Box Tags Mode" else "Edit Box Tags Mode")
                }

                Spacer(modifier = Modifier.height(16.dp))

                // Box sets editor
                OutlinedButton(
                    onClick = { showBoxSetEditor = true },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text("Edit Box Sets")
                }

                if (settings.allBoxSetsString.isNotBlank()) {
                    Text(
                        text = "Current: ${settings.allBoxSetsString}",
                        fontSize = 12.sp,
                        modifier = Modifier.padding(top = 4.dp)
                    )
                }

                Spacer(modifier = Modifier.height(24.dp))

                // Download/sync button
                Button(
                    onClick = { viewModel.downloadRemoteData() },
                    enabled = !isSyncing,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(if (isSyncing) "Downloading..." else "Download Remote Data")
                }

                syncStatusMessage?.let { msg ->
                    Text(
                        text = msg,
                        fontSize = 12.sp,
                        modifier = Modifier.padding(top = 8.dp)
                    )
                }
            }
        }
    }

    if (showBoxSetEditor) {
        BoxSetEditorDialog(
            currentBoxSetsString = settings.allBoxSetsString,
            onApply = { newSets ->
                viewModel.updateBoxSets(newSets)
                showBoxSetEditor = false
            },
            onDismiss = { showBoxSetEditor = false }
        )
    }
}
