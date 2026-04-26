package nz.co.penguinmonitor.ui.overview

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import nz.co.penguinmonitor.data.repository.BreedingDateRepository
import nz.co.penguinmonitor.data.repository.MonitorRepository
import nz.co.penguinmonitor.data.repository.SettingsRepository
import nz.co.penguinmonitor.model.AppSettings
import nz.co.penguinmonitor.model.BoxData
import nz.co.penguinmonitor.model.BoxPredictedDates
import nz.co.penguinmonitor.model.MonitorDetails
import nz.co.penguinmonitor.util.BoxSetParser
import nz.co.penguinmonitor.util.BreedingDateCalculator
import javax.inject.Inject

// Border types matching C# logic
enum class CardBorder { DEFAULT, RED_THICK, BLUE_THICK, YELLOW_THICK }

data class BoxCardDisplay(
    val boxName: String,
    val boxData: BoxData?,
    val emojiLine: String,        // 🐧🥚🐣
    val previousEmoji: String,    // (🥚🐣) if different
    val breedingChance: String?,
    val showBreedingChance: Boolean,
    val breedingStatusText: String,
    val bottomLine: String,       // gate + notes + sticky + NRF
    val border: CardBorder,
    val isSelected: Boolean
)

@HiltViewModel
class OverviewViewModel @Inject constructor(
    private val monitorRepository: MonitorRepository,
    private val settingsRepository: SettingsRepository,
    private val breedingDateRepository: BreedingDateRepository
) : ViewModel() {

    val settings: StateFlow<AppSettings> = settingsRepository.settings
        .stateIn(viewModelScope, SharingStarted.Eagerly, AppSettings())

    private val _showDifferences = MutableStateFlow(false)
    val showDifferences: StateFlow<Boolean> = _showDifferences.asStateFlow()

    val breedingDates: StateFlow<Map<String, BoxPredictedDates>> = breedingDateRepository.breedingDates

    val filteredBoxCards: StateFlow<List<BoxCardDisplay>> = combine(
        monitorRepository.allMonitorData,
        settingsRepository.settings,
        _showDifferences
    ) { allData, settings, showDiff ->
        buildBoxCards(allData, settings, showDiff)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    private fun buildBoxCards(
        allData: Map<Int, MonitorDetails>,
        settings: AppSettings,
        showDifferences: Boolean
    ): List<BoxCardDisplay> {
        val boxDict = BoxSetParser.createBoxDictionary(settings.boxSetString, settings.allBoxSetsString)
        var monitorIndex = settings.currentlyVisibleMonitor

        var currentMonitor = allData[monitorIndex]
        if (currentMonitor == null || currentMonitor.boxData.isEmpty()) {
            for (i in 0 until allData.size) {
                val m = allData[i]
                if (m != null && m.boxData.isNotEmpty()) {
                    currentMonitor = m
                    monitorIndex = i
                    break
                }
            }
        }
        if (currentMonitor == null || currentMonitor.boxData.isEmpty()) return emptyList()

        val previousMonitor = allData.getOrDefault(monitorIndex + 1, null)

        return boxDict.keys.mapNotNull { boxName ->
            var thisBoxData = currentMonitor.boxData[boxName]
            val currentExists = thisBoxData != null

            if (!shouldShowBox(boxName, thisBoxData, settings)) return@mapNotNull null

            val olderBoxes = BreedingDateCalculator.getOlderBoxData(allData, monitorIndex, boxName).toMutableList()

            // If no current data but older exists, use first older as current (matches C#)
            if (!currentExists && olderBoxes.isNotEmpty()) {
                thisBoxData = olderBoxes.removeFirst()
            }

            val previousData = previousMonitor?.boxData?.get(boxName)

            // --- Border logic matching C# exactly ---
            var border = CardBorder.DEFAULT
            var differenceFound = false

            if (showDifferences && currentExists) {
                val showDiffFromPrevious = previousData != null && thisBoxData != null && (
                    thisBoxData.adults != previousData.adults ||
                    thisBoxData.eggs != previousData.eggs ||
                    thisBoxData.chicks != previousData.chicks ||
                    thisBoxData.gateStatus != previousData.gateStatus ||
                    thisBoxData.breedingChance != previousData.breedingChance ||
                    thisBoxData.notes != previousData.notes
                )
                if (showDiffFromPrevious || allData.size == monitorIndex + 1 ||
                    allData[monitorIndex + 1]?.boxData?.containsKey(boxName) != true) {
                    border = CardBorder.RED_THICK
                }
            }

            if (!currentExists) {
                border = CardBorder.YELLOW_THICK
            } else if (thisBoxData != null && olderBoxes.isNotEmpty()) {
                val first = olderBoxes.first()
                if (thisBoxData.eggs + thisBoxData.chicks < first.eggs + first.chicks) {
                    differenceFound = true
                    border = CardBorder.RED_THICK
                } else if (thisBoxData.breedingChance != "BR" && thisBoxData.eggs + thisBoxData.chicks > 0) {
                    border = CardBorder.RED_THICK
                } else if (thisBoxData.eggs != first.eggs || thisBoxData.chicks != first.chicks) {
                    differenceFound = true
                    border = CardBorder.BLUE_THICK
                }
            } else if (thisBoxData != null && thisBoxData.breedingChance != "BR" && thisBoxData.eggs + thisBoxData.chicks > 0) {
                border = CardBorder.RED_THICK
            }

            // --- Emoji line ---
            val emojiLine = buildString {
                if (thisBoxData != null) {
                    append("\uD83D\uDC27".repeat(thisBoxData.adults))
                    append("\uD83E\uDD5A".repeat(thisBoxData.eggs))
                    append("\uD83D\uDC23".repeat(thisBoxData.chicks))
                }
            }

            // Previous emoji in parens if difference found
            val previousEmoji = if (differenceFound && olderBoxes.isNotEmpty()) {
                val prev = olderBoxes.first()
                if (prev.eggs + prev.chicks > 0 && thisBoxData != null &&
                    (thisBoxData.eggs != prev.eggs || thisBoxData.chicks != prev.chicks)) {
                    "(" + "\uD83E\uDD5A".repeat(prev.eggs) + "\uD83D\uDC23".repeat(prev.chicks) + ")"
                } else ""
            } else ""

            // Show breeding chance when not BR, or when BR but no offspring
            val showBC = thisBoxData?.breedingChance != null &&
                (thisBoxData.breedingChance != "BR" || (thisBoxData.breedingChance == "BR" && thisBoxData.eggs + thisBoxData.chicks == 0))

            // Breeding status
            val breedingStatus = BreedingDateCalculator.getBoxBreedingStatusString(boxName, thisBoxData, olderBoxes)

            // Bottom line: gate + notes + sticky notes
            val stickyNotes = BreedingDateCalculator.getStickyNotes(olderBoxes)
            val bottomLine = buildString {
                thisBoxData?.gateStatus?.let { if (it.isNotBlank()) append(it) }
                val hasNotes = thisBoxData?.notes?.isNotBlank() == true
                if (hasNotes) {
                    if (isNotEmpty()) append(" & ")
                    append("notes")
                }
                if (stickyNotes.isNotBlank()) append(" ($stickyNotes)")
            }.trim()

            BoxCardDisplay(
                boxName = boxName,
                boxData = thisBoxData,
                emojiLine = emojiLine,
                previousEmoji = previousEmoji,
                breedingChance = thisBoxData?.breedingChance,
                showBreedingChance = showBC,
                breedingStatusText = breedingStatus,
                bottomLine = bottomLine,
                border = border,
                isSelected = false
            )
        }
    }

    private fun shouldShowBox(boxName: String, boxData: BoxData?, settings: AppSettings): Boolean {
        val hasData = boxData != null && (boxData.scannedIds.isNotEmpty() ||
                boxData.adults > 0 || boxData.eggs > 0 || boxData.chicks > 0)
        val chance = boxData?.breedingChance ?: ""
        val hasNotes = boxData?.notes?.isNotBlank() == true
        val eggs = boxData?.eggs ?: 0

        if (settings.hideBoxesWithDataInMultiBoxView && hasData) return false
        if (settings.hideDCMInMultiBoxView && chance == "DCM") return false
        if (settings.hideABNInMultiBoxView && chance == "ABN") return false
        if (settings.hideNoBoxesInMultiBoxView && chance == "NO") return false
        if (settings.hideUnlikelyBoxesInMultiBoxView && chance == "UNL") return false
        if (settings.hidePotentialBoxesInMultiBoxView && chance == "POT") return false
        if (settings.hideConfidentBoxesInMultiBoxView && chance == "CON") return false
        if (settings.hideBreedingBoxesInMultiBoxView && chance == "BR") return false
        if (settings.hideBoxesWithNotesInMultiboxView && hasNotes) return false
        if (settings.hideSingleEggBoxesInMultiboxView && eggs == 1) return false
        if (settings.hideDoubleEggBoxesInMultiboxView && eggs >= 2) return false

        val anyShowActive = settings.showBoxesWithDataInMultiBoxView ||
                settings.showNoBoxesInMultiBoxView || settings.showUnlikleyBoxesInMultiBoxView ||
                settings.showPotentialBoxesInMultiBoxView || settings.showConfidentBoxesInMultiBoxView ||
                settings.showBreedingBoxesInMultiBoxView || settings.showBoxesWithNotesInMultiboxView ||
                settings.showSingleEggBoxesInMultiboxView || settings.showDoubleEggBoxesInMultiboxView ||
                settings.showDCMBoxesInMultiboxView || settings.showABNBoxesInMultiboxView

        if (settings.showAllBoxesInMultiBoxView) return true

        if (anyShowActive) {
            if (settings.showBoxesWithDataInMultiBoxView && hasData) return true
            if (settings.showNoBoxesInMultiBoxView && chance == "NO") return true
            if (settings.showUnlikleyBoxesInMultiBoxView && chance == "UNL") return true
            if (settings.showPotentialBoxesInMultiBoxView && chance == "POT") return true
            if (settings.showConfidentBoxesInMultiBoxView && chance == "CON") return true
            if (settings.showBreedingBoxesInMultiBoxView && chance == "BR") return true
            if (settings.showDCMBoxesInMultiboxView && chance == "DCM") return true
            if (settings.showABNBoxesInMultiboxView && chance == "ABN") return true
            if (settings.showBoxesWithNotesInMultiboxView && hasNotes) return true
            if (settings.showSingleEggBoxesInMultiboxView && eggs == 1) return true
            if (settings.showDoubleEggBoxesInMultiboxView && eggs >= 2) return true
            return false
        }

        return true
    }

    fun navigateToMonitor(index: Int) {
        viewModelScope.launch { settingsRepository.update { it.copy(currentlyVisibleMonitor = index) } }
    }

    fun nextMonitor() {
        val current = settings.value.currentlyVisibleMonitor
        val maxIndex = monitorRepository.allMonitorData.value.size - 1
        if (current < maxIndex) navigateToMonitor(current + 1)
    }

    fun previousMonitor() {
        val current = settings.value.currentlyVisibleMonitor
        if (current > 0) navigateToMonitor(current - 1)
    }

    fun showLatestMonitor() { navigateToMonitor(0) }

    fun toggleShowDifferences() { _showDifferences.value = !_showDifferences.value }

    fun updateFilter(transform: (AppSettings) -> AppSettings) {
        viewModelScope.launch { settingsRepository.update(transform) }
    }
}
