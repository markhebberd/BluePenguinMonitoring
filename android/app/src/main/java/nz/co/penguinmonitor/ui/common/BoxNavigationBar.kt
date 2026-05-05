package nz.co.penguinmonitor.ui.common

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import nz.co.penguinmonitor.ui.theme.LightGray
import nz.co.penguinmonitor.ui.theme.TextSecondary

@Composable
fun BoxNavigationBar(
    isLocked: Boolean,
    onPrevBox: () -> Unit,
    onSelectBox: () -> Unit,
    onNextBox: () -> Unit,
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        OutlinedButton(
            onClick = onPrevBox,
            enabled = isLocked,
            modifier = Modifier.weight(1f)
        ) {
            Text("\u2190 Prev")
        }
        Button(
            onClick = onSelectBox,
            enabled = isLocked,
            modifier = Modifier.weight(1f)
        ) {
            Text("Select")
        }
        OutlinedButton(
            onClick = onNextBox,
            enabled = isLocked,
            modifier = Modifier.weight(1f)
        ) {
            Text("Next \u2192")
        }
    }
}
