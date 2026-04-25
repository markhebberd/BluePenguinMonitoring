package nz.co.penguinmonitor.ui.common

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun BoxSetEditorDialog(
    currentBoxSetsString: String,
    onApply: (String) -> Unit,
    onDismiss: () -> Unit
) {
    var boxSetsText by remember { mutableStateOf(currentBoxSetsString) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Edit Box Sets") },
        text = {
            Column {
                Text(
                    text = "Format: {1-150,AA-AC},{N1-N6}",
                    fontSize = 12.sp,
                    modifier = Modifier.padding(bottom = 8.dp)
                )
                OutlinedTextField(
                    value = boxSetsText,
                    onValueChange = { boxSetsText = it },
                    label = { Text("Box sets definition") },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 3
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onApply(boxSetsText) }) {
                Text("Apply")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        }
    )
}
