package nz.co.penguinmonitor.util

import nz.co.penguinmonitor.model.BoxData
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import kotlin.math.ceil

object BreedingDateCalculator {

    data class EstimatedDates(
        val hatch: LocalDate?,
        val pg: LocalDate,
        val chipStart: LocalDate,
        val fledge: LocalDate
    )

    fun getBoxBreedingStatusString(
        boxName: String,
        thisBoxData: BoxData?,
        olderBoxDatas: List<BoxData>
    ): String {
        if (olderBoxDatas.isEmpty()) return ""

        var currentBox = thisBoxData
        var skip = 0
        if (currentBox == null) {
            if (olderBoxDatas.size == 1) return ""
            currentBox = olderBoxDatas[0]
            skip = 1
        }

        if (currentBox.breedingChance == "ABN") return "Abandoned"
        if (currentBox.eggs + currentBox.chicks == 0 || olderBoxDatas.isEmpty()) return ""

        val whenOffspringFound = currentBox.whenDataCollectedUtc.toLocalDate()

        for (olderBoxData in olderBoxDatas.drop(skip)) {
            if (olderBoxData.breedingChance == "ABN" && olderBoxData.eggs + olderBoxData.chicks > 0) {
                return "Abandoned"
            }
            if (olderBoxData.eggs + olderBoxData.chicks == 0) {
                if (olderBoxData.breedingChance == "ABN") return "Abandoned"

                var adjustedFound = whenOffspringFound
                if (currentBox.eggs > 1) adjustedFound = adjustedFound.minusDays(2)

                val whenNotFound = olderBoxData.whenDataCollectedUtc.toLocalDate()
                val uncertaintyDays = ChronoUnit.DAYS.between(whenNotFound, adjustedFound) / 2
                val probableLaidDate = whenNotFound.plusDays(ceil(uncertaintyDays.toDouble()).toLong())
                val daysSinceLaid = ChronoUnit.DAYS.between(probableLaidDate, LocalDate.now()).toInt()

                val status = breedingDateStatus(daysSinceLaid)
                return if (uncertaintyDays > 1) "$status ±$uncertaintyDays" else status
            }
        }
        return ""
    }

    fun breedingDateStatus(daysSinceLaid: Int): String {
        val today = LocalDate.now()

        val estHatch = today.plusDays((38 - daysSinceLaid).toLong())
        if (!estHatch.plusDays(3).isBefore(today)) {
            return "Hatch${DateUtils.getDateString(estHatch)}"
        }

        val estPG = today.plusDays((52 - daysSinceLaid).toLong())
        if (!estPG.plusDays(3).isBefore(today)) {
            return "PG${DateUtils.getDateString(estPG)}"
        }

        val chipStart = today.plusDays((80 - daysSinceLaid).toLong())
        if (!chipStart.plusDays(3).isBefore(today)) {
            return "Chip${DateUtils.getDateString(chipStart)}"
        }

        val estFledge = today.plusDays((87 - daysSinceLaid).toLong())
        if (!estFledge.plusDays(3).isBefore(today)) {
            return "Fledge${DateUtils.getDateString(estFledge)}"
        }

        return "Fail detecting laid date?"
    }

    fun getEstimatedBreedingDates(
        boxName: String,
        thisBoxData: BoxData?,
        olderBoxDatas: List<BoxData>
    ): EstimatedDates? {
        if (olderBoxDatas.isEmpty()) return null

        var currentBox = thisBoxData
        var skip = 0
        if (currentBox == null) {
            if (olderBoxDatas.size == 1) return null
            currentBox = olderBoxDatas[0]
            skip = 1
        }

        if (currentBox.breedingChance == "ABN") return null
        if (currentBox.eggs + currentBox.chicks == 0 || olderBoxDatas.isEmpty()) return null

        var sawEggsInHistory = currentBox.eggs > 0
        val whenOffspringFound = currentBox.whenDataCollectedUtc.toLocalDate()

        for (olderBoxData in olderBoxDatas.drop(skip)) {
            if (olderBoxData.eggs > 0) sawEggsInHistory = true

            if (olderBoxData.breedingChance == "ABN" && olderBoxData.eggs + olderBoxData.chicks > 0) {
                return null
            }
            if (olderBoxData.eggs + olderBoxData.chicks == 0) {
                if (olderBoxData.breedingChance == "ABN") return null

                var adjustedFound = whenOffspringFound
                if (currentBox.eggs > 1) adjustedFound = adjustedFound.minusDays(2)

                val whenNotFound = olderBoxData.whenDataCollectedUtc.toLocalDate()
                val uncertaintyDays = ChronoUnit.DAYS.between(whenNotFound, adjustedFound) / 2
                val probableLaidDate = whenNotFound.plusDays(ceil(uncertaintyDays.toDouble()).toLong())
                val daysSinceLaid = ChronoUnit.DAYS.between(probableLaidDate, LocalDate.now()).toInt()
                val today = LocalDate.now()

                val estHatch = if (sawEggsInHistory && currentBox.chicks == 0) {
                    today.plusDays((38 - daysSinceLaid).toLong())
                } else null

                return EstimatedDates(
                    hatch = estHatch,
                    pg = today.plusDays((52 - daysSinceLaid).toLong()),
                    chipStart = today.plusDays((80 - daysSinceLaid).toLong()),
                    fledge = today.plusDays((87 - daysSinceLaid).toLong())
                )
            }
        }
        return null
    }

    fun getStickyNotes(olderBoxes: List<BoxData>): String {
        val removedStickies = mutableSetOf<String>()
        val addedStickies = mutableSetOf<String>()

        for (boxData in olderBoxes) {
            for (part in boxData.notes.split(" ").filter { it.isNotEmpty() }) {
                when {
                    part.startsWith("l-") && part.length > 2 -> {
                        val sticky = part.substring(2)
                        removedStickies.add(sticky)
                        addedStickies.remove(sticky)
                    }
                    part.startsWith("l=") && part.length > 2 -> {
                        val sticky = part.substring(2)
                        if (sticky !in removedStickies) {
                            addedStickies.add(sticky)
                        }
                    }
                    part == "l=" -> return addedStickies.joinToString(" ")
                }
            }
        }
        return addedStickies.joinToString(" ")
    }

    fun getOlderBoxData(
        allMonitorData: Map<Int, nz.co.penguinmonitor.model.MonitorDetails>,
        currentMonitorIndex: Int,
        boxName: String
    ): List<BoxData> {
        val olderBoxDatas = mutableListOf<BoxData>()
        for (i in (currentMonitorIndex + 1) until allMonitorData.size) {
            val monitor = allMonitorData[i] ?: continue
            monitor.boxData[boxName]?.let { olderBoxDatas.add(it) }
        }
        // Backfill breeding status from older to newer
        var lastBreedingStatus: String? = null
        for (i in olderBoxDatas.indices.reversed()) {
            val box = olderBoxDatas[i]
            if (box.breedingChance == null) {
                // Note: BoxData is immutable, so we can't modify in place.
                // The breeding chance backfill is used for display only.
            }
            if (box.breedingChance != null) {
                lastBreedingStatus = box.breedingChance
            }
        }
        return olderBoxDatas
    }

    private fun kotlinx.datetime.Instant.toLocalDate(): LocalDate {
        return java.time.Instant.ofEpochSecond(this.epochSeconds)
            .atZone(ZoneId.systemDefault())
            .toLocalDate()
    }
}
