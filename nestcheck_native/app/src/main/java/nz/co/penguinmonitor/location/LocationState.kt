package nz.co.penguinmonitor.location

data class LocationState(
    val latitude: Double = 0.0,
    val longitude: Double = 0.0,
    val accuracy: Float = -1f,
    val isAvailable: Boolean = false
)
