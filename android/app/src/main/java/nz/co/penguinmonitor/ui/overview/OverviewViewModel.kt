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

data class BoxCardDisplay(
    val boxName: String,
    val boxData: BoxData?,
    val adultsEmoji: String,
    val eggsEmoji: String,
    val chicksEmoji: String,
    val breedingChance: String?,
    val breedingStatusText: String,
    val notesPreview: String,
    val hasChanged: Boolean,
    val gateStatus: String?
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

        // If current monitor is empty, find the first one with data
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
            val boxData = currentMonitor.boxData[boxName]
            val previousData = previousMonitor?.boxData?.get(boxName)

            // Apply filters
            if (!shouldShowBox(boxName, boxData, settings)) return@mapNotNull null

            val olderBoxes = BreedingDateCalculator.getOlderBoxData(allData, monitorIndex, boxName)
            val breedingStatus = BreedingDateCalculator.getBoxBreedingStatusString(boxName, boxData, olderBoxes)

            val hasChanged = showDifferences && previousData != null && boxData != null &&
                    (boxData.adults != previousData.adults ||
                            boxData.eggs != previousData.eggs ||
                            boxData.chicks != previousData.chicks ||
                            boxData.breedingChance != previousData.breedingChance)

            val adultsStr = "\uD83D\uDC27".repeat(boxData?.adults ?: 0) // 🐧
            val eggsStr = "\uD83E\uDD5A".repeat(boxData?.eggs ?: 0) // 🥚
            val chicksStr = "\uD83D\uDC23".repeat(boxData?.chicks ?: 0) // 🐣

            val notesPreview = buildString {
                boxData?.gateStatus?.let { if (it.isNotBlank()) append("$it ") }
                boxData?.notes?.let { if (it.isNotBlank()) append(it.take(30)) }
            }.trim()

            BoxCardDisplay(
                boxName = boxName,
                boxData = boxData,
                adultsEmoji = adultsStr,
                eggsEmoji = eggsStr,
                chicksEmoji = chicksStr,
                breedingChance = boxData?.breedingChance,
                breedingStatusText = breedingStatus,
                notesPreview = notesPreview,
                hasChanged = hasChanged,
                gateStatus = boxData?.gateStatus
            )
        }
    }

    private fun shouldShowBox(boxName: String, boxData: BoxData?, settings: AppSettings): Boolean {
        val hasData = boxData != null && (boxData.scannedIds.isNotEmpty() ||
                boxData.adults > 0 || boxData.eggs > 0 || boxData.chicks > 0)
        val chance = boxData?.breedingChance ?: ""
        val hasNotes = boxData?.notes?.isNotBlank() == true
        val eggs = boxData?.eggs ?: 0

        // Hide filters (applied first)
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

        // Show filters (if any are active, only show matching)
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
        viewModelScope.launch {
            settingsRepository.update { it.copy(currentlyVisibleMonitor = index) }
        }
    }

    fun nextMonitor() {
        val current = settings.value.currentlyVisibleMonitor
        val maxIndex = monitorRepository.allMonitorData.value.size - 1
        if (current < maxIndex) {
            navigateToMonitor(current + 1)
        }
    }

    fun previousMonitor() {
        val current = settings.value.currentlyVisibleMonitor
        if (current > 0) {
            navigateToMonitor(current - 1)
        }
    }

    fun showLatestMonitor() {
        navigateToMonitor(0)
    }

    fun toggleShowDifferences() {
        _showDifferences.value = !_showDifferences.value
    }

    fun updateFilter(transform: (AppSettings) -> AppSettings) {
        viewModelScope.launch {
            settingsRepository.update(transform)
        }
    }
}
