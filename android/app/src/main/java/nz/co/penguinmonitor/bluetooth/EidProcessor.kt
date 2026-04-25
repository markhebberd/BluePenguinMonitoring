package nz.co.penguinmonitor.bluetooth

import nz.co.penguinmonitor.util.Constants
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class EidProcessor @Inject constructor() {

    fun cleanEid(raw: String): String? {
        val cleaned = raw.filter { it.isLetterOrDigit() }
        return if (cleaned.length >= 10) cleaned else null
    }

    fun isBoxTag(cleanEid: String): Boolean {
        return cleanEid.length >= 9 &&
                cleanEid.substring(0, 9).equals(Constants.BOX_TAG_PREFIX, ignoreCase = true)
    }

    fun isPenguinTag(cleanEid: String): Boolean {
        return cleanEid.length >= 9 &&
                cleanEid.substring(0, 9).equals(Constants.PENGUIN_TAG_PREFIX, ignoreCase = true)
    }

    fun extractEightDigitId(cleanEid: String): String {
        return if (cleanEid.length >= 8) {
            cleanEid.substring(cleanEid.length - 8).uppercase()
        } else {
            cleanEid.uppercase()
        }
    }
}
