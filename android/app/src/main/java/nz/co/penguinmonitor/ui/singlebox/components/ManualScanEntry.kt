package nz.co.penguinmonitor.ui.singlebox.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp

@Composable
fun ManualScanEntry(
    onAddScan: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    var manualInput by remember { mutableStateOf("") }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        OutlinedTextField(
            value = manualInput,
            onValueChange = { if (it.length <= 8) manualInput = it.filter { c -> c.isLetterOrDigit() } },
            label = { Text("Manual ID") },
            modifier = Modifier.weight(1f),
            singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters)
        )
        Button(
            onClick = {
                val cleaned = manualInput.filter { it.isLetterOrDigit() }
                if (cleaned.length == 8) {
                    onAddScan(cleaned)
                    manualInput = ""
                }
            },
            enabled = manualInput.filter { it.isLetterOrDigit() }.length == 8
        ) {
            Text("Add")
        }
    }
}
