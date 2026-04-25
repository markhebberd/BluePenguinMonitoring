package nz.co.penguinmonitor.ui.singlebox.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import nz.co.penguinmonitor.model.LifeStage
import nz.co.penguinmonitor.ui.singlebox.ScannedBirdDisplay
import nz.co.penguinmonitor.ui.theme.ChickBackground
import nz.co.penguinmonitor.ui.theme.FemaleBackground
import nz.co.penguinmonitor.ui.theme.MaleBackground
import nz.co.penguinmonitor.ui.theme.ScanRowEven
import nz.co.penguinmonitor.ui.theme.ScanRowOdd
import nz.co.penguinmonitor.ui.theme.TextSecondary
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

@Composable
fun ScannedBirdsList(
    birds: List<ScannedBirdDisplay>,
    isEditable: Boolean,
    onDeleteScan: (Int) -> Unit,
    onMoveScan: (Int) -> Unit,
    modifier: Modifier = Modifier
) {
    Column(modifier = modifier.fillMaxWidth()) {
        Text(
            text = "Scanned birds (${birds.size})",
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier.padding(bottom = 4.dp)
        )

        birds.forEach { bird ->
            val bgColor = getBirdBackground(bird)
            val lifeStageIcon = getLifeStageIcon(bird)
            val localTime = bird.scanRecord.timestamp.toLocalDateTime(TimeZone.currentSystemDefault())

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(bgColor, RoundedCornerShape(4.dp))
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = "$lifeStageIcon ${bird.scanRecord.birdId}",
                            style = MaterialTheme.typography.bodyMedium
                        )
                        bird.penguinData?.let { pd ->
                            if (pd.sex.isNotBlank()) {
                                Text(
                                    text = " (${pd.sex})",
                                    fontSize = 12.sp,
                                    color = TextSecondary
                                )
                            }
                            if (pd.vidForScanner.isNotBlank()) {
                                Text(
                                    text = " VID:${pd.vidForScanner}",
                                    fontSize = 11.sp,
                                    color = TextSecondary
                                )
                            }
                        }
                    }
                    Text(
                        text = "${localTime.hour}:${localTime.minute.toString().padStart(2, '0')}",
                        fontSize = 11.sp,
                        color = TextSecondary
                    )
                }

                if (isEditable) {
                    Row {
                        IconButton(onClick = { onMoveScan(bird.index) }) {
                            Icon(Icons.Default.SwapHoriz, "Move", modifier = Modifier.padding(4.dp))
                        }
                        IconButton(onClick = { onDeleteScan(bird.index) }) {
                            Icon(Icons.Default.Delete, "Delete", modifier = Modifier.padding(4.dp))
                        }
                    }
                }
            }
        }
    }
}

private fun getBirdBackground(bird: ScannedBirdDisplay): Color {
    val pd = bird.penguinData ?: return if (bird.index % 2 == 0) ScanRowEven else ScanRowOdd
    return when {
        pd.lastKnownLifeStage == LifeStage.Chick -> ChickBackground
        pd.sex.equals("F", ignoreCase = true) || pd.sex.equals("Female", ignoreCase = true) -> FemaleBackground
        pd.sex.equals("M", ignoreCase = true) || pd.sex.equals("Male", ignoreCase = true) -> MaleBackground
        else -> if (bird.index % 2 == 0) ScanRowEven else ScanRowOdd
    }
}

private fun getLifeStageIcon(bird: ScannedBirdDisplay): String {
    val pd = bird.penguinData ?: return ""
    return when {
        pd.lastKnownLifeStage == LifeStage.Returnee ||
        pd.chipAs.contains("chick", ignoreCase = true) -> "\uD83D\uDD04" // 🔄
        pd.lastKnownLifeStage == LifeStage.Chick -> "\uD83D\uDC23" // 🐣
        pd.sex.equals("F", ignoreCase = true) -> "\uD83D\uDC27\u2640" // 🐧♀
        pd.sex.equals("M", ignoreCase = true) -> "\uD83D\uDC27\u2642" // 🐧♂
        else -> "\uD83D\uDC27" // 🐧
    }
}
