package nz.co.penguinmonitor.ui.singlebox.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import nz.co.penguinmonitor.model.BoxData
import nz.co.penguinmonitor.model.BreedingStatus
import nz.co.penguinmonitor.ui.singlebox.ScannedBirdDisplay

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BoxDataCard(
    boxData: BoxData?,
    scannedBirds: List<ScannedBirdDisplay>,
    stickyNotes: String,
    breedingStatusText: String,
    isEditable: Boolean,
    onAdultsChanged: (Int) -> Unit,
    onEggsChanged: (Int) -> Unit,
    onChicksChanged: (Int) -> Unit,
    onGateStatusChanged: (String?) -> Unit,
    onBreedingChanceChanged: (String?) -> Unit,
    onNotesChanged: (String) -> Unit,
    onAddScan: (String) -> Unit,
    onDeleteScan: (Int) -> Unit,
    onMoveScan: (Int) -> Unit,
    onManageStickyNotes: () -> Unit,
    modifier: Modifier = Modifier
) {
    val data = boxData ?: BoxData()

    Card(modifier = modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            // Sticky notes indicator
            if (stickyNotes.isNotBlank()) {
                Text(
                    text = "Sticky: $stickyNotes",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(bottom = 8.dp)
                )
            }

            // Scanned birds
            ScannedBirdsList(
                birds = scannedBirds,
                isEditable = isEditable,
                onDeleteScan = onDeleteScan,
                onMoveScan = onMoveScan
            )

            // Manual scan entry
            if (isEditable) {
                ManualScanEntry(onAddScan = onAddScan)
            }

            Spacer(modifier = Modifier.height(16.dp))

            // Data fields row: Adults | Eggs | Chicks
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                NumberField(
                    label = "Adults",
                    value = data.adults,
                    onValueChange = onAdultsChanged,
                    enabled = isEditable,
                    modifier = Modifier.weight(1f)
                )
                NumberField(
                    label = "Eggs",
                    value = data.eggs,
                    onValueChange = onEggsChanged,
                    enabled = isEditable,
                    modifier = Modifier.weight(1f)
                )
                NumberField(
                    label = "Chicks",
                    value = data.chicks,
                    onValueChange = onChicksChanged,
                    enabled = isEditable,
                    modifier = Modifier.weight(1f)
                )
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Breeding chance + Gate status dropdowns
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                DropdownField(
                    label = "Confidence",
                    value = data.breedingChance ?: "",
                    options = BreedingStatus.spinnerOptions,
                    onValueChange = { onBreedingChanceChanged(it.ifBlank { null }) },
                    enabled = isEditable,
                    modifier = Modifier.weight(1f)
                )
                DropdownField(
                    label = "Gate",
                    value = data.gateStatus ?: "",
                    options = BreedingStatus.gateStatusOptions,
                    onValueChange = { onGateStatusChanged(it.ifBlank { null }) },
                    enabled = isEditable,
                    modifier = Modifier.weight(1f)
                )
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Notes
            OutlinedTextField(
                value = data.notes,
                onValueChange = onNotesChanged,
                label = { Text("Notes") },
                modifier = Modifier.fillMaxWidth(),
                enabled = isEditable,
                minLines = 2
            )

            // Manage sticky notes button
            if (isEditable) {
                TextButton(onClick = onManageStickyNotes) {
                    Text("Manage Sticky Notes")
                }
            }

            // Breeding status
            if (breedingStatusText.isNotBlank()) {
                Text(
                    text = breedingStatusText,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(top = 8.dp)
                )
            }
        }
    }
}

@Composable
private fun NumberField(
    label: String,
    value: Int,
    onValueChange: (Int) -> Unit,
    enabled: Boolean,
    modifier: Modifier = Modifier
) {
    // Select all text on focus (matches C# click-selects-all behavior)
    var textFieldValue by remember(value) {
        mutableStateOf(androidx.compose.ui.text.input.TextFieldValue(
            text = value.toString(),
            selection = androidx.compose.ui.text.TextRange(0, value.toString().length)
        ))
    }
    OutlinedTextField(
        value = textFieldValue,
        onValueChange = { tfv ->
            textFieldValue = tfv
            val num = tfv.text.filter { it.isDigit() }.toIntOrNull() ?: 0
            onValueChange(num)
        },
        label = { Text(label) },
        modifier = modifier,
        enabled = enabled,
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DropdownField(
    label: String,
    value: String,
    options: List<String>,
    onValueChange: (String) -> Unit,
    enabled: Boolean,
    modifier: Modifier = Modifier
) {
    var expanded by remember { mutableStateOf(false) }

    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { if (enabled) expanded = !expanded },
        modifier = modifier
    ) {
        OutlinedTextField(
            value = value.ifBlank { "-" },
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.menuAnchor().fillMaxWidth(),
            enabled = enabled,
            singleLine = true
        )
        ExposedDropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false }
        ) {
            options.forEach { option ->
                DropdownMenuItem(
                    text = { Text(option.ifBlank { "None" }) },
                    onClick = {
                        onValueChange(option)
                        expanded = false
                    }
                )
            }
        }
    }
}
