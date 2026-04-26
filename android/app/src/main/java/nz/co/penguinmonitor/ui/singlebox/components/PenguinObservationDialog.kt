package nz.co.penguinmonitor.ui.singlebox.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import nz.co.penguinmonitor.ui.singlebox.ScannedBirdDisplay
import nz.co.penguinmonitor.ui.theme.WarningYellow

data class BiometricData(
    val isMoulting: Boolean = false,
    val weight: String = "",
    val sex: String = "",
    val leftFlipperLength: String = "",
    val rightFlipperLength: String = "",
    val bodyLength: String = "",
    val beakLength: String = "",
    val conditionHealthy: Boolean = false,
    val conditionUnderweight: Boolean = false,
    val conditionTicks: Boolean = false,
    val conditionDead: Boolean = false,
    val conditionDogAttacked: Boolean = false,
    val conditionAttacked: Boolean = false,
    val notes: String = ""
)

@Composable
fun PenguinObservationDialog(
    bird: ScannedBirdDisplay,
    onSave: (BiometricData) -> Unit,
    onDismiss: () -> Unit
) {
    var data by remember { mutableStateOf(BiometricData()) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text("Penguin ${bird.scanRecord.birdId}", fontWeight = FontWeight.Bold)
        },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                // isMoulting - prominent at top
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text("Moulting", fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    Switch(
                        checked = data.isMoulting,
                        onCheckedChange = { data = data.copy(isMoulting = it) }
                    )
                }

                Spacer(modifier = Modifier.height(4.dp))

                // Weight
                OutlinedTextField(
                    value = data.weight,
                    onValueChange = { data = data.copy(weight = it) },
                    label = { Text("Weight (g)") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal)
                )

                // Sex
                OutlinedTextField(
                    value = data.sex,
                    onValueChange = { data = data.copy(sex = it) },
                    label = { Text("Sex (M/F)") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true
                )

                // Flipper lengths
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = data.leftFlipperLength,
                        onValueChange = { data = data.copy(leftFlipperLength = it) },
                        label = { Text("L flipper (mm)") },
                        modifier = Modifier.weight(1f),
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal)
                    )
                    OutlinedTextField(
                        value = data.rightFlipperLength,
                        onValueChange = { data = data.copy(rightFlipperLength = it) },
                        label = { Text("R flipper (mm)") },
                        modifier = Modifier.weight(1f),
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal)
                    )
                }

                // Body + beak
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = data.bodyLength,
                        onValueChange = { data = data.copy(bodyLength = it) },
                        label = { Text("Body (mm)") },
                        modifier = Modifier.weight(1f),
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal)
                    )
                    OutlinedTextField(
                        value = data.beakLength,
                        onValueChange = { data = data.copy(beakLength = it) },
                        label = { Text("Beak (mm)") },
                        modifier = Modifier.weight(1f),
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal)
                    )
                }

                // Condition checkboxes
                Text("Condition", fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
                ConditionCheck("Healthy", data.conditionHealthy) { data = data.copy(conditionHealthy = it) }
                ConditionCheck("Underweight", data.conditionUnderweight) { data = data.copy(conditionUnderweight = it) }
                ConditionCheck("Ticks", data.conditionTicks) { data = data.copy(conditionTicks = it) }
                ConditionCheck("Dead", data.conditionDead) { data = data.copy(conditionDead = it) }
                ConditionCheck("Dog attacked", data.conditionDogAttacked) { data = data.copy(conditionDogAttacked = it) }
                ConditionCheck("Attacked", data.conditionAttacked) { data = data.copy(conditionAttacked = it) }

                // Notes
                OutlinedTextField(
                    value = data.notes,
                    onValueChange = { data = data.copy(notes = it) },
                    label = { Text("Notes") },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2
                )
            }
        },
        confirmButton = {
            Button(onClick = { onSave(data) }) { Text("Save") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        }
    )
}

@Composable
private fun ConditionCheck(label: String, checked: Boolean, onChanged: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = checked, onCheckedChange = onChanged)
        Text(label, fontSize = 14.sp)
    }
}
