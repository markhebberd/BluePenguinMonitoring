package nz.co.penguinmonitor.ui.overview.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import nz.co.penguinmonitor.ui.overview.BoxCardDisplay
import nz.co.penguinmonitor.ui.overview.CardBorder
import nz.co.penguinmonitor.ui.theme.PrimaryBlue
import nz.co.penguinmonitor.ui.theme.DangerRed
import nz.co.penguinmonitor.ui.theme.WarningYellow
import nz.co.penguinmonitor.ui.theme.BorderColor

@Composable
fun BoxSummaryCard(
    card: BoxCardDisplay,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val borderColor = when (card.border) {
        CardBorder.RED_THICK -> DangerRed
        CardBorder.BLUE_THICK -> PrimaryBlue
        CardBorder.YELLOW_THICK -> WarningYellow
        CardBorder.DEFAULT -> BorderColor
    }
    val borderWidth = when (card.border) {
        CardBorder.DEFAULT -> 1.dp
        else -> 3.dp
    }
    val bgColor = if (card.isSelected) WarningYellow.copy(alpha = 0.3f) else Color.White

    Card(
        modifier = modifier.fillMaxWidth().clickable(onClick = onClick),
        border = BorderStroke(borderWidth, borderColor),
        colors = CardDefaults.cardColors(containerColor = bgColor)
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(5.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // "Box N" - bold 18sp black
            Text(
                text = "Box ${card.boxName}",
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                color = Color.Black,
                textAlign = TextAlign.Center
            )

            if (card.boxData == null) return@Column

            // Emoji + previous + breeding chance
            val summaryText = buildString {
                append(card.emojiLine)
                append(card.previousEmoji)
                if (card.showBreedingChance && !card.breedingChance.isNullOrBlank()) {
                    append(card.breedingChance)
                }
            }
            if (summaryText.isNotBlank()) {
                Text(text = summaryText, fontSize = 14.sp, color = Color.Black, textAlign = TextAlign.Center)
            }

            // Breeding status (calculated dates)
            if (card.breedingStatusText.isNotBlank()) {
                Text(text = card.breedingStatusText, fontSize = 14.sp, color = Color.Black, textAlign = TextAlign.Center)
            }

            // Gate + notes + sticky notes
            if (card.bottomLine.isNotBlank()) {
                Text(text = card.bottomLine, fontSize = 14.sp, color = Color.DarkGray,
                    textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
