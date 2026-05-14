package nz.co.penguinmonitor.data.repository

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.datetime.Instant
import nz.co.penguinmonitor.data.local.PenguinLocalDataSource
import nz.co.penguinmonitor.data.remote.GoogleSheetsCsvService
import nz.co.penguinmonitor.model.LifeStage
import nz.co.penguinmonitor.model.PenguinData
import nz.co.penguinmonitor.util.Constants
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class PenguinRepository @Inject constructor(
    private val localDataSource: PenguinLocalDataSource,
    private val csvService: GoogleSheetsCsvService
) {
    private val _penguinData = MutableStateFlow<Map<String, PenguinData>>(emptyMap())
    val penguinData: StateFlow<Map<String, PenguinData>> = _penguinData.asStateFlow()

    suspend fun load() {
        _penguinData.value = localDataSource.loadPenguinData()
    }

    fun lookupBird(eightDigitId: String): PenguinData? {
        return _penguinData.value[eightDigitId.uppercase()]
    }

    suspend fun downloadAndRefresh() {
        val csvUrl = csvService.convertToGoogleSheetsCsvUrl(Constants.ALL_PENGS_URL)
        val csvContent = csvService.downloadCsv(csvUrl)
        val parsedRows = csvService.parseBirdCsv(csvContent)

        val remotePenguinData = mutableMapOf<String, PenguinData>()
        for (row in parsedRows) {
            if (row.scannedId.isBlank() || row.scannedId.length < 8) continue

            val cleanId = row.scannedId.filter { it.isLetterOrDigit() }
            val eightDigitId = if (cleanId.length >= 8) {
                cleanId.substring(cleanId.length - 8).uppercase()
            } else {
                cleanId.uppercase()
            }

            if (eightDigitId.length != 8) continue

            val lifeStage = if (row.lastKnownLifeStage.isNotBlank()) {
                try {
                    LifeStage.valueOf(row.lastKnownLifeStage)
                } catch (_: IllegalArgumentException) {
                    LifeStage.Adult
                }
            } else {
                LifeStage.Adult
            }

            val chipDate = try {
                // Parse date string - try common formats
                val parts = row.chipDate.split("/", "-")
                if (parts.size >= 3) {
                    val day = parts[0].toIntOrNull() ?: 1
                    val month = parts[1].toIntOrNull() ?: 1
                    val year = parts[2].toIntOrNull() ?: 2000
                    val localDate = java.time.LocalDate.of(year, month, day)
                    Instant.fromEpochSeconds(
                        localDate.atStartOfDay(java.time.ZoneOffset.UTC).toEpochSecond()
                    )
                } else {
                    Instant.DISTANT_PAST
                }
            } catch (_: Exception) {
                Instant.DISTANT_PAST
            }

            remotePenguinData[eightDigitId] = PenguinData(
                scannedId = eightDigitId,
                lastKnownLifeStage = lifeStage,
                sex = row.sex,
                vidForScanner = row.vidForScanner,
                chipDate = chipDate,
                chipAs = row.chipAs.trim()
            )
        }

        _penguinData.value = remotePenguinData
        localDataSource.savePenguinData(remotePenguinData)
    }
}
