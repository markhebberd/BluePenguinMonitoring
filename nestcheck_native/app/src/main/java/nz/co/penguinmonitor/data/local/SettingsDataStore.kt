package nz.co.penguinmonitor.data.local

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import nz.co.penguinmonitor.model.AppSettings
import nz.co.penguinmonitor.util.Constants
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class SettingsDataStore @Inject constructor(
    private val storage: JsonFileStorage
) {
    private val _settings = MutableStateFlow(AppSettings())
    val settings: StateFlow<AppSettings> = _settings.asStateFlow()

    suspend fun load(): AppSettings {
        val loaded = storage.read(Constants.APP_SETTINGS_FILENAME, AppSettings.serializer())
            ?: AppSettings()
        _settings.value = loaded
        return loaded
    }

    suspend fun save(settings: AppSettings) {
        _settings.value = settings
        storage.write(Constants.APP_SETTINGS_FILENAME, AppSettings.serializer(), settings)
    }

    suspend fun update(transform: (AppSettings) -> AppSettings) {
        val updated = transform(_settings.value)
        save(updated)
    }
}
