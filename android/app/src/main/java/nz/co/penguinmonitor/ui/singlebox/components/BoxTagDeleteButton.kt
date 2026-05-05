package nz.co.penguinmonitor.ui.singlebox.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import nz.co.penguinmonitor.model.BoxTag
import nz.co.penguinmonitor.ui.common.ConfirmationDialog
import nz.co.penguinmonitor.ui.theme.DangerRed

@Composable
fun BoxTagDeleteButton(
    boxTag: BoxTag?,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier
) {
    if (boxTag == null) return

    var showConfirm by remember { mutableStateOf(false) }

    Button(
        onClick = { showConfirm = true },
        colors = ButtonDefaults.buttonColors(containerColor = DangerRed),
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
    ) {
        Text("Delete Box Tag: ${boxTag.tagNumber.takeLast(8)}")
    }

    if (showConfirm) {
        ConfirmationDialog(
            title = "Delete Box Tag",
            message = "Remove tag ${boxTag.tagNumber.takeLast(8)} from box ${boxTag.boxId}?",
            confirmText = "Delete",
            onConfirm = {
                onDelete()
                showConfirm = false
            },
            onDismiss = { showConfirm = false }
        )
    }
}
