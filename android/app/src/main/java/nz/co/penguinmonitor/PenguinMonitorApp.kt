package nz.co.penguinmonitor

import android.app.Application
import dagger.hilt.android.HiltAndroidApp
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch
import nz.co.penguinmonitor.data.repository.BoxTagRepository
import nz.co.penguinmonitor.data.repository.MonitorRepository
import nz.co.penguinmonitor.data.repository.PenguinRepository
import nz.co.penguinmonitor.data.repository.SettingsRepository
import javax.inject.Inject

@HiltAndroidApp
class PenguinMonitorApp : Application() {

    @Inject lateinit var settingsRepository: SettingsRepository
    @Inject lateinit var monitorRepository: MonitorRepository
    @Inject lateinit var penguinRepository: PenguinRepository
    @Inject lateinit var boxTagRepository: BoxTagRepository

    override fun onCreate() {
        super.onCreate()

        MainScope().launch {
            // Load all persisted data from disk
            settingsRepository.load()
            monitorRepository.load()
            penguinRepository.load()

            val s = settingsRepository.settings.value

            // Initialize box tags API from BuildConfig if not already configured
            val apiUrl = if (s.boxTagsApiUrl.isNotBlank()) s.boxTagsApiUrl else BuildConfig.BOX_TAGS_API_URL
            val apiKey = if (s.boxTagsApiKey.isNotBlank()) s.boxTagsApiKey else BuildConfig.BOX_TAGS_API_KEY
            if (apiUrl.isNotBlank() && apiKey.isNotBlank()) {
                if (!s.isBoxTagsApiConfigured) {
                    settingsRepository.update { it.copy(boxTagsApiUrl = apiUrl, boxTagsApiKey = apiKey) }
                }
                boxTagRepository.initializeApi(apiUrl, apiKey)
            }
            boxTagRepository.load()

            // Set default box sets if empty (Tarakohe colony)
            if (s.allBoxSetsString.isBlank()) {
                settingsRepository.update { it.copy(allBoxSetsString = "{1-150,AA-AC}") }
            }

            // Auto-download if no monitor data exists
            val hasData = monitorRepository.allMonitorData.value.any { (_, m) -> m.boxData.isNotEmpty() }
            if (!hasData) {
                try {
                    val penguinJob = launch { penguinRepository.downloadAndRefresh() }
                    val monitorJob = launch { monitorRepository.downloadRemoteMonitors() }
                    val tagJob = launch {
                        if (boxTagRepository.isApiConfigured) boxTagRepository.syncWithApi()
                    }
                    penguinJob.join()
                    monitorJob.join()
                    tagJob.join()
                    monitorRepository.save(reportHome = false)
                } catch (_: Exception) { }
            }
        }
    }
}
