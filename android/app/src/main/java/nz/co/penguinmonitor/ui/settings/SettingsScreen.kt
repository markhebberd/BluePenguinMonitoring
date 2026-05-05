package nz.co.penguinmonitor.ui.settings

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import nz.co.penguinmonitor.ui.common.BoxSetEditorDialog
import nz.co.penguinmonitor.ui.common.StatusBar
import nz.co.penguinmonitor.ui.theme.WarningYellow
import java.util.Calendar

@Composable
fun SettingsScreen(
    viewModel: SettingsViewModel = hiltViewModel()
) {
    val context = LocalContext.current
    val settings by viewModel.settings.collectAsState()
    val bluetoothState by viewModel.bluetoothState.collectAsState()
    val locationState by viewModel.locationState.collectAsState()
    val isSyncing by viewModel.isSyncing.collectAsState()
    val editBoxTagsMode by viewModel.editBoxTagsMode.collectAsState()
    val syncStatusMessage by viewModel.syncStatusMessage.collectAsState()

    var expanded by remember { mutableStateOf(false) }
    var showBoxSetEditor by remember { mutableStateOf(false) }

    Card(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)) {
        Column(modifier = Modifier.padding(12.dp)) {
            // Title row with expand/collapse - always visible
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded }
            ) {
                Icon(
                    if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                    contentDescription = "Toggle settings"
                )
                Text("Penguin Nestcheck", fontSize = 20.sp, fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary, modifier = Modifier.weight(1f).padding(start = 8.dp))
                Text("Version: 37.34", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }

            // Status bar - always visible
            StatusBar(bluetoothState = bluetoothState, locationState = locationState)

            // Collapsible settings content
            AnimatedVisibility(visible = expanded) {
                Column {
                    Spacer(modifier = Modifier.height(8.dp))

                    // Bluetooth toggle
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = settings.isBluetoothEnabled, onCheckedChange = { viewModel.toggleBluetooth(it) })
                        Text("Enable Bluetooth (HR5 Reader)", fontSize = 14.sp)
                    }

                    // Active session timestamp with date/time picker
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = settings.activeSessionTimeStampActive,
                            onCheckedChange = { active ->
                                if (active) {
                                    val cal = Calendar.getInstance()
                                    DatePickerDialog(context, { _, year, month, day ->
                                        TimePickerDialog(context, { _, hour, minute ->
                                            cal.set(year, month, day, hour, minute)
                                            viewModel.updateActiveSessionTimestamp(
                                                kotlinx.datetime.Instant.fromEpochMilliseconds(cal.timeInMillis), true)
                                        }, cal.get(Calendar.HOUR_OF_DAY), cal.get(Calendar.MINUTE), true).show()
                                    }, cal.get(Calendar.YEAR), cal.get(Calendar.MONTH), cal.get(Calendar.DAY_OF_MONTH)).show()
                                } else {
                                    viewModel.updateActiveSessionTimestamp(null, false)
                                }
                            }
                        )
                        Text("Set time for monitor", fontSize = 14.sp)
                    }
                    if (settings.activeSessionTimeStampActive && settings.activeSessionLocalTimeStamp != null) {
                        val dt = java.time.Instant.ofEpochSecond(settings.activeSessionLocalTimeStamp!!.epochSeconds)
                            .atZone(java.time.ZoneId.systemDefault())
                        Text("Session: ${dt.format(java.time.format.DateTimeFormatter.ofPattern("HH:mm, d MMM yyyy"))}",
                            fontSize = 12.sp, modifier = Modifier.padding(start = 48.dp))
                    }

                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = settings.showBoxTagDeleteButton, onCheckedChange = { viewModel.toggleShowBoxTagDeleteButton(it) })
                        Text("Show box tag delete button", fontSize = 14.sp)
                    }

                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = settings.showBreedingDatesTimeline, onCheckedChange = { viewModel.updateTimelineSettings(showTimeline = it) })
                        Text("Show differences with previous monitor", fontSize = 14.sp)
                    }

                    Spacer(modifier = Modifier.height(8.dp))

                    OutlinedButton(
                        onClick = { viewModel.toggleEditBoxTagsMode() },
                        colors = if (editBoxTagsMode) ButtonDefaults.outlinedButtonColors(containerColor = WarningYellow) else ButtonDefaults.outlinedButtonColors(),
                        modifier = Modifier.fillMaxWidth()
                    ) { Text(if (editBoxTagsMode) "Exit Box Tags Mode" else "Edit Box Tags Mode") }

                    Spacer(modifier = Modifier.height(8.dp))

                    OutlinedButton(onClick = { showBoxSetEditor = true }, modifier = Modifier.fillMaxWidth()) {
                        Text("Edit Box Sets")
                    }
                    if (settings.allBoxSetsString.isNotBlank()) {
                        Text("Current: ${settings.allBoxSetsString}", fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    Button(onClick = { viewModel.downloadRemoteData() }, enabled = !isSyncing, modifier = Modifier.fillMaxWidth()) {
                        Text(if (isSyncing) "Downloading..." else "Download Remote Data")
                    }

                    syncStatusMessage?.let { Text(it, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp)) }
                }
            }
        }
    }

    if (showBoxSetEditor) {
        BoxSetEditorDialog(
            currentBoxSetsString = settings.allBoxSetsString,
            onApply = { viewModel.updateBoxSets(it); showBoxSetEditor = false },
            onDismiss = { showBoxSetEditor = false }
        )
    }
}
