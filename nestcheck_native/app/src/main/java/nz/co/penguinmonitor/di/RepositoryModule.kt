package nz.co.penguinmonitor.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import nz.co.penguinmonitor.data.local.BoxTagLocalDataSource
import nz.co.penguinmonitor.data.local.MonitorDataStore
import nz.co.penguinmonitor.data.local.PenguinLocalDataSource
import nz.co.penguinmonitor.data.local.SettingsDataStore
import nz.co.penguinmonitor.data.remote.GoogleSheetsCsvService
import nz.co.penguinmonitor.data.remote.LegacyBackend
import nz.co.penguinmonitor.data.repository.BoxTagRepository
import nz.co.penguinmonitor.data.repository.BreedingDateRepository
import nz.co.penguinmonitor.data.repository.MonitorRepository
import nz.co.penguinmonitor.data.repository.PenguinRepository
import nz.co.penguinmonitor.data.repository.SettingsRepository
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object RepositoryModule {

    @Provides
    @Singleton
    fun provideMonitorRepository(
        monitorDataStore: MonitorDataStore,
        @Suppress("DEPRECATION") legacyBackend: LegacyBackend
    ): MonitorRepository {
        return MonitorRepository(monitorDataStore, legacyBackend)
    }

    @Provides
    @Singleton
    fun provideBoxTagRepository(
        localDataSource: BoxTagLocalDataSource
    ): BoxTagRepository {
        return BoxTagRepository(localDataSource)
    }

    @Provides
    @Singleton
    fun providePenguinRepository(
        localDataSource: PenguinLocalDataSource,
        csvService: GoogleSheetsCsvService
    ): PenguinRepository {
        return PenguinRepository(localDataSource, csvService)
    }

    @Provides
    @Singleton
    fun provideSettingsRepository(
        settingsDataStore: SettingsDataStore
    ): SettingsRepository {
        return SettingsRepository(settingsDataStore)
    }

    @Provides
    @Singleton
    fun provideBreedingDateRepository(
        localDataSource: PenguinLocalDataSource
    ): BreedingDateRepository {
        return BreedingDateRepository(localDataSource)
    }
}
