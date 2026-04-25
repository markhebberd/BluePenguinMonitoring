package nz.co.penguinmonitor.ui.singlebox.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import nz.co.penguinmonitor.model.BoxData
import nz.co.penguinmonitor.ui.theme.DangerRed
import nz.co.penguinmonitor.ui.theme.SuccessGreen
import nz.co.penguinmonitor.ui.theme.WarningYellow

@Composable
fun LockToggle(
    isLocked: Boolean,
    boxName: String,
    boxData: BoxData?,
    isHistorical: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier
) {
    val hasData = boxData != null && (boxData.scannedIds.isNotEmpty() ||
            boxData.adults > 0 || boxData.eggs > 0 || boxData.chicks > 0 ||
            boxData.notes.isNotBlank())

    val lockColor = when {
        !isLocked -> DangerRed
        hasData -> SuccessGreen
        else -> WarningYellow
    }

    val lockIcon = if (isLocked) Icons.Default.Lock else Icons.Default.LockOpen

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .clickable(enabled = !isHistorical) { onToggle() }
            .padding(8.dp)
    ) {
        Icon(
            imageVector = lockIcon,
            contentDescription = if (isLocked) "Locked" else "Unlocked",
            tint = lockColor,
            modifier = Modifier.size(24.dp)
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = "Box $boxName",
            style = MaterialTheme.typography.titleLarge
        )
    }
}
