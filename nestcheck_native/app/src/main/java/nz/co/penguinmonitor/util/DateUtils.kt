package nz.co.penguinmonitor.util

import java.time.LocalDate
import java.time.temporal.ChronoUnit

object DateUtils {
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
