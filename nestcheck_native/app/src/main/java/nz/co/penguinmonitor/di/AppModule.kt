package nz.co.penguinmonitor.di

import android.content.Context
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import nz.co.penguinmonitor.data.local.BoxTagLocalDataSource
import nz.co.penguinmonitor.data.local.JsonFileStorage
import nz.co.penguinmonitor.data.local.MonitorDataStore
import nz.co.penguinmonitor.data.local.PenguinLocalDataSource
import nz.co.penguinmonitor.data.local.SettingsDataStore
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    fun provideJsonFileStorage(@ApplicationContext context: Context): JsonFileStorage {
        return JsonFileStorage(context)
    }

    @Provides
    @Singleton
    fun provideMonitorDataStore(storage: JsonFileStorage): MonitorDataStore {
        return MonitorDataStore(storage)
    }

    @Provides
    @Singleton
    fun provideSettingsDataStore(storage: JsonFileStorage): SettingsDataStore {
        return SettingsDataStore(storage)
    }

    @Provides
    @Singleton
    fun provideBoxTagLocalDataSource(storage: JsonFileStorage): BoxTagLocalDataSource {
        return BoxTagLocalDataSource(storage)
    }

    @Provides
    @Singleton
    fun providePenguinLocalDataSource(storage: JsonFileStorage): PenguinLocalDataSource {
        return PenguinLocalDataSource(storage)
    }
}
