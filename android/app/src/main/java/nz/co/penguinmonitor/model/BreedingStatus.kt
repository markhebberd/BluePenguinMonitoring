package nz.co.penguinmonitor.model

enum class BreedingStatus(val code: String, val label: String) {
    NONE("", ""),
    NO_DATA("NO", "No data"),
    UNLIKELY("UNL", "Unlikely"),
    POTENTIAL("POT", "Potential"),
    CONFIDENT("CON", "Confident"),
    BREEDING("BR", "Breeding"),
    DCM("DCM", "DCM"),
    ABN("ABN", "Abandoned");

    companion object {
        fun fromCode(code: String?): BreedingStatus {
            return entries.find { it.code == code } ?: NONE
        }

        val spinnerOptions = listOf("", "NO", "UNL", "POT", "CON", "BR", "ABN", "DCM")
        val gateStatusOptions = listOf("", "Gate up", "Regate")
    }
}
