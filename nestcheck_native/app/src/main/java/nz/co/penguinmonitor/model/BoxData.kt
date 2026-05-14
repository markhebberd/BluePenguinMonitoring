package nz.co.penguinmonitor.model

import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class BoxData(
    @SerialName("ScannedIds") val scannedIds: List<ScanRecord> = emptyList(),
    @SerialName("Adults") val adults: Int = 0,
    @SerialName("Eggs") val eggs: Int = 0,
    @SerialName("Chicks") val chicks: Int = 0,
    @SerialName("GateStatus") val gateStatus: String? = null,
    @SerialName("Notes") val notes: String = "",
    @SerialName("whenDataCollectedUtc") val whenDataCollectedUtc: Instant = Clock.System.now(),
    @SerialName("BreedingChance") val breedingChance: String? = null
)
