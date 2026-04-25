package nz.co.penguinmonitor.ui.overview.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import nz.co.penguinmonitor.ui.overview.BoxCardDisplay
import nz.co.penguinmonitor.ui.theme.BoxCardGreen
import nz.co.penguinmonitor.ui.theme.BoxCardRed
import nz.co.penguinmonitor.ui.theme.BoxCardYellow
import nz.co.penguinmonitor.ui.theme.BorderColor
import nz.co.penguinmonitor.ui.theme.TextSecondary

@Composable
fun BoxSummaryCard(
    card: BoxCardDisplay,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val borderColor = when {
        card.hasChanged -> BoxCardRed
        card.boxData != null -> BoxCardGreen
        else -> BoxCardYellow
    }
    val borderWidth = if (card.hasChanged || card.boxData == null) 3.dp else 1.dp

    Card(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        border = BorderStroke(borderWidth, borderColor),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(8.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // Box name
            Text(
                text = card.boxName,
                style = MaterialTheme.typography.titleMedium,
                textAlign = TextAlign.Center
            )

            // Emoji summary
            val emojiLine = "${card.adultsEmoji}${card.eggsEmoji}${card.chicksEmoji}"
            if (emojiLine.isNotBlank()) {
                Text(
                    text = emojiLine,
                    fontSize = 14.sp,
                    textAlign = TextAlign.Center
                )
            }

            // Breeding chance
            if (!card.breedingChance.isNullOrBlank() && card.breedingChance != "BR") {
                Text(
                    text = card.breedingChance,
                    fontSize = 11.sp,
                    color = TextSecondary,
                    textAlign = TextAlign.Center
                )
            }

            // Breeding status text
            if (card.breedingStatusText.isNotBlank()) {
                Text(
                    text = card.breedingStatusText,
                    fontSize = 10.sp,
                    color = MaterialTheme.colorScheme.primary,
                    textAlign = TextAlign.Center
                )
            }

            // Notes preview
            if (card.notesPreview.isNotBlank()) {
                Text(
                    text = card.notesPreview,
                    fontSize = 10.sp,
                    color = TextSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center
                )
            }
        }
    }
}
