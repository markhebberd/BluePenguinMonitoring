package nz.co.penguinmonitor.data.repository

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.datetime.Clock
import nz.co.penguinmonitor.data.local.BoxTagLocalDataSource
import nz.co.penguinmonitor.data.remote.BoxTagApiService
import nz.co.penguinmonitor.model.BoxTag
import nz.co.penguinmonitor.util.Constants
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class BoxTagRepository @Inject constructor(
    private val localDataSource: BoxTagLocalDataSource
) {
    private var apiService: BoxTagApiService? = null

    private val _boxTags = MutableStateFlow<Map<String, BoxTag>>(emptyMap())
    val boxTags: StateFlow<Map<String, BoxTag>> = _boxTags.asStateFlow()

    fun initializeApi(apiUrl: String, apiKey: String) {
        if (apiUrl.isNotBlank() && apiKey.isNotBlank()) {
            apiService = BoxTagApiService(apiUrl, apiKey)
        }
    }

    val isApiConfigured: Boolean get() = apiService != null

    suspend fun load() {
        _boxTags.value = localDataSource.loadBoxTags()
    }

    suspend fun assignBoxTag(
        boxId: String,
        tagNumber: String,
        latitude: Double,
        longitude: Double,
        accuracy: Float
    ) {
        val tag = BoxTag(
            boxId = boxId,
            tagNumber = tagNumber,
            scanTimeUtc = Clock.System.now(),
            latitude = latitude,
            longitude = longitude,
            accuracy = accuracy
        )
        val updated = _boxTags.value.toMutableMap()
        updated[boxId] = tag
        _boxTags.value = updated
        localDataSource.saveBoxTags(updated)

        apiService?.let { api ->
            try {
                api.saveBoxTag(tag)
            } catch (_: Exception) { }
        }
    }

    suspend fun removeBoxTag(boxId: String) {
        val updated = _boxTags.value.toMutableMap()
        updated.remove(boxId)
        _boxTags.value = updated
        localDataSource.saveBoxTags(updated)

        apiService?.let { api ->
            try {
                api.deleteBoxTag(boxId)
            } catch (_: Exception) { }
        }
    }

    fun getBoxIdByTag(tagNumber: String): String? {
        return _boxTags.value.entries.find { it.value.tagNumber == tagNumber }?.key
    }

    data class SyncResult(
        val tags: Map<String, BoxTag>,
        val uploaded: Int,
        val downloaded: Int,
        val failed: Int,
        val error: String?
    )

    suspend fun syncWithApi(validBoxIds: Collection<String>? = null): SyncResult {
        val api = apiService ?: return SyncResult(_boxTags.value, 0, 0, 0, "API not configured")

        return try {
            val remoteTags = api.getAllBoxTags()
            val localTags = _boxTags.value
            val isValid: (String) -> Boolean = { validBoxIds == null || it in validBoxIds }

            var uploaded = 0
            var downloaded = 0
            var failed = 0

            // Count downloads
            for ((key, _) in remoteTags) {
                if (isValid(key) && key !in localTags) downloaded++
            }

            // Upload local tags that are newer or missing remotely
            for ((key, localTag) in localTags) {
                if (!isValid(key)) continue
                val shouldUpload = key !in remoteTags ||
                        (localTag.scanTimeUtc.epochSeconds - remoteTags[key]!!.scanTimeUtc.epochSeconds > 1)

                if (shouldUpload) {
                    try {
                        api.saveBoxTag(localTag)
                        uploaded++
                    } catch (_: Exception) {
                        failed++
                    }
                }
            }

            // Merge: remote wins for valid boxes
            val merged = mutableMapOf<String, BoxTag>()
            for ((key, tag) in remoteTags) {
                if (isValid(key)) merged[key] = tag
            }

            _boxTags.value = merged
            localDataSource.saveBoxTags(merged)

            SyncResult(merged, uploaded, downloaded, failed, null)
        } catch (e: Exception) {
            SyncResult(_boxTags.value, 0, 0, 0, e.message)
        }
    }

    companion object {
        fun isBoxTag(scannedId: String): Boolean {
            val clean = scannedId.filter { it.isLetterOrDigit() }
            return clean.length >= 9 && clean.substring(0, 9).equals(Constants.BOX_TAG_PREFIX, ignoreCase = true)
        }

        fun isPenguinTag(scannedId: String): Boolean {
            val clean = scannedId.filter { it.isLetterOrDigit() }
            return clean.length >= 9 && clean.substring(0, 9).equals(Constants.PENGUIN_TAG_PREFIX, ignoreCase = true)
        }
    }
}
