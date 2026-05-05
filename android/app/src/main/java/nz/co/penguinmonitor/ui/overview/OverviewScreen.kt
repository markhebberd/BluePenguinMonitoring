package nz.co.penguinmonitor.ui.overview

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
// PaddingValues no longer needed
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Checkbox
// Grid replaced with manual rows for single-page scroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import nz.co.penguinmonitor.ui.overview.components.BoxSummaryCard
import nz.co.penguinmonitor.ui.overview.components.BreedingDatesTimeline
import nz.co.penguinmonitor.ui.overview.components.FilterPanel
import nz.co.penguinmonitor.ui.overview.components.MonitorNavigationBar

@Composable
fun OverviewScreen(
    onBoxSelected: (String) -> Unit = {},
    viewModel: OverviewViewModel = hiltViewModel()
) {
    val settings by viewModel.settings.collectAsState()
    val boxCards by viewModel.filteredBoxCards.collectAsState()
    val breedingDates by viewModel.breedingDates.collectAsState()
    val showDifferences by viewModel.showDifferences.collectAsState()

    var showFilters by remember { mutableStateOf(settings.showFiltersVisible) }
    var hideFilters by remember { mutableStateOf(settings.hideFiltersVisible) }

    Column(modifier = Modifier.fillMaxWidth()) {
        // Monitor navigation
        MonitorNavigationBar(
            currentMonitorIndex = settings.currentlyVisibleMonitor,
            onPrevious = { viewModel.previousMonitor() },
            onLatest = { viewModel.showLatestMonitor() },
            onNext = { viewModel.nextMonitor() }
        )

        // Filters
        FilterPanel(
            settings = settings,
            showFilters = showFilters,
            hideFilters = hideFilters,
            onToggleShowFilters = { showFilters = !showFilters },
            onToggleHideFilters = { hideFilters = !hideFilters },
            onUpdateFilter = { viewModel.updateFilter(it) },
            modifier = Modifier.padding(horizontal = 16.dp)
        )

        // Overview title + show differences
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(
                text = "Overview (${boxCards.size} boxes)",
                style = MaterialTheme.typography.titleMedium
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(
                    checked = showDifferences,
                    onCheckedChange = { viewModel.toggleShowDifferences() }
                )
                Text("Diff", fontSize = 12.sp)
            }
        }

        // Box grid - 3 columns (non-lazy for single-page scroll)
        val rows = boxCards.chunked(3)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            rows.forEach { row ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    row.forEach { card ->
                        BoxSummaryCard(
                            card = card,
                            onClick = { onBoxSelected(card.boxName) },
                            modifier = Modifier.weight(1f)
                        )
                    }
                    // Fill empty cells in last row
                    repeat(3 - row.size) {
                        Spacer(modifier = Modifier.weight(1f))
                    }
                }
            }
        }

        // Breeding dates timeline (conditional)
        if (settings.showBreedingDatesTimeline && breedingDates.isNotEmpty()) {
            Spacer(modifier = Modifier.height(8.dp))
            BreedingDatesTimeline(
                breedingDates = breedingDates,
                settings = settings,
                onBoxClick = { onBoxSelected(it) },
                onToggleHatching = { viewModel.updateFilter { s -> s.copy(showHatchingDatesInTimeline = it) } },
                onTogglePG = { viewModel.updateFilter { s -> s.copy(showPGDatesInTimeline = it) } },
                onToggleChipping = { viewModel.updateFilter { s -> s.copy(showChippingDatesInTimeline = it) } },
                onToggleFledging = { viewModel.updateFilter { s -> s.copy(showFledgingDatesInTimeline = it) } },
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
            )
        }
    }
}
