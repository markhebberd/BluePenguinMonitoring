package nz.co.penguinmonitor.util

/**
 * Parses box set definitions like "{1-150,AA-AC},{N1-N6}" into ordered box name lists.
 */
object BoxSetParser {

    data class BoxSetDefinition(
        val name: String,
        val boxNames: List<String>
    )

    fun parseAllBoxSets(allBoxSetsString: String): List<BoxSetDefinition> {
        if (allBoxSetsString.isBlank()) return emptyList()

        val sets = mutableListOf<BoxSetDefinition>()
        val regex = Regex("\\{([^}]+)\\}")
        val matches = regex.findAll(allBoxSetsString)

        for ((index, match) in matches.withIndex()) {
            val content = match.groupValues[1]
            val boxNames = parseBoxSetContent(content)
            sets.add(BoxSetDefinition("Set ${index + 1}", boxNames))
        }

        return sets
    }

    fun parseBoxSetContent(content: String): List<String> {
        val result = mutableListOf<String>()
        val parts = content.split(',').map { it.trim() }

        for (part in parts) {
            if (part.contains('-')) {
                val rangeParts = part.split('-', limit = 2)
                if (rangeParts.size == 2) {
                    val start = rangeParts[0].trim()
                    val end = rangeParts[1].trim()
                    result.addAll(expandRange(start, end))
                }
            } else {
                result.add(part)
            }
        }
        return result
    }

    private fun expandRange(start: String, end: String): List<String> {
        // Try numeric range first
        val startNum = start.toIntOrNull()
        val endNum = end.toIntOrNull()
        if (startNum != null && endNum != null) {
            return (startNum..endNum).map { it.toString() }
        }

        // Try alphabetic range (e.g., AA-AC)
        if (start.length == end.length && start.all { it.isLetter() } && end.all { it.isLetter() }) {
            return expandAlphaRange(start, end)
        }

        // Try prefix+number range (e.g., N1-N6)
        val startPrefix = start.takeWhile { it.isLetter() }
        val endPrefix = end.takeWhile { it.isLetter() }
        if (startPrefix == endPrefix && startPrefix.isNotEmpty()) {
            val startSuffix = start.removePrefix(startPrefix).toIntOrNull()
            val endSuffix = end.removePrefix(endPrefix).toIntOrNull()
            if (startSuffix != null && endSuffix != null) {
                return (startSuffix..endSuffix).map { "$startPrefix$it" }
            }
        }

        return listOf(start, end)
    }

    private fun expandAlphaRange(start: String, end: String): List<String> {
        val result = mutableListOf<String>()
        var current = start
        while (current <= end) {
            result.add(current)
            current = incrementAlpha(current)
            if (result.size > 1000) break // safety limit
        }
        return result
    }

    private fun incrementAlpha(s: String): String {
        val chars = s.toCharArray()
        var carry = true
        for (i in chars.indices.reversed()) {
            if (carry) {
                if (chars[i] < 'Z') {
                    chars[i]++
                    carry = false
                } else {
                    chars[i] = 'A'
                }
            }
        }
        return if (carry) "A${String(chars)}" else String(chars)
    }

    fun createBoxDictionary(boxSetString: String, allBoxSetsString: String): Map<String, Int> {
        val allSets = parseAllBoxSets(allBoxSetsString)
        val selectedBoxNames = if (boxSetString.isBlank() || boxSetString == "All") {
            allSets.flatMap { it.boxNames }
        } else {
            val selectedSet = allSets.find { it.name == boxSetString }
            selectedSet?.boxNames ?: allSets.flatMap { it.boxNames }
        }

        return selectedBoxNames.withIndex().associate { (index, name) -> name to (index + 1) }
    }
}
