package nz.co.penguinmonitor.di

import android.content.Context
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import nz.co.penguinmonitor.bluetooth.BluetoothManagerService
import nz.co.penguinmonitor.bluetooth.EidProcessor
import nz.co.penguinmonitor.location.LocationService
import nz.co.penguinmonitor.util.AlertService
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object BluetoothModule {

    @Provides
    @Singleton
    fun provideBluetoothManagerService(): BluetoothManagerService {
        return BluetoothManagerService()
    }

    @Provides
    @Singleton
    fun provideEidProcessor(): EidProcessor {
        return EidProcessor()
    }

    @Provides
    @Singleton
    fun provideLocationService(@ApplicationContext context: Context): LocationService {
        return LocationService(context)
    }

    @Provides
    @Singleton
    fun provideAlertService(@ApplicationContext context: Context): AlertService {
        return AlertService(context)
    }
}
