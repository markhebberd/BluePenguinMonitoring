package nz.co.penguinmonitor.data.remote

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import nz.co.penguinmonitor.model.BirdCsvRowData
import nz.co.penguinmonitor.model.BoxPredictedDates
import nz.co.penguinmonitor.util.CsvParser
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.URI
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class GoogleSheetsCsvService @Inject constructor() {

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

    suspend fun downloadCsv(url: String): String = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(url).get().build()
        val response = client.newCall(request).execute()
        response.use {
            if (!it.isSuccessful) throw Exception("HTTP ${it.code}")
            it.body?.string() ?: throw Exception("Empty response")
        }
    }

    fun parseBirdCsv(csvContent: String): List<BirdCsvRowData> {
        val lines = csvContent.split('\n').filter { it.isNotBlank() }
        if (lines.size <= 1) return emptyList()

        return lines.drop(1).mapNotNull { line ->
            try {
                val cols = CsvParser.parseLine(line.trim())
                // Pad to at least 38 columns
                val padded = cols.toMutableList()
                while (padded.size < 38) padded.add("")

                BirdCsvRowData(
                    number = padded[0],
                    scannedId = padded[1],
                    chipDate = padded[2],
                    sex = padded[3],
                    vidForScanner = padded[4],
                    plusBoxes = padded[5],
                    chipBox = padded[6],
                    breedBox2021 = padded[7],
                    breedBox2022 = padded[8],
                    breedBox2023 = padded[9],
                    breedBox2024 = padded[10],
                    breedBox2025 = padded[11],
                    lastKnownLifeStage = padded[12],
                    nestSuccess2021 = padded[13],
                    reClutch21 = padded[14],
                    nestSuccess2022 = padded[15],
                    reClutch22 = padded[16],
                    nestSuccess2023 = padded[17],
                    reClutch23 = padded[18],
                    nestSuccess2024 = padded[19],
                    reClutch24 = padded[20],
                    chipBy = padded[21],
                    chipAs = padded[22],
                    chipOk = padded[23],
                    chipWeight = padded[24],
                    flipperLength = padded[25],
                    persistence = padded[26],
                    alarmsScanner = padded[27],
                    wasSingle = padded[28],
                    chickSizeSex = padded[29],
                    chickReturnDate = padded[30],
                    reChip = padded[31],
                    reChipBy = padded[32],
                    activeChip2 = padded[33],
                    rechipDate = padded[34],
                    fullIso15Digits = padded[35],
                    solo = padded.getOrElse(36) { "" },
                    kommentar = padded.getOrElse(37) { "" }
                )
            } catch (_: Exception) {
                null
            }
        }
    }

    fun parseBreedingDatesCsv(csvContent: String): List<BoxPredictedDates> {
        val lines = csvContent.split('\n').filter { it.isNotBlank() }
        if (lines.size <= 1) return emptyList()

        return lines.drop(1).mapNotNull { line ->
            try {
                val cols = CsvParser.parseLine(line.trim())
                val padded = cols.toMutableList()
                while (padded.size < 14) padded.add("")

                BoxPredictedDates(
                    boxNumber = padded[2].toIntOrNull() ?: return@mapNotNull null,
                    estHatchDate = padded[5],
                    estPGDate = padded[8],
                    estFledgeDate = padded[10],
                    chipWindowStart = padded[12],
                    chipWindowFinish = padded[13]
                )
            } catch (_: Exception) {
                null
            }
        }
    }

    fun convertToGoogleSheetsCsvUrl(shareUrl: String): String {
        val uri = URI(shareUrl)
        val segments = uri.path.split('/')
        val dIndex = segments.indexOf("d")
        if (dIndex < 0 || dIndex + 1 >= segments.size) {
            throw IllegalArgumentException("Could not extract spreadsheet ID from URL")
        }
        val spreadsheetId = segments[dIndex + 1]
        return "https://docs.google.com/spreadsheets/d/$spreadsheetId/export?format=csv"
    }
}
