package nz.co.penguinmonitor.data.repository

import kotlinx.coroutines.flow.StateFlow
import nz.co.penguinmonitor.data.local.SettingsDataStore
import nz.co.penguinmonitor.model.AppSettings
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class SettingsRepository @Inject constructor(
    private val settingsDataStore: SettingsDataStore
) {
    val settings: StateFlow<AppSettings> = settingsDataStore.settings

    suspend fun load(): AppSettings = settingsDataStore.load()

    suspend fun save(settings: AppSettings) = settingsDataStore.save(settings)

    suspend fun update(transform: (AppSettings) -> AppSettings) = settingsDataStore.update(transform)
}
