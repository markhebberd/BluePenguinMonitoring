package nz.co.penguinmonitor.util

object Constants {
    const val HR5_BLUETOOTH_ADDRESS = "00:07:80:E6:95:52"
    const val SERIAL_PORT_PROFILE_UUID = "00001101-0000-1000-8000-00805F9B34FB"

    const val ALL_PENGS_URL = "https://docs.google.com/spreadsheets/d/1A2j56iz0_VNHiWNJORAzGDqTbZsEd76j-YI_gQZsDEE"

    const val LEGACY_SERVER_IP = "210.54.37.120"
    const val LEGACY_SERVER_PORT = 8080
    const val LEGACY_PASSPHRASE = "bbnmdsfhsecureafdgsadsadff"
    const val LEGACY_VERSION = 58

    const val APP_SETTINGS_FILENAME = "app_settings.json"
    const val ALL_MONITOR_DATA_FILENAME = "penguin_data_autosave.json"
    const val REMOTE_BIRD_DATA_FILENAME = "remotePenguinData.json"
    const val REMOTE_BOX_DATA_FILENAME = "remoteBoxData.json"
    const val BREEDING_DATES_FILENAME = "predictedDates.json"
    const val BOX_TAGS_FILENAME = "box_tags.json"

    const val BOX_TAG_PREFIX = "LA9000250"
    const val PENGUIN_TAG_PREFIX = "LA9560000"

    // Bluetooth connection parameters
    const val CONNECTION_TIMEOUT_MS = 10_000L
    const val INITIAL_RETRY_DELAY_MS = 2_000L
    const val MAX_RETRY_DELAY_MS = 30_000L
    const val BACKOFF_MULTIPLIER = 1.5
}
