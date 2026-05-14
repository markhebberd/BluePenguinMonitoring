package nz.co.penguinmonitor.model

import kotlinx.datetime.Instant
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class LifeStage {
    Adult,
    Chick,
    Returnee,
    Dead
}

@Serializable
data class PenguinData(
    @SerialName("ScannedId") val scannedId: String = "",
    @SerialName("LastKnownLifeStage") val lastKnownLifeStage: LifeStage = LifeStage.Adult,
    @SerialName("ChipDate") val chipDate: Instant = Instant.DISTANT_PAST,
    @SerialName("Sex") val sex: String = "",
    @SerialName("VidForScanner") val vidForScanner: String = "",
    @SerialName("ChipAs") val chipAs: String = ""
)
