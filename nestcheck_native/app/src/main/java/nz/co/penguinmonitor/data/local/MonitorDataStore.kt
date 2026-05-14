package nz.co.penguinmonitor.data.local

import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import nz.co.penguinmonitor.model.MonitorDetails
import nz.co.penguinmonitor.util.Constants
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class MonitorDataStore @Inject constructor(
    private val storage: JsonFileStorage
) {
    private val serializer = MapSerializer(Int.serializer(), MonitorDetails.serializer())

    suspend fun loadAllMonitors(): Map<Int, MonitorDetails> {
        return storage.read(Constants.ALL_MONITOR_DATA_FILENAME, serializer)
            ?: mapOf(0 to MonitorDetails())
    }

    suspend fun saveAllMonitors(data: Map<Int, MonitorDetails>) {
        storage.write(Constants.ALL_MONITOR_DATA_FILENAME, serializer, data)
    }

    fun clearData() {
        storage.deleteFile(Constants.ALL_MONITOR_DATA_FILENAME)
    }
}
