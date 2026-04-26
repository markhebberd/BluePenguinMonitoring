package nz.co.penguinmonitor.model

enum class BreedingStatus(val code: String, val label: String) {
    NONE("", ""),
    NO_DATA("NO", "No"),
    UNLIKELY("UNL", "Unlikely"),
    POTENTIAL("POT", "Potential"),
    CONFIDENT("CON", "Confident"),
    DCM("DCM", "DCM"),
    ABN("ABN", "Abandoned");

    companion object {
        fun fromCode(code: String?): BreedingStatus {
            return entries.find { it.code == code } ?: NONE
        }

        // BR removed - Guard is derived from egg/chick presence
        val spinnerOptions = listOf("", "NO", "UNL", "POT", "CON", "ABN", "DCM")
        val gateStatusOptions = listOf("", "Gate up", "Regate")
    }
}
