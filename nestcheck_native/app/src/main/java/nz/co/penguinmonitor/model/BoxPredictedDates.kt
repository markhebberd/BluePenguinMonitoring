package nz.co.penguinmonitor.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import kotlin.math.ceil

@Serializable
data class BoxPredictedDates(
    @SerialName("boxNumber") val boxNumber: Int = 0,
    @SerialName("estHatchDate") val estHatchDate: String = "",
    @SerialName("estPGDate") val estPGDate: String = "",
    @SerialName("estFledgeDate") val estFledgeDate: String = "",
    @SerialName("chipWindowStart") val chipWindowStart: String = "",
    @SerialName("chipWindowFinish") val chipWindowFinish: String = ""
) {
    fun breedingDateStatus(): String {
        return try {
            val today = LocalDate.now()
            val formatter = DateTimeFormatter.ofPattern("d/M/yyyy")

            if (estHatchDate.isNotBlank()) {
                val hatch = LocalDate.parse(estHatchDate, formatter)
                if (!hatch.plusDays(3).isBefore(today)) {
                    return "Hatch${getDateString(hatch)}"
                }
            }
            if (estPGDate.isNotBlank()) {
                val pg = LocalDate.parse(estPGDate, formatter)
                if (!pg.plusDays(3).isBefore(today)) {
                    return "PG${getDateString(pg)}"
                }
            }
            if (chipWindowStart.isNotBlank()) {
                val chip = LocalDate.parse(chipWindowStart, formatter)
                if (!chip.plusDays(3).isBefore(today)) {
                    return "Chip${getDateString(chip)}"
                }
            }
            if (estFledgeDate.isNotBlank()) {
                val fledge = LocalDate.parse(estFledgeDate, formatter)
                if (!fledge.plusDays(3).isBefore(today)) {
                    return "Fledge${getDateString(fledge)}"
                }
            }
            ""
        } catch (_: Exception) {
            "No dates in sheet"
        }
    }

    companion object {
        fun getDateString(expectedDate: LocalDate): String {
            val today = LocalDate.now()
            val daysDiff = ChronoUnit.DAYS.between(today, expectedDate)
            return when {
                daysDiff == 0L -> " today"
                daysDiff == 1L -> " tomorrow"
                daysDiff == -1L -> " yesterday"
                daysDiff > 0 -> " $daysDiff days"
                else -> " ${-daysDiff} days ago"
            }
        }
    }
}
