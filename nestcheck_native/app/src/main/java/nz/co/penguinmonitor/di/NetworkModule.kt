package nz.co.penguinmonitor.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import nz.co.penguinmonitor.data.remote.GoogleSheetsCsvService
import nz.co.penguinmonitor.data.remote.LegacyBackend
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    @Provides
    @Singleton
    fun provideGoogleSheetsCsvService(): GoogleSheetsCsvService {
        return GoogleSheetsCsvService()
    }

    @Suppress("DEPRECATION")
    @Provides
    @Singleton
    fun provideLegacyBackend(): LegacyBackend {
        return LegacyBackend()
    }
}
