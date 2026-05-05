package nz.co.penguinmonitor.data.local

import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import nz.co.penguinmonitor.model.BoxPredictedDates
import nz.co.penguinmonitor.model.PenguinData
import nz.co.penguinmonitor.util.Constants
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class PenguinLocalDataSource @Inject constructor(
    private val storage: JsonFileStorage
) {
    private val penguinSerializer = MapSerializer(String.serializer(), PenguinData.serializer())
    private val breedingDatesSerializer = MapSerializer(String.serializer(), BoxPredictedDates.serializer())

    suspend fun loadPenguinData(): Map<String, PenguinData> {
        return storage.read(Constants.REMOTE_BIRD_DATA_FILENAME, penguinSerializer) ?: emptyMap()
    }

    suspend fun savePenguinData(data: Map<String, PenguinData>) {
        storage.write(Constants.REMOTE_BIRD_DATA_FILENAME, penguinSerializer, data)
    }

    suspend fun loadBreedingDates(): Map<String, BoxPredictedDates> {
        return storage.read(Constants.BREEDING_DATES_FILENAME, breedingDatesSerializer) ?: emptyMap()
    }

    suspend fun saveBreedingDates(data: Map<String, BoxPredictedDates>) {
        storage.write(Constants.BREEDING_DATES_FILENAME, breedingDatesSerializer, data)
    }
}
