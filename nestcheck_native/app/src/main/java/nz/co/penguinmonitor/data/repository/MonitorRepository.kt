package nz.co.penguinmonitor.data.repository

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import nz.co.penguinmonitor.data.local.MonitorDataStore
import nz.co.penguinmonitor.data.remote.LegacyBackend
import nz.co.penguinmonitor.model.BoxData
import nz.co.penguinmonitor.model.MonitorDetails
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class MonitorRepository @Inject constructor(
    private val monitorDataStore: MonitorDataStore,
    @Suppress("DEPRECATION") private val legacyBackend: LegacyBackend
) {
    private val _allMonitorData = MutableStateFlow<Map<Int, MonitorDetails>>(mapOf(0 to MonitorDetails()))
    val allMonitorData: StateFlow<Map<Int, MonitorDetails>> = _allMonitorData.asStateFlow()

    suspend fun load() {
        _allMonitorData.value = monitorDataStore.loadAllMonitors()
    }

    suspend fun save(reportHome: Boolean = true) {
        monitorDataStore.saveAllMonitors(_allMonitorData.value)
        if (reportHome) {
            val current = _allMonitorData.value[0]
            if (current != null && current.boxData.isNotEmpty()) {
                try {
                    val json = kotlinx.serialization.json.Json {
                        prettyPrint = true
                        encodeDefaults = true
                    }
                    val currentJson = json.encodeToString(MonitorDetails.serializer(), current)
                    @Suppress("DEPRECATION")
                    legacyBackend.requestServerResponse("PenguinReport:$currentJson")
                } catch (_: Exception) { }
            }
        }
    }

    fun updateCurrentMonitor(boxName: String, boxData: BoxData) {
        val current = _allMonitorData.value.toMutableMap()
        val monitor = current[0] ?: MonitorDetails()
        val updatedBoxData = monitor.boxData.toMutableMap()
        updatedBoxData[boxName] = boxData
        current[0] = monitor.copy(
            boxData = updatedBoxData,
            lastSaved = kotlinx.datetime.Clock.System.now()
        )
        _allMonitorData.value = current
    }

    fun getCurrentBoxData(boxName: String): BoxData? {
        return _allMonitorData.value[0]?.boxData?.get(boxName)
    }

    fun getMonitorBoxData(monitorIndex: Int, boxName: String): BoxData? {
        return _allMonitorData.value[monitorIndex]?.boxData?.get(boxName)
    }

    suspend fun downloadRemoteMonitors() {
        try {
            val current = _allMonitorData.value.toMutableMap()
            val temp = current[0] ?: MonitorDetails()
            current.clear()
            current[0] = temp

            @Suppress("DEPRECATION")
            val response = legacyBackend.requestServerResponse("PenguinRequest-Saved:")
            if (response == "fail") return

            val json = kotlinx.serialization.json.Json {
                ignoreUnknownKeys = true
                isLenient = true
            }

            for (jsonStr in response.split("~~~~").filter { it.isNotEmpty() }) {
                try {
                    val monitor = json.decodeFromString(MonitorDetails.serializer(), jsonStr)
                    if (!monitor.isDeleted) {
                        current[current.size] = monitor
                    }
                } catch (_: Exception) { }
            }

            _allMonitorData.value = current
        } catch (_: Exception) { }
    }

    fun clearCurrentData() {
        val current = _allMonitorData.value.toMutableMap()
        current[0] = MonitorDetails()
        _allMonitorData.value = current
    }

    fun clearAllData() {
        monitorDataStore.clearData()
        _allMonitorData.value = mapOf(0 to MonitorDetails())
    }

    fun deleteMonitor(index: Int, reason: String) {
        if (index == 0) return
        val current = _allMonitorData.value.toMutableMap()
        val monitor = current[index] ?: return
        current[index] = monitor.copy(isDeleted = true, deletionReason = reason)
        _allMonitorData.value = current
    }
}
