package nz.co.penguinmonitor.util

object CsvParser {
    fun parseLine(line: String): List<String> {
        val result = mutableListOf<String>()
        val currentField = StringBuilder()
        var inQuotes = false

        var i = 0
        while (i < line.length) {
            val c = line[i]
            when {
                c == '"' -> {
                    if (inQuotes && i + 1 < line.length && line[i + 1] == '"') {
                        currentField.append('"')
                        i++ // skip escaped quote
                    } else {
                        inQuotes = !inQuotes
                    }
                }
                c == ',' && !inQuotes -> {
                    result.add(currentField.toString())
                    currentField.clear()
                }
                else -> currentField.append(c)
            }
            i++
        }
        result.add(currentField.toString())
        return result
    }
}
