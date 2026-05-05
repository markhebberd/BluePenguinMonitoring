package nz.co.penguinmonitor.data.repository

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import nz.co.penguinmonitor.data.local.PenguinLocalDataSource
import nz.co.penguinmonitor.model.BoxPredictedDates
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class BreedingDateRepository @Inject constructor(
    private val localDataSource: PenguinLocalDataSource
) {
    private val _breedingDates = MutableStateFlow<Map<String, BoxPredictedDates>>(emptyMap())
    val breedingDates: StateFlow<Map<String, BoxPredictedDates>> = _breedingDates.asStateFlow()

    suspend fun load() {
        _breedingDates.value = localDataSource.loadBreedingDates()
    }

    suspend fun save(dates: Map<String, BoxPredictedDates>) {
        _breedingDates.value = dates
        localDataSource.saveBreedingDates(dates)
    }
}
