package nz.co.penguinmonitor.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import nz.co.penguinmonitor.bluetooth.BluetoothManagerService
import nz.co.penguinmonitor.bluetooth.BluetoothState
import nz.co.penguinmonitor.data.repository.BoxTagRepository
import nz.co.penguinmonitor.data.repository.MonitorRepository
import nz.co.penguinmonitor.data.repository.PenguinRepository
import nz.co.penguinmonitor.data.repository.SettingsRepository
import nz.co.penguinmonitor.location.LocationService
import nz.co.penguinmonitor.location.LocationState
import nz.co.penguinmonitor.model.AppSettings
import javax.inject.Inject

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val settingsRepository: SettingsRepository,
    private val bluetoothManager: BluetoothManagerService,
    private val locationService: LocationService,
    private val monitorRepository: MonitorRepository,
    private val penguinRepository: PenguinRepository,
    private val boxTagRepository: BoxTagRepository
) : ViewModel() {

    val settings: StateFlow<AppSettings> = settingsRepository.settings
        .stateIn(viewModelScope, SharingStarted.Eagerly, AppSettings())

    val bluetoothState: StateFlow<BluetoothState> = bluetoothManager.state

    val locationState: StateFlow<LocationState> = locationService.locationState

    private val _isSyncing = MutableStateFlow(false)
    val isSyncing: StateFlow<Boolean> = _isSyncing.asStateFlow()

    private val _editBoxTagsMode = MutableStateFlow(false)
    val editBoxTagsMode: StateFlow<Boolean> = _editBoxTagsMode.asStateFlow()

    private val _syncStatusMessage = MutableStateFlow<String?>(null)
    val syncStatusMessage: StateFlow<String?> = _syncStatusMessage.asStateFlow()

    init {
        // Data loading and first-launch download handled by PenguinMonitorApp.onCreate()
        // This ViewModel only handles Settings screen UI actions
        viewModelScope.launch {
            val s = settings.value
            locationService.startLocationUpdates()
            if (s.isBluetoothEnabled) {
                bluetoothManager.startConnection(viewModelScope)
            }
        }
    }

    fun toggleBluetooth(enabled: Boolean) {
        viewModelScope.launch {
            settingsRepository.update { it.copy(isBluetoothEnabled = enabled) }
            if (enabled) {
                bluetoothManager.startConnection(viewModelScope)
            } else {
                bluetoothManager.disconnect()
            }
        }
    }

    fun updateActiveSessionTimestamp(timestamp: kotlinx.datetime.Instant?, active: Boolean) {
        viewModelScope.launch {
            settingsRepository.update {
                it.copy(
                    activeSessionLocalTimeStamp = timestamp,
                    activeSessionTimeStampActive = active
                )
            }
        }
    }

    fun toggleShowBoxTagDeleteButton(show: Boolean) {
        viewModelScope.launch {
            settingsRepository.update { it.copy(showBoxTagDeleteButton = show) }
        }
    }

    fun toggleEditBoxTagsMode() {
        _editBoxTagsMode.value = !_editBoxTagsMode.value
    }

    fun updateBoxSets(boxSetsString: String) {
        viewModelScope.launch {
            settingsRepository.update { it.copy(allBoxSetsString = boxSetsString) }
        }
    }

    fun selectBoxSet(setName: String) {
        viewModelScope.launch {
            settingsRepository.update { it.copy(boxSetString = setName) }
        }
    }

    fun downloadRemoteData() {
        if (_isSyncing.value) return
        viewModelScope.launch {
            _isSyncing.value = true
            _syncStatusMessage.value = "Downloading data..."
            try {
                // Download in parallel
                val penguinJob = launch { penguinRepository.downloadAndRefresh() }
                val monitorJob = launch { monitorRepository.downloadRemoteMonitors() }
                val tagSyncJob = launch {
                    if (boxTagRepository.isApiConfigured) {
                        boxTagRepository.syncWithApi()
                    }
                }

                penguinJob.join()
                monitorJob.join()
                tagSyncJob.join()

                monitorRepository.save(reportHome = false)

                val penguinCount = penguinRepository.penguinData.value.size
                val monitorCount = monitorRepository.allMonitorData.value.values
                    .sumOf { it.boxData.size }
                _syncStatusMessage.value = "Got $monitorCount box monitors, $penguinCount remote bird infos"
            } catch (e: Exception) {
                _syncStatusMessage.value = "Download failed: ${e.message}"
            } finally {
                _isSyncing.value = false
            }
        }
    }

    fun updateTimelineSettings(
        showTimeline: Boolean? = null,
        showHatching: Boolean? = null,
        showPG: Boolean? = null,
        showChipping: Boolean? = null,
        showFledging: Boolean? = null
    ) {
        viewModelScope.launch {
            settingsRepository.update { s ->
                s.copy(
                    showBreedingDatesTimeline = showTimeline ?: s.showBreedingDatesTimeline,
                    showHatchingDatesInTimeline = showHatching ?: s.showHatchingDatesInTimeline,
                    showPGDatesInTimeline = showPG ?: s.showPGDatesInTimeline,
                    showChippingDatesInTimeline = showChipping ?: s.showChippingDatesInTimeline,
                    showFledgingDatesInTimeline = showFledging ?: s.showFledgingDatesInTimeline
                )
            }
        }
    }

    fun clearSyncMessage() {
        _syncStatusMessage.value = null
    }
}
