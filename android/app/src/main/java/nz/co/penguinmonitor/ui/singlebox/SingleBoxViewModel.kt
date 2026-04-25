package nz.co.penguinmonitor.ui.singlebox

import android.content.Context
import android.os.Environment
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlinx.serialization.json.Json
import nz.co.penguinmonitor.bluetooth.BluetoothManagerService
import nz.co.penguinmonitor.bluetooth.BluetoothState
import nz.co.penguinmonitor.bluetooth.EidProcessor
import nz.co.penguinmonitor.data.repository.BoxTagRepository
import nz.co.penguinmonitor.data.repository.MonitorRepository
import nz.co.penguinmonitor.data.repository.PenguinRepository
import nz.co.penguinmonitor.data.repository.SettingsRepository
import nz.co.penguinmonitor.location.LocationService
import nz.co.penguinmonitor.location.LocationState
import nz.co.penguinmonitor.model.AppSettings
import nz.co.penguinmonitor.model.BoxData
import nz.co.penguinmonitor.model.BoxTag
import nz.co.penguinmonitor.model.LifeStage
import nz.co.penguinmonitor.model.MonitorDetails
import nz.co.penguinmonitor.model.PenguinData
import nz.co.penguinmonitor.model.ScanRecord
import nz.co.penguinmonitor.util.AlertService
import nz.co.penguinmonitor.util.BoxSetParser
import nz.co.penguinmonitor.util.BreedingDateCalculator
import java.io.File
import java.time.LocalDate
import java.time.ZoneOffset
import javax.inject.Inject

data class ScannedBirdDisplay(
    val scanRecord: ScanRecord,
    val penguinData: PenguinData?,
    val index: Int
)

sealed class DialogRequest {
    data class HighOffspringConfirmation(val message: String) : DialogRequest()
    data class EmptyBoxConfirmation(val boxName: String) : DialogRequest()
    data class DeletionReason(val monitorIndex: Int) : DialogRequest()
    data class DataSummary(val summary: String) : DialogRequest()
    data class SaveFilename(val defaultName: String, val upload: Boolean) : DialogRequest()
    data class FileSelection(val files: List<FileInfo>) : DialogRequest()
}

data class FileInfo(val name: String, val path: String, val size: Long, val lastModified: Long)

@HiltViewModel
class SingleBoxViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val monitorRepository: MonitorRepository,
    private val settingsRepository: SettingsRepository,
    private val penguinRepository: PenguinRepository,
    private val boxTagRepository: BoxTagRepository,
    private val bluetoothManager: BluetoothManagerService,
    private val eidProcessor: EidProcessor,
    private val locationService: LocationService,
    private val alertService: AlertService
) : ViewModel() {

    val settings: StateFlow<AppSettings> = settingsRepository.settings
        .stateIn(viewModelScope, SharingStarted.Eagerly, AppSettings())

    val bluetoothState: StateFlow<BluetoothState> = bluetoothManager.state
    val locationState: StateFlow<LocationState> = locationService.locationState

    private val _currentBoxIndex = MutableStateFlow(1)
    val currentBoxIndex: StateFlow<Int> = _currentBoxIndex.asStateFlow()

    private val _currentBoxName = MutableStateFlow("")
    val currentBoxName: StateFlow<String> = _currentBoxName.asStateFlow()

    private val _isBoxLocked = MutableStateFlow(true)
    val isBoxLocked: StateFlow<Boolean> = _isBoxLocked.asStateFlow()

    private val _historicalDataIndex = MutableStateFlow(0)
    val historicalDataIndex: StateFlow<Int> = _historicalDataIndex.asStateFlow()

    private val _showDifferences = MutableStateFlow(false)
    val showDifferences: StateFlow<Boolean> = _showDifferences.asStateFlow()

    private val _toastMessage = MutableStateFlow<String?>(null)
    val toastMessage: StateFlow<String?> = _toastMessage.asStateFlow()

    private val _dialogRequest = MutableStateFlow<DialogRequest?>(null)
    val dialogRequest: StateFlow<DialogRequest?> = _dialogRequest.asStateFlow()

    // High offspring count - reset on each box unlock
    private var highOffspringCountConfirmed = false

    val boxNames: StateFlow<List<String>> = settingsRepository.settings
        .combine(MutableStateFlow(Unit)) { settings, _ ->
            val dict = BoxSetParser.createBoxDictionary(settings.boxSetString, settings.allBoxSetsString)
            dict.keys.toList()
        }
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val currentBoxData: StateFlow<BoxData?> = combine(
        monitorRepository.allMonitorData,
        _currentBoxName,
        _historicalDataIndex,
        settingsRepository.settings
    ) { allData, boxName, histIndex, settings ->
        if (boxName.isBlank()) return@combine null
        val monitorIndex = settings.currentlyVisibleMonitor + histIndex
        allData[monitorIndex]?.boxData?.get(boxName)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, null)

    val scannedBirdsDisplay: StateFlow<List<ScannedBirdDisplay>> = combine(
        currentBoxData,
        penguinRepository.penguinData
    ) { boxData, penguinData ->
        boxData?.scannedIds?.mapIndexed { index, scan ->
            val shortId = eidProcessor.extractEightDigitId(scan.birdId)
            ScannedBirdDisplay(
                scanRecord = scan,
                penguinData = penguinData[shortId],
                index = index
            )
        } ?: emptyList()
    }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val olderBoxData: StateFlow<List<BoxData>> = combine(
        monitorRepository.allMonitorData,
        _currentBoxName,
        settingsRepository.settings
    ) { allData, boxName, settings ->
        if (boxName.isBlank()) return@combine emptyList()
        BreedingDateCalculator.getOlderBoxData(allData, settings.currentlyVisibleMonitor, boxName)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val stickyNotes: StateFlow<String> = olderBoxData
        .combine(MutableStateFlow(Unit)) { older, _ ->
            BreedingDateCalculator.getStickyNotes(older)
        }
        .stateIn(viewModelScope, SharingStarted.Eagerly, "")

    val breedingStatusText: StateFlow<String> = combine(
        currentBoxData,
        olderBoxData,
        _currentBoxName
    ) { current, older, name ->
        BreedingDateCalculator.getBoxBreedingStatusString(name, current, older)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, "")

    val currentBoxTag: StateFlow<BoxTag?> = combine(
        boxTagRepository.boxTags,
        _currentBoxName
    ) { tags, boxName ->
        tags[boxName]
    }.stateIn(viewModelScope, SharingStarted.Eagerly, null)

    init {
        viewModelScope.launch {
            val names = boxNames.value
            if (names.isNotEmpty()) {
                _currentBoxName.value = names.first()
                _currentBoxIndex.value = 1
            }
        }

        // Listen for Bluetooth scans
        viewModelScope.launch {
            bluetoothManager.eidData.collect { rawEid ->
                processBluetoothScan(rawEid)
            }
        }
    }

    fun navigateToBox(index: Int) {
        val names = boxNames.value
        if (index < 1 || index > names.size) return
        _currentBoxIndex.value = index
        _currentBoxName.value = names[index - 1]
        _historicalDataIndex.value = 0
        highOffspringCountConfirmed = false
    }

    fun navigateToBox(name: String) {
        val names = boxNames.value
        val idx = names.indexOfFirst { it.equals(name, ignoreCase = true) }
        if (idx >= 0) {
            _currentBoxIndex.value = idx + 1
            _currentBoxName.value = names[idx]
            _historicalDataIndex.value = 0
            highOffspringCountConfirmed = false
        }
    }

    fun navigatePrevBox() {
        if (!_isBoxLocked.value) return
        val idx = _currentBoxIndex.value
        if (idx > 1) navigateToBox(idx - 1)
        else _toastMessage.value = "Already at first box"
    }

    fun navigateNextBox() {
        if (!_isBoxLocked.value) return
        val names = boxNames.value
        val idx = _currentBoxIndex.value
        if (idx < names.size) navigateToBox(idx + 1)
        else _toastMessage.value = "Already at last box"
    }

    fun toggleLock() {
        if (_historicalDataIndex.value > 0) return
        if (!_isBoxLocked.value) {
            // Locking - save and lock
            _isBoxLocked.value = true
            viewModelScope.launch { monitorRepository.save() }
        } else {
            // Unlocking
            _isBoxLocked.value = false
            highOffspringCountConfirmed = false
        }
    }

    fun confirmHighOffspringCount() {
        highOffspringCountConfirmed = true
        _dialogRequest.value = null
    }

    fun updateAdults(count: Int) {
        if (_isBoxLocked.value || _historicalDataIndex.value > 0) return
        updateCurrentBox { it.copy(adults = count) }
        checkForHighOffspringCount(count, currentBoxData.value?.eggs ?: 0, currentBoxData.value?.chicks ?: 0)
    }

    fun updateEggs(count: Int) {
        if (_isBoxLocked.value || _historicalDataIndex.value > 0) return
        updateCurrentBox { it.copy(eggs = count) }
        checkForHighOffspringCount(currentBoxData.value?.adults ?: 0, count, currentBoxData.value?.chicks ?: 0)
    }

    fun updateChicks(count: Int) {
        if (_isBoxLocked.value || _historicalDataIndex.value > 0) return
        updateCurrentBox { it.copy(chicks = count) }
        checkForHighOffspringCount(currentBoxData.value?.adults ?: 0, currentBoxData.value?.eggs ?: 0, count)
    }

    private fun checkForHighOffspringCount(adults: Int, eggs: Int, chicks: Int) {
        if (highOffspringCountConfirmed) return

        val highValues = mutableListOf<Pair<String, Int>>()
        if (adults > 2) highValues.add("adults" to adults)
        if (eggs > 2) highValues.add("eggs" to eggs)
        if (chicks > 2) highValues.add("chicks" to chicks)
        if (chicks + eggs > 2 && eggs > 0 && chicks > 0) highValues.add("eggs & chicks" to (chicks + eggs))

        if (highValues.isNotEmpty()) {
            val message = buildString {
                append("Are you sure you have found:\n\n")
                highValues.forEach { (type, count) -> append("- $count $type\n") }
                append("\nPlease check this is correct.")
            }
            _dialogRequest.value = DialogRequest.HighOffspringConfirmation(message)
        }
    }

    fun updateGateStatus(status: String?) {
        if (_isBoxLocked.value || _historicalDataIndex.value > 0) return
        updateCurrentBox { it.copy(gateStatus = status) }
    }

    fun updateBreedingChance(chance: String?) {
        if (_isBoxLocked.value || _historicalDataIndex.value > 0) return
        updateCurrentBox { it.copy(breedingChance = chance) }
    }

    fun updateNotes(notes: String) {
        if (_isBoxLocked.value || _historicalDataIndex.value > 0) return
        updateCurrentBox { it.copy(notes = notes) }
    }

    fun addScannedId(eidData: String) {
        if (_historicalDataIndex.value > 0) return
        val boxName = _currentBoxName.value
        if (boxName.isBlank()) return

        val cleanEid = eidData.filter { it.isLetterOrDigit() }
        val shortId = eidProcessor.extractEightDigitId(cleanEid)

        val currentData = monitorRepository.getCurrentBoxData(boxName) ?: BoxData()

        // Check for duplicates
        if (currentData.scannedIds.any { eidProcessor.extractEightDigitId(it.birdId) == shortId }) {
            _toastMessage.value = "Bird $shortId already scanned"
            return
        }

        val location = locationService.locationState.value
        val s = settings.value
        val timestamp = if (s.activeSessionTimeStampActive && s.activeSessionLocalTimeStamp != null) {
            s.activeSessionLocalTimeStamp
        } else {
            Clock.System.now()
        }

        val newScan = ScanRecord(
            birdId = shortId,
            timestamp = timestamp,
            latitude = location.latitude,
            longitude = location.longitude,
            accuracy = location.accuracy
        )

        val updatedScans = currentData.scannedIds + newScan
        var adults = currentData.adults
        var chicks = currentData.chicks
        val penguinInfo = penguinRepository.penguinData.value[shortId]

        var toastMsg = "Bird $shortId added to Box $boxName"
        var shouldAlert = false

        if (penguinInfo != null) {
            // Check if returning bird (chipped as chick)
            val isReturning = penguinInfo.lastKnownLifeStage == LifeStage.Returnee ||
                    penguinInfo.chipAs.contains("chick", ignoreCase = true)
            val birdIcon = if (isReturning) "\uD83D\uDD04\uD83D\uDC27" else "\uD83D\uDC27"
            toastMsg = "$birdIcon $toastMsg"

            when {
                penguinInfo.lastKnownLifeStage == LifeStage.Adult ||
                penguinInfo.lastKnownLifeStage == LifeStage.Returnee -> {
                    adults++
                    if (isReturning) {
                        shouldAlert = true
                        toastMsg += " RETURNING BIRD"
                    } else if (!penguinInfo.sex.equals("f", ignoreCase = true) &&
                               !penguinInfo.sex.equals("m", ignoreCase = true)) {
                        shouldAlert = true
                        toastMsg += " unsexed"
                    } else {
                        toastMsg += " (+1 Adult)"
                    }
                }
                penguinInfo.lastKnownLifeStage == LifeStage.Chick -> {
                    // Check if chick is > 3 months old (treat as adult)
                    val chipInstant = penguinInfo.chipDate
                    val chipEpochSec = chipInstant.epochSeconds
                    val threeMonthsAgoSec = java.time.Instant.now().minus(java.time.Duration.ofDays(90)).epochSecond
                    val twentyYearsAgoSec = java.time.Instant.now().minus(java.time.Duration.ofDays(7300)).epochSecond

                    if (chipEpochSec > twentyYearsAgoSec && chipEpochSec < threeMonthsAgoSec) {
                        // Chick older than 3 months - count as adult
                        adults++
                        toastMsg += " (+1 Adult)"
                    } else {
                        // Recent chick
                        chicks++
                        toastMsg += " (+1 Chick)"
                    }
                    shouldAlert = true
                }
                else -> {
                    toastMsg += ", Not adult or chick."
                    shouldAlert = true
                }
            }
        } else {
            toastMsg += ", Unknown scan ID!"
            shouldAlert = true
        }

        // Auto-set breeding chance
        var breedingChance = currentData.breedingChance
        if (currentData.eggs + chicks > 0 && breedingChance.isNullOrBlank()) {
            breedingChance = "BR"
        }

        val updatedBox = currentData.copy(
            scannedIds = updatedScans,
            adults = adults,
            chicks = chicks,
            breedingChance = breedingChance
        )

        monitorRepository.updateCurrentMonitor(boxName, updatedBox)
        _toastMessage.value = toastMsg

        // Unlock box on bird scan (not box tag)
        if (_isBoxLocked.value) {
            _isBoxLocked.value = false
            highOffspringCountConfirmed = false
        }

        // Alert for special birds
        if (shouldAlert) {
            viewModelScope.launch { alertService.triggerAlert() }
        }

        viewModelScope.launch { monitorRepository.save(reportHome = false) }
    }

    fun removeScannedId(index: Int) {
        if (_isBoxLocked.value || _historicalDataIndex.value > 0) return
        val boxName = _currentBoxName.value
        val currentData = monitorRepository.getCurrentBoxData(boxName) ?: return

        val removedScan = currentData.scannedIds.getOrNull(index) ?: return
        val updatedScans = currentData.scannedIds.toMutableList().apply { removeAt(index) }

        var adults = currentData.adults
        var chicks = currentData.chicks
        val shortId = eidProcessor.extractEightDigitId(removedScan.birdId)
        val penguinInfo = penguinRepository.penguinData.value[shortId]
        if (penguinInfo != null) {
            when {
                penguinInfo.lastKnownLifeStage == LifeStage.Chick -> chicks = maxOf(0, chicks - 1)
                else -> adults = maxOf(0, adults - 1)
            }
        } else {
            adults = maxOf(0, adults - 1)
        }

        monitorRepository.updateCurrentMonitor(boxName, currentData.copy(
            scannedIds = updatedScans, adults = adults, chicks = chicks
        ))
        viewModelScope.launch { monitorRepository.save(reportHome = false) }
    }

    fun moveScanToBox(scanIndex: Int, targetBoxName: String) {
        if (_isBoxLocked.value || _historicalDataIndex.value > 0) return
        val sourceBoxName = _currentBoxName.value
        if (sourceBoxName == targetBoxName) {
            _toastMessage.value = "Already in this box"
            return
        }

        val sourceData = monitorRepository.getCurrentBoxData(sourceBoxName) ?: return
        val scan = sourceData.scannedIds.getOrNull(scanIndex) ?: return

        // Check duplicate in target
        val targetData = monitorRepository.getCurrentBoxData(targetBoxName) ?: BoxData()
        val shortId = eidProcessor.extractEightDigitId(scan.birdId)
        if (targetData.scannedIds.any { eidProcessor.extractEightDigitId(it.birdId) == shortId }) {
            _toastMessage.value = "Bird already in box $targetBoxName"
            return
        }

        val updatedSourceScans = sourceData.scannedIds.toMutableList().apply { removeAt(scanIndex) }
        monitorRepository.updateCurrentMonitor(sourceBoxName, sourceData.copy(scannedIds = updatedSourceScans))

        val updatedTargetScans = targetData.scannedIds + scan
        monitorRepository.updateCurrentMonitor(targetBoxName, targetData.copy(scannedIds = updatedTargetScans))

        _toastMessage.value = "Moved to box $targetBoxName"
        viewModelScope.launch { monitorRepository.save(reportHome = false) }
    }

    fun setHistoricalIndex(index: Int) {
        // Verify data exists at this index for current box
        val allData = monitorRepository.allMonitorData.value
        val monitorIndex = settings.value.currentlyVisibleMonitor + index
        if (index > 0 && !allData.containsKey(monitorIndex)) {
            _toastMessage.value = "No older data available"
            return
        }
        _historicalDataIndex.value = index
        if (index > 0) _isBoxLocked.value = true
    }

    // --- File I/O: Save to Downloads ---

    fun showSaveDialog(upload: Boolean = false) {
        val now = java.time.LocalDateTime.now()
        val allData = monitorRepository.allMonitorData.value
        val monitor = allData[settings.value.currentlyVisibleMonitor]
        var defaultName = "PenguinMonitor ${now.format(java.time.format.DateTimeFormatter.ofPattern("yyMMdd HHmmss"))}"

        if (monitor != null && monitor.filename.isNotBlank()) {
            val filename = monitor.filename
            if (!filename.matches(Regex(".*-\\d\\d$"))) {
                defaultName = "$filename-01"
            } else {
                val base = filename.substring(0, filename.length - 2)
                val num = filename.substring(filename.length - 2).toIntOrNull() ?: 0
                defaultName = "$base${(num + 1).toString().padStart(2, '0')}"
            }
        }
        _dialogRequest.value = DialogRequest.SaveFilename(defaultName, upload)
    }

    fun saveToFile(filename: String, upload: Boolean) {
        viewModelScope.launch {
            try {
                val allData = monitorRepository.allMonitorData.value
                val monitorIdx = settings.value.currentlyVisibleMonitor
                val monitor = allData[monitorIdx] ?: return@launch
                val updatedMonitor = monitor.copy(filename = filename, lastSaved = Clock.System.now())

                val json = Json { prettyPrint = true; encodeDefaults = true }
                val jsonStr = json.encodeToString(MonitorDetails.serializer(), updatedMonitor)

                val downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                val file = File(downloadsDir, "$filename.json")
                file.writeText(jsonStr)

                // Update filename in monitor data
                monitorRepository.updateCurrentMonitor(
                    _currentBoxName.value,
                    monitorRepository.getCurrentBoxData(_currentBoxName.value) ?: BoxData()
                )

                val boxCount = updatedMonitor.boxData.size
                val birdCount = updatedMonitor.boxData.values.sumOf { it.scannedIds.size }
                _toastMessage.value = "Saved $boxCount boxes, $birdCount birds to $filename.json"

                if (upload) {
                    monitorRepository.save(reportHome = true)
                }
            } catch (e: Exception) {
                _toastMessage.value = "Save failed: ${e.message}"
            }
        }
        _dialogRequest.value = null
    }

    // --- File I/O: Load from Downloads ---

    fun showLoadFromFileDialog() {
        try {
            val downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            val jsonFiles = downloadsDir.listFiles { _, name -> name.endsWith(".json") }
                ?.sortedByDescending { it.lastModified() }
                ?.map { FileInfo(it.name, it.absolutePath, it.length(), it.lastModified()) }
                ?: emptyList()

            if (jsonFiles.isEmpty()) {
                _toastMessage.value = "No JSON files found in Downloads"
                return
            }
            _dialogRequest.value = DialogRequest.FileSelection(jsonFiles)
        } catch (e: Exception) {
            _toastMessage.value = "Failed to list files: ${e.message}"
        }
    }

    fun loadFromFile(filePath: String) {
        viewModelScope.launch {
            try {
                val jsonStr = File(filePath).readText()
                val json = Json { ignoreUnknownKeys = true; isLenient = true }
                val monitor = json.decodeFromString(MonitorDetails.serializer(), jsonStr)

                monitorRepository.clearCurrentData()
                // Rebuild as current monitor
                for ((boxName, boxData) in monitor.boxData) {
                    monitorRepository.updateCurrentMonitor(boxName, boxData)
                }
                monitorRepository.save(reportHome = false)

                val boxCount = monitor.boxData.size
                val birdCount = monitor.boxData.values.sumOf { it.scannedIds.size }
                _toastMessage.value = "Loaded $boxCount boxes, $birdCount birds"
            } catch (e: Exception) {
                _toastMessage.value = "Failed to load: ${e.message}"
            }
        }
        _dialogRequest.value = null
    }

    // --- Load from server ---

    fun loadFromServer() {
        viewModelScope.launch {
            try {
                _toastMessage.value = "Loading from server..."
                @Suppress("DEPRECATION")
                val response = nz.co.penguinmonitor.data.remote.LegacyBackend().requestServerResponse("PenguinReportRequest:")
                if (response == "fail") {
                    _toastMessage.value = "Server request failed"
                    return@launch
                }
                val json = Json { ignoreUnknownKeys = true; isLenient = true }
                val monitor = json.decodeFromString(MonitorDetails.serializer(), response)
                monitorRepository.clearCurrentData()
                for ((boxName, boxData) in monitor.boxData) {
                    monitorRepository.updateCurrentMonitor(boxName, boxData)
                }
                monitorRepository.save(reportHome = false)
                _toastMessage.value = "Loaded ${monitor.boxData.size} boxes from server"
            } catch (e: Exception) {
                _toastMessage.value = "Server load failed: ${e.message}"
            }
        }
    }

    // --- Data Summary ---

    fun showDataSummary() {
        val allData = monitorRepository.allMonitorData.value
        val monitorIdx = settings.value.currentlyVisibleMonitor
        val monitor = allData[monitorIdx]
        if (monitor == null || monitor.boxData.isEmpty()) {
            _toastMessage.value = "No boxes with data"
            return
        }

        val penguinData = penguinRepository.penguinData.value
        val totalScannedBirds = monitor.boxData.values.sumOf { it.scannedIds.size }
        val totalAdults = monitor.boxData.values.sumOf { it.adults }
        val totalFemales = monitor.boxData.values.sumOf { box ->
            box.scannedIds.count { scan ->
                val pd = penguinData[eidProcessor.extractEightDigitId(scan.birdId)]
                pd?.sex?.equals("F", ignoreCase = true) == true
            }
        }
        val totalMales = monitor.boxData.values.sumOf { box ->
            box.scannedIds.count { scan ->
                val pd = penguinData[eidProcessor.extractEightDigitId(scan.birdId)]
                pd?.sex?.equals("M", ignoreCase = true) == true
            }
        }
        val totalEggs = monitor.boxData.values.sumOf { it.eggs }
        val totalChicks = monitor.boxData.values.sumOf { it.chicks }
        val gateUpCount = monitor.boxData.values.count { it.gateStatus == "Gate up" }
        val regateCount = monitor.boxData.values.count { it.gateStatus == "Regate" }

        // Count new eggs and chicks vs previous monitor
        var newEggs = 0
        var newChicks = 0
        for ((boxName, currentBox) in monitor.boxData) {
            var previousBox: BoxData? = null
            for (i in (monitorIdx + 1) until allData.size) {
                previousBox = allData[i]?.boxData?.get(boxName)
                if (previousBox != null) break
            }
            if (previousBox != null) {
                if (currentBox.chicks > previousBox.chicks) {
                    val chickIncrease = currentBox.chicks - previousBox.chicks
                    newChicks += chickIncrease
                    val expectedEggs = maxOf(0, previousBox.eggs - chickIncrease)
                    if (currentBox.eggs > expectedEggs) newEggs += currentBox.eggs - expectedEggs
                } else if (currentBox.eggs > previousBox.eggs) {
                    newEggs += currentBox.eggs - previousBox.eggs
                }
            }
        }

        val percentFemale = if (totalFemales + totalMales > 0) {
            ", ${100 * totalFemales / (totalFemales + totalMales)}% female"
        } else ""

        val newLine = if (newEggs > 0 || newChicks > 0) "NEW: $newEggs eggs, $newChicks chicks\n" else ""

        val boxKeys = monitor.boxData.keys
        val summary = buildString {
            append("${monitor.boxData.size} boxes with data\n")
            append("$totalScannedBirds bird scans$percentFemale\n")
            append("$totalAdults adults\n")
            append("$totalEggs eggs\n")
            append("$totalChicks chicks\n")
            if (newLine.isNotEmpty()) append(newLine)
            append("Gate: $gateUpCount up, $regateCount regate\n\n")
            if (boxKeys.isNotEmpty()) append("Box range: ${boxKeys.min()} - ${boxKeys.max()}")
        }

        _dialogRequest.value = DialogRequest.DataSummary(summary)
    }

    // --- Clear data ---

    fun clearCurrentBoxData() {
        if (_isBoxLocked.value) return
        val boxName = _currentBoxName.value
        monitorRepository.updateCurrentMonitor(boxName, BoxData())
        viewModelScope.launch { monitorRepository.save(reportHome = false) }
        _toastMessage.value = "Box $boxName cleared"
    }

    fun clearAllCurrentData() {
        monitorRepository.clearCurrentData()
        viewModelScope.launch { monitorRepository.save(reportHome = false) }
        _toastMessage.value = "All current data cleared"
    }

    fun requestDeleteMonitor(monitorIndex: Int) {
        _dialogRequest.value = DialogRequest.DeletionReason(monitorIndex)
    }

    fun deleteMonitor(monitorIndex: Int, reason: String) {
        monitorRepository.deleteMonitor(monitorIndex, reason)
        viewModelScope.launch { monitorRepository.save(reportHome = false) }
        _toastMessage.value = "Monitor deleted"
        _dialogRequest.value = null
    }

    fun addStickyNote(note: String) {
        if (_isBoxLocked.value) return
        val currentNotes = currentBoxData.value?.notes ?: ""
        updateCurrentBox { it.copy(notes = "$currentNotes l=$note".trim()) }
    }

    fun removeStickyNote(note: String) {
        if (_isBoxLocked.value) return
        val currentNotes = currentBoxData.value?.notes ?: ""
        updateCurrentBox { it.copy(notes = "$currentNotes l-$note".trim()) }
    }

    fun deleteBoxTag() {
        viewModelScope.launch { boxTagRepository.removeBoxTag(_currentBoxName.value) }
    }

    fun clearToastMessage() { _toastMessage.value = null }
    fun dismissDialog() { _dialogRequest.value = null }

    private fun processBluetoothScan(rawEid: String) {
        val cleanEid = eidProcessor.cleanEid(rawEid) ?: return

        // Switch to current data if viewing historical or older monitor
        if (_historicalDataIndex.value > 0 || settings.value.currentlyVisibleMonitor != 0) {
            _historicalDataIndex.value = 0
            viewModelScope.launch {
                settingsRepository.update {
                    it.copy(currentlyVisibleMonitor = 0, activeSessionTimeStampActive = false)
                }
            }
        }

        if (eidProcessor.isBoxTag(cleanEid)) {
            handleBoxTagScan(cleanEid)
        } else {
            // Don't auto-unlock for box tags - AddScannedId handles unlock for birds
            addScannedId(cleanEid)
        }
    }

    private fun handleBoxTagScan(cleanEid: String) {
        val assignedBoxId = boxTagRepository.getBoxIdByTag(cleanEid)

        if (!_isBoxLocked.value) {
            // UNLOCKED
            if (assignedBoxId != null && assignedBoxId != _currentBoxName.value) {
                // Tag belongs to different box - error!
                viewModelScope.launch { alertService.triggerAlert() }
                _toastMessage.value = "ERROR: Tag belongs to Box $assignedBoxId! Current box is ${_currentBoxName.value}"
                return
            }
            // Assign tag to current box
            val location = locationService.locationState.value
            viewModelScope.launch {
                boxTagRepository.assignBoxTag(
                    boxId = _currentBoxName.value,
                    tagNumber = cleanEid,
                    latitude = location.latitude,
                    longitude = location.longitude,
                    accuracy = location.accuracy
                )
            }
            _toastMessage.value = "Box tag assigned to Box ${_currentBoxName.value}"
        } else {
            // LOCKED
            if (assignedBoxId != null) {
                if (assignedBoxId == _currentBoxName.value) {
                    _isBoxLocked.value = false
                    highOffspringCountConfirmed = false
                    _toastMessage.value = "Box ${_currentBoxName.value} unlocked"
                } else {
                    // Jump to assigned box and unlock
                    val names = boxNames.value
                    if (names.contains(assignedBoxId)) {
                        navigateToBox(assignedBoxId)
                        _isBoxLocked.value = false
                        highOffspringCountConfirmed = false
                        _toastMessage.value = "Jumped to Box $assignedBoxId and unlocked"
                    } else {
                        _toastMessage.value = "Box $assignedBoxId not in current scope"
                    }
                }
            } else {
                // Unassigned tag while locked - error
                viewModelScope.launch { alertService.triggerAlert() }
                _toastMessage.value = "Unknown box tag! Unlock a box first to assign this tag."
            }
        }
    }

    private fun updateCurrentBox(transform: (BoxData) -> BoxData) {
        val boxName = _currentBoxName.value
        if (boxName.isBlank()) return
        val currentData = monitorRepository.getCurrentBoxData(boxName) ?: BoxData()
        val updated = transform(currentData)

        val finalData = if (updated.eggs + updated.chicks > 0 && updated.breedingChance.isNullOrBlank()) {
            updated.copy(breedingChance = "BR")
        } else updated

        monitorRepository.updateCurrentMonitor(boxName, finalData)
        viewModelScope.launch { monitorRepository.save(reportHome = false) }
    }
}
