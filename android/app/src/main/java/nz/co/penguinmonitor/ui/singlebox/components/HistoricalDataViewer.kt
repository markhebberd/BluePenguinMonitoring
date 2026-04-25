package nz.co.penguinmonitor.ui.singlebox.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import nz.co.penguinmonitor.ui.theme.TextSecondary

@Composable
fun HistoricalDataIndicator(
    historicalIndex: Int,
    modifier: Modifier = Modifier
) {
    if (historicalIndex > 0) {
        Column(
            modifier = modifier
                .fillMaxWidth()
                .padding(8.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                text = "Viewing historical data (#$historicalIndex)",
                color = TextSecondary,
                fontSize = 12.sp
            )
            Text(
                text = "Swipe left/right to browse \u2022 Read-only",
                color = TextSecondary,
                fontSize = 11.sp
            )
        }
    }
}
