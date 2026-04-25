package nz.co.penguinmonitor.ui.singlebox

import android.widget.Toast
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import nz.co.penguinmonitor.ui.common.BoxNavigationBar
import nz.co.penguinmonitor.ui.common.ConfirmationDialog
import nz.co.penguinmonitor.ui.common.StatusBar
import nz.co.penguinmonitor.ui.common.StickyNotesDialog
import nz.co.penguinmonitor.ui.singlebox.components.BoxDataCard
import nz.co.penguinmonitor.ui.singlebox.components.BoxTagDeleteButton
import nz.co.penguinmonitor.ui.singlebox.components.HistoricalDataIndicator
import nz.co.penguinmonitor.ui.singlebox.components.LockToggle
import nz.co.penguinmonitor.ui.theme.DangerRed
import nz.co.penguinmonitor.ui.theme.PrimaryBlue
import nz.co.penguinmonitor.ui.theme.SuccessGreen
import nz.co.penguinmonitor.ui.theme.WarningYellow
import kotlin.math.abs

@Composable
fun SingleBoxScreen(
    onNavigateToBox: (String) -> Unit = {},
    viewModel: SingleBoxViewModel = hiltViewModel()
) {
    val context = LocalContext.current
    val settings by viewModel.settings.collectAsState()
    val bluetoothState by viewModel.bluetoothState.collectAsState()
    val locationState by viewModel.locationState.collectAsState()
    val currentBoxName by viewModel.currentBoxName.collectAsState()
    val isLocked by viewModel.isBoxLocked.collectAsState()
    val historicalIndex by viewModel.historicalDataIndex.collectAsState()
    val boxData by viewModel.currentBoxData.collectAsState()
    val scannedBirds by viewModel.scannedBirdsDisplay.collectAsState()
    val stickyNotes by viewModel.stickyNotes.collectAsState()
    val breedingStatus by viewModel.breedingStatusText.collectAsState()
    val currentBoxTag by viewModel.currentBoxTag.collectAsState()
    val toastMessage by viewModel.toastMessage.collectAsState()
    val dialogRequest by viewModel.dialogRequest.collectAsState()
    val isDownloading by viewModel.isDownloading.collectAsState()

    var showJumpDialog by remember { mutableStateOf(false) }
    var showStickyNotesDialog by remember { mutableStateOf(false) }
    var showMoveDialog by remember { mutableStateOf<Int?>(null) }
    var showDeleteScanConfirm by remember { mutableStateOf<Int?>(null) }
    var showClearBoxConfirm by remember { mutableStateOf(false) }
    var showClearAllConfirm by remember { mutableStateOf(false) }
    var showSaveLoadMenu by remember { mutableStateOf(false) }

    // Toast messages
    LaunchedEffect(toastMessage) {
        toastMessage?.let {
            Toast.makeText(context, it, Toast.LENGTH_SHORT).show()
            viewModel.clearToastMessage()
        }
    }

    // Swipe detection for historical data
    var dragAmount by remember { mutableFloatStateOf(0f) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .pointerInput(Unit) {
                detectHorizontalDragGestures(
                    onDragEnd = {
                        if (abs(dragAmount) > 100) {
                            // Vibrate on swipe (matches C# 50ms haptic)
                            @Suppress("DEPRECATION")
                            (context.getSystemService(android.content.Context.VIBRATOR_SERVICE) as? android.os.Vibrator)?.let {
                                if (android.os.Build.VERSION.SDK_INT >= 26) {
                                    it.vibrate(android.os.VibrationEffect.createOneShot(50, android.os.VibrationEffect.DEFAULT_AMPLITUDE))
                                }
                            }
                            if (dragAmount > 0) {
                                if (historicalIndex > 0) viewModel.setHistoricalIndex(historicalIndex - 1)
                            } else {
                                viewModel.setHistoricalIndex(historicalIndex + 1)
                            }
                        }
                        dragAmount = 0f
                    },
                    onHorizontalDrag = { _, delta -> dragAmount += delta }
                )
            }
    ) {
        StatusBar(bluetoothState = bluetoothState, locationState = locationState)

        // Top action buttons - matches C# layout
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            Button(
                onClick = { showClearAllConfirm = true },
                colors = ButtonDefaults.buttonColors(containerColor = DangerRed),
                modifier = Modifier.weight(1f)
            ) { Text("Clear all", fontSize = 12.sp) }

            Button(
                onClick = { showClearBoxConfirm = true },
                enabled = !isLocked,
                colors = ButtonDefaults.buttonColors(containerColor = WarningYellow),
                modifier = Modifier.weight(1f)
            ) { Text("Clear box", fontSize = 12.sp) }

            Button(
                onClick = { viewModel.downloadBirdStats() },
                enabled = !isDownloading,
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (isDownloading) WarningYellow else PrimaryBlue
                ),
                modifier = Modifier.weight(1f)
            ) { Text(if (isDownloading) "Loading..." else "Bird stats", fontSize = 12.sp) }

            Button(
                onClick = { showSaveLoadMenu = true },
                colors = ButtonDefaults.buttonColors(containerColor = SuccessGreen),
                modifier = Modifier.weight(1f)
            ) { Text("Save/Load", fontSize = 12.sp) }
        }

        // Lock toggle + box name
        LockToggle(
            isLocked = isLocked,
            boxName = currentBoxName,
            boxData = boxData,
            isHistorical = historicalIndex > 0,
            onToggle = { viewModel.toggleLock() }
        )

        HistoricalDataIndicator(historicalIndex = historicalIndex)

        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
        ) {
            BoxDataCard(
                boxData = boxData,
                scannedBirds = scannedBirds,
                stickyNotes = stickyNotes,
                breedingStatusText = breedingStatus,
                isEditable = !isLocked && historicalIndex == 0,
                onAdultsChanged = { viewModel.updateAdults(it) },
                onEggsChanged = { viewModel.updateEggs(it) },
                onChicksChanged = { viewModel.updateChicks(it) },
                onGateStatusChanged = { viewModel.updateGateStatus(it) },
                onBreedingChanceChanged = { viewModel.updateBreedingChance(it) },
                onNotesChanged = { viewModel.updateNotes(it) },
                onAddScan = { viewModel.addScannedId(it) },
                onDeleteScan = { showDeleteScanConfirm = it },
                onMoveScan = { showMoveDialog = it },
                onManageStickyNotes = { showStickyNotesDialog = true }
            )

            if (settings.showBoxTagDeleteButton && !isLocked) {
                Spacer(modifier = Modifier.height(8.dp))
                BoxTagDeleteButton(boxTag = currentBoxTag, onDelete = { viewModel.deleteBoxTag() })
            }

            Spacer(modifier = Modifier.height(16.dp))
        }

        BoxNavigationBar(
            isLocked = isLocked,
            onPrevBox = { viewModel.navigatePrevBox() },
            onSelectBox = { showJumpDialog = true },
            onNextBox = { viewModel.navigateNextBox() }
        )
    }

    // --- Dialogs ---

    // Dialog requests from ViewModel
    when (val req = dialogRequest) {
        is DialogRequest.HighOffspringConfirmation -> {
            ConfirmationDialog(
                title = "High Value Confirmation",
                message = req.message,
                confirmText = "OK",
                dismissText = "Cancel",
                onConfirm = { viewModel.confirmHighOffspringCount() },
                onDismiss = { viewModel.dismissDialog() }
            )
        }
        is DialogRequest.DataSummary -> {
            AlertDialog(
                onDismissRequest = { viewModel.dismissDialog() },
                title = { Text("Data Summary") },
                text = { Text(req.summary) },
                confirmButton = { TextButton(onClick = { viewModel.dismissDialog() }) { Text("OK") } }
            )
        }
        is DialogRequest.SaveFilename -> {
            var filename by remember { mutableStateOf(req.defaultName) }
            AlertDialog(
                onDismissRequest = { viewModel.dismissDialog() },
                title = { Text("Save to file") },
                text = {
                    OutlinedTextField(
                        value = filename,
                        onValueChange = { filename = it },
                        label = { Text("Filename") },
                        singleLine = true
                    )
                },
                confirmButton = {
                    TextButton(onClick = { viewModel.saveToFile(filename, req.upload) }) { Text("Save") }
                },
                dismissButton = {
                    TextButton(onClick = { viewModel.dismissDialog() }) { Text("Cancel") }
                }
            )
        }
        is DialogRequest.FileSelection -> {
            AlertDialog(
                onDismissRequest = { viewModel.dismissDialog() },
                title = { Text("Load from file") },
                text = {
                    LazyColumn {
                        items(req.files) { file ->
                            TextButton(
                                onClick = { viewModel.loadFromFile(file.path) },
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Column(modifier = Modifier.fillMaxWidth()) {
                                    Text(file.name, fontSize = 14.sp)
                                    Text("${file.size / 1024}KB - ${java.text.SimpleDateFormat("d MMM yyyy HH:mm", java.util.Locale.getDefault()).format(java.util.Date(file.lastModified))}", fontSize = 11.sp)
                                }
                            }
                        }
                    }
                },
                confirmButton = {
                    TextButton(onClick = { viewModel.dismissDialog() }) { Text("Cancel") }
                }
            )
        }
        is DialogRequest.DeletionReason -> {
            var reason by remember { mutableStateOf("") }
            AlertDialog(
                onDismissRequest = { viewModel.dismissDialog() },
                title = { Text("Delete monitoring session") },
                text = {
                    OutlinedTextField(
                        value = reason,
                        onValueChange = { reason = it },
                        label = { Text("Reason for deletion") },
                        minLines = 2
                    )
                },
                confirmButton = {
                    TextButton(onClick = { viewModel.deleteMonitor(req.monitorIndex, reason) }) { Text("Delete") }
                },
                dismissButton = {
                    TextButton(onClick = { viewModel.dismissDialog() }) { Text("Cancel") }
                }
            )
        }
        is DialogRequest.EmptyBoxConfirmation -> {
            ConfirmationDialog(
                title = "Empty box",
                message = "No data recorded for box ${req.boxName}. Lock anyway?",
                onConfirm = { viewModel.dismissDialog(); viewModel.toggleLock() },
                onDismiss = { viewModel.dismissDialog() }
            )
        }
        null -> { }
    }

    // Jump to box dialog
    if (showJumpDialog) {
        var jumpInput by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { showJumpDialog = false },
            title = { Text("Go to box") },
            text = {
                OutlinedTextField(
                    value = jumpInput,
                    onValueChange = { jumpInput = it },
                    label = { Text("Box name/number") },
                    singleLine = true
                )
            },
            confirmButton = {
                TextButton(onClick = { viewModel.navigateToBox(jumpInput.trim()); showJumpDialog = false }) { Text("Go") }
            },
            dismissButton = {
                TextButton(onClick = { showJumpDialog = false }) { Text("Cancel") }
            }
        )
    }

    // Move scan dialog
    showMoveDialog?.let { scanIdx ->
        var targetBox by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { showMoveDialog = null },
            title = { Text("Move bird to box") },
            text = {
                OutlinedTextField(
                    value = targetBox,
                    onValueChange = { targetBox = it },
                    label = { Text("Target box") },
                    singleLine = true
                )
            },
            confirmButton = {
                TextButton(onClick = { viewModel.moveScanToBox(scanIdx, targetBox.trim()); showMoveDialog = null }) { Text("Move") }
            },
            dismissButton = {
                TextButton(onClick = { showMoveDialog = null }) { Text("Cancel") }
            }
        )
    }

    // Delete scan confirmation
    showDeleteScanConfirm?.let { scanIdx ->
        ConfirmationDialog(
            title = "Delete scan",
            message = "Remove this scanned bird?",
            confirmText = "Delete",
            onConfirm = { viewModel.removeScannedId(scanIdx); showDeleteScanConfirm = null },
            onDismiss = { showDeleteScanConfirm = null }
        )
    }

    // Clear box confirmation
    if (showClearBoxConfirm) {
        ConfirmationDialog(
            title = "Clear box data",
            message = "Clear all data for box $currentBoxName?",
            confirmText = "Clear",
            onConfirm = { viewModel.clearCurrentBoxData(); showClearBoxConfirm = false },
            onDismiss = { showClearBoxConfirm = false }
        )
    }

    // Clear all confirmation
    if (showClearAllConfirm) {
        ConfirmationDialog(
            title = "Clear all data",
            message = "Clear all current monitoring data? This cannot be undone.",
            confirmText = "Clear All",
            onConfirm = { viewModel.clearAllCurrentData(); showClearAllConfirm = false },
            onDismiss = { showClearAllConfirm = false }
        )
    }

    // Save/Load menu
    if (showSaveLoadMenu) {
        AlertDialog(
            onDismissRequest = { showSaveLoadMenu = false },
            title = { Text("Save / Load") },
            text = {
                Column {
                    TextButton(onClick = { showSaveLoadMenu = false; viewModel.showDataSummary() },
                        modifier = Modifier.fillMaxWidth()) { Text("Data summary") }
                    TextButton(onClick = { showSaveLoadMenu = false; viewModel.showSaveDialog(false) },
                        modifier = Modifier.fillMaxWidth()) { Text("Save to file") }
                    TextButton(onClick = { showSaveLoadMenu = false; viewModel.showSaveDialog(true) },
                        modifier = Modifier.fillMaxWidth()) { Text("Save + upload to server") }
                    TextButton(onClick = { showSaveLoadMenu = false; viewModel.showLoadFromFileDialog() },
                        modifier = Modifier.fillMaxWidth()) { Text("Load from device") }
                    TextButton(onClick = { showSaveLoadMenu = false; viewModel.loadFromServer() },
                        modifier = Modifier.fillMaxWidth()) { Text("Load from server") }
                }
            },
            confirmButton = {
                TextButton(onClick = { showSaveLoadMenu = false }) { Text("Cancel") }
            }
        )
    }

    // Sticky notes dialog
    if (showStickyNotesDialog) {
        val notes = stickyNotes.split(" ").filter { it.isNotBlank() }
        StickyNotesDialog(
            currentNotes = notes,
            onAddNote = { viewModel.addStickyNote(it) },
            onRemoveNote = { viewModel.removeStickyNote(it) },
            onDismiss = { showStickyNotesDialog = false }
        )
    }
}
