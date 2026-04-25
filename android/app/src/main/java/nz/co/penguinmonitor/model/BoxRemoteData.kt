package nz.co.penguinmonitor.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class BoxRemoteData(
    @SerialName("boxNumber") val boxNumber: Int = 0,
    @SerialName("eggChickStatusText") val eggChickStatusText: String = "",
    @SerialName("breedingLikelyhoodText") val breedingLikelihoodText: String = "",
    @SerialName("StickyNotes") val stickyNotes: String = ""
) {
    fun numEggs(): Int {
        if (eggChickStatusText.isBlank()) return 0
        val parts = eggChickStatusText.trim().split("\\s+".toRegex())
        val totalX = parts.getOrNull(0)?.count { it == 'x' } ?: 0
        return totalX - numChicks()
    }

    fun numChicks(): Int {
        if (eggChickStatusText.isBlank()) return 0
        val parts = eggChickStatusText.trim().split("\\s+".toRegex())
        return parts.getOrNull(1)?.count { it == 'x' } ?: 0
    }

    fun boxMiniStatus(numEggs: Int?, numChicks: Int?): String {
        val sb = StringBuilder()
        val eggs = numEggs ?: 0
        val chicks = numChicks ?: 0
        repeat(eggs) { sb.append("\uD83E\uDD5A") } // egg emoji
        repeat(chicks) { sb.append("\uD83D\uDC23") } // hatching chick emoji
        if (sb.isEmpty()) {
            if (breedingLikelihoodText.isNotBlank()) {
                return "($breedingLikelihoodText)"
            }
            return ""
        }
        return "($sb)"
    }
}
