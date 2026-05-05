package nz.co.penguinmonitor.ui.overview.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import nz.co.penguinmonitor.model.AppSettings

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun FilterPanel(
    settings: AppSettings,
    showFilters: Boolean,
    hideFilters: Boolean,
    onToggleShowFilters: () -> Unit,
    onToggleHideFilters: () -> Unit,
    onUpdateFilter: ((AppSettings) -> AppSettings) -> Unit,
    modifier: Modifier = Modifier
) {
    Column(modifier = modifier.fillMaxWidth()) {
        // Toggle buttons
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            TextButton(onClick = onToggleShowFilters) {
                Text(if (showFilters) "Hide Show Filters" else "Show Filters")
            }
            TextButton(onClick = onToggleHideFilters) {
                Text(if (hideFilters) "Hide Hide Filters" else "Hide Filters")
            }
        }

        // Show filters
        if (showFilters) {
            Text("Show:", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 4.dp))
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                FilterChip("All", settings.showAllBoxesInMultiBoxView) {
                    onUpdateFilter { it.copy(showAllBoxesInMultiBoxView = !it.showAllBoxesInMultiBoxView) }
                }
                FilterChip("Data", settings.showBoxesWithDataInMultiBoxView) {
                    onUpdateFilter { it.copy(showBoxesWithDataInMultiBoxView = !it.showBoxesWithDataInMultiBoxView) }
                }
                FilterChip("NO", settings.showNoBoxesInMultiBoxView) {
                    onUpdateFilter { it.copy(showNoBoxesInMultiBoxView = !it.showNoBoxesInMultiBoxView) }
                }
                FilterChip("UNL", settings.showUnlikleyBoxesInMultiBoxView) {
                    onUpdateFilter { it.copy(showUnlikleyBoxesInMultiBoxView = !it.showUnlikleyBoxesInMultiBoxView) }
                }
                FilterChip("POT", settings.showPotentialBoxesInMultiBoxView) {
                    onUpdateFilter { it.copy(showPotentialBoxesInMultiBoxView = !it.showPotentialBoxesInMultiBoxView) }
                }
                FilterChip("CON", settings.showConfidentBoxesInMultiBoxView) {
                    onUpdateFilter { it.copy(showConfidentBoxesInMultiBoxView = !it.showConfidentBoxesInMultiBoxView) }
                }
                FilterChip("ABN", settings.showABNBoxesInMultiboxView) {
                    onUpdateFilter { it.copy(showABNBoxesInMultiboxView = !it.showABNBoxesInMultiboxView) }
                }
                FilterChip("DCM", settings.showDCMBoxesInMultiboxView) {
                    onUpdateFilter { it.copy(showDCMBoxesInMultiboxView = !it.showDCMBoxesInMultiboxView) }
                }
                FilterChip("Notes", settings.showBoxesWithNotesInMultiboxView) {
                    onUpdateFilter { it.copy(showBoxesWithNotesInMultiboxView = !it.showBoxesWithNotesInMultiboxView) }
                }
                FilterChip("1 egg", settings.showSingleEggBoxesInMultiboxView) {
                    onUpdateFilter { it.copy(showSingleEggBoxesInMultiboxView = !it.showSingleEggBoxesInMultiboxView) }
                }
                FilterChip("2+ eggs", settings.showDoubleEggBoxesInMultiboxView) {
                    onUpdateFilter { it.copy(showDoubleEggBoxesInMultiboxView = !it.showDoubleEggBoxesInMultiboxView) }
                }
            }
        }

        // Hide filters
        if (hideFilters) {
            Text("Hide:", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 4.dp))
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                FilterChip("Data", settings.hideBoxesWithDataInMultiBoxView) {
                    onUpdateFilter { it.copy(hideBoxesWithDataInMultiBoxView = !it.hideBoxesWithDataInMultiBoxView) }
                }
                FilterChip("NO", settings.hideNoBoxesInMultiBoxView) {
                    onUpdateFilter { it.copy(hideNoBoxesInMultiBoxView = !it.hideNoBoxesInMultiBoxView) }
                }
                FilterChip("UNL", settings.hideUnlikelyBoxesInMultiBoxView) {
                    onUpdateFilter { it.copy(hideUnlikelyBoxesInMultiBoxView = !it.hideUnlikelyBoxesInMultiBoxView) }
                }
                FilterChip("POT", settings.hidePotentialBoxesInMultiBoxView) {
                    onUpdateFilter { it.copy(hidePotentialBoxesInMultiBoxView = !it.hidePotentialBoxesInMultiBoxView) }
                }
                FilterChip("CON", settings.hideConfidentBoxesInMultiBoxView) {
                    onUpdateFilter { it.copy(hideConfidentBoxesInMultiBoxView = !it.hideConfidentBoxesInMultiBoxView) }
                }
                FilterChip("BR", settings.hideBreedingBoxesInMultiBoxView) {
                    onUpdateFilter { it.copy(hideBreedingBoxesInMultiBoxView = !it.hideBreedingBoxesInMultiBoxView) }
                }
                FilterChip("ABN", settings.hideABNInMultiBoxView) {
                    onUpdateFilter { it.copy(hideABNInMultiBoxView = !it.hideABNInMultiBoxView) }
                }
                FilterChip("DCM", settings.hideDCMInMultiBoxView) {
                    onUpdateFilter { it.copy(hideDCMInMultiBoxView = !it.hideDCMInMultiBoxView) }
                }
                FilterChip("Notes", settings.hideBoxesWithNotesInMultiboxView) {
                    onUpdateFilter { it.copy(hideBoxesWithNotesInMultiboxView = !it.hideBoxesWithNotesInMultiboxView) }
                }
                FilterChip("1 egg", settings.hideSingleEggBoxesInMultiboxView) {
                    onUpdateFilter { it.copy(hideSingleEggBoxesInMultiboxView = !it.hideSingleEggBoxesInMultiboxView) }
                }
                FilterChip("2+ eggs", settings.hideDoubleEggBoxesInMultiboxView) {
                    onUpdateFilter { it.copy(hideDoubleEggBoxesInMultiboxView = !it.hideDoubleEggBoxesInMultiboxView) }
                }
                FilterChip("< current", settings.hideBeforeCurrentInMultiBoxView) {
                    onUpdateFilter { it.copy(hideBeforeCurrentInMultiBoxView = !it.hideBeforeCurrentInMultiBoxView) }
                }
            }
        }
    }
}

@Composable
private fun FilterChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit
) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label) }
    )
}
