package nz.co.penguinmonitor.data.local

import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import nz.co.penguinmonitor.model.BoxTag
import nz.co.penguinmonitor.util.Constants
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class BoxTagLocalDataSource @Inject constructor(
    private val storage: JsonFileStorage
) {
    private val serializer = MapSerializer(String.serializer(), BoxTag.serializer())

    suspend fun loadBoxTags(): Map<String, BoxTag> {
        return storage.read(Constants.BOX_TAGS_FILENAME, serializer) ?: emptyMap()
    }

    suspend fun saveBoxTags(tags: Map<String, BoxTag>) {
        storage.write(Constants.BOX_TAGS_FILENAME, serializer, tags)
    }
}
