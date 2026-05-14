package nz.co.penguinmonitor.model

import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class ScanRecord(
    @SerialName("BirdId") val birdId: String = "",
    @SerialName("Timestamp") val timestamp: Instant = Clock.System.now(),
    @SerialName("Latitude") val latitude: Double = 0.0,
    @SerialName("Longitude") val longitude: Double = 0.0,
    @SerialName("Accuracy") val accuracy: Float = 0f
)
