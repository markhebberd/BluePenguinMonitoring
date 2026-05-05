package nz.co.penguinmonitor.ui.overview.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import nz.co.penguinmonitor.model.AppSettings
import nz.co.penguinmonitor.model.BoxPredictedDates
import nz.co.penguinmonitor.ui.theme.TextSecondary
import java.time.LocalDate
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun BreedingDatesTimeline(
    breedingDates: Map<String, BoxPredictedDates>,
    settings: AppSettings,
    onBoxClick: (String) -> Unit,
    onToggleHatching: (Boolean) -> Unit,
    onTogglePG: (Boolean) -> Unit,
    onToggleChipping: (Boolean) -> Unit,
    onToggleFledging: (Boolean) -> Unit,
    modifier: Modifier = Modifier
) {
    Card(modifier = modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = "Next breeding dates",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(bottom = 8.dp)
            )

            // Filter checkboxes
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TimelineFilter("Hatch", settings.showHatchingDatesInTimeline, onToggleHatching)
                TimelineFilter("PG", settings.showPGDatesInTimeline, onTogglePG)
                TimelineFilter("Chip", settings.showChippingDatesInTimeline, onToggleChipping)
                TimelineFilter("Fledge", settings.showFledgingDatesInTimeline, onToggleFledging)
            }

            // Build timeline entries
            data class TimelineEntry(val date: LocalDate, val boxNumber: Int, val milestone: String)

            val entries = mutableListOf<TimelineEntry>()
            val today = LocalDate.now()
            val formatter = DateTimeFormatter.ofPattern("d/M/yyyy")

            for ((_, dates) in breedingDates) {
                try {
                    if (settings.showHatchingDatesInTimeline && dates.estHatchDate.isNotBlank()) {
                        val d = LocalDate.parse(dates.estHatchDate, formatter)
                        if (!d.isBefore(today)) entries.add(TimelineEntry(d, dates.boxNumber, "Hatches"))
                    }
                    if (settings.showPGDatesInTimeline && dates.estPGDate.isNotBlank()) {
                        val d = LocalDate.parse(dates.estPGDate, formatter)
                        if (!d.isBefore(today)) entries.add(TimelineEntry(d, dates.boxNumber, "PG"))
                    }
                    if (settings.showChippingDatesInTimeline && dates.chipWindowStart.isNotBlank()) {
                        val d = LocalDate.parse(dates.chipWindowStart, formatter)
                        if (!d.isBefore(today)) entries.add(TimelineEntry(d, dates.boxNumber, "Chip"))
                    }
                    if (settings.showFledgingDatesInTimeline && dates.estFledgeDate.isNotBlank()) {
                        val d = LocalDate.parse(dates.estFledgeDate, formatter)
                        if (!d.isBefore(today)) entries.add(TimelineEntry(d, dates.boxNumber, "Fledge"))
                    }
                } catch (_: Exception) { }
            }

            val grouped = entries.sortedWith(compareBy({ it.date }, { it.boxNumber }))
                .groupBy { it.date }

            for ((date, dateEntries) in grouped) {
                Text(
                    text = date.format(DateTimeFormatter.ofPattern("d MMM")),
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.padding(top = 8.dp, bottom = 2.dp)
                )
                for (entry in dateEntries.sortedBy { it.boxNumber }) {
                    Text(
                        text = "Box ${entry.boxNumber}: ${entry.milestone}",
                        fontSize = 13.sp,
                        color = TextSecondary,
                        modifier = Modifier
                            .clickable { onBoxClick(entry.boxNumber.toString()) }
                            .padding(start = 16.dp, top = 2.dp, bottom = 2.dp)
                    )
                }
            }

            if (grouped.isEmpty()) {
                Text(
                    text = "No upcoming dates",
                    fontSize = 12.sp,
                    color = TextSecondary,
                    modifier = Modifier.padding(top = 8.dp)
                )
            }
        }
    }
}

@Composable
private fun TimelineFilter(label: String, checked: Boolean, onToggle: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = checked, onCheckedChange = onToggle)
        Text(label, fontSize = 13.sp)
    }
}
