package nz.co.penguinmonitor.model

import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class MonitorDetails(
    @SerialName("IsDeleted") val isDeleted: Boolean = false,
    @SerialName("DeletionReason") val deletionReason: String? = null,
    @SerialName("LastSaved") val lastSaved: Instant = Clock.System.now(),
    @SerialName("filename") val filename: String = "",
    @SerialName("BoxData") val boxData: Map<String, BoxData> = emptyMap()
)
