package nz.co.penguinmonitor.data.local

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class JsonFileStorage @Inject constructor(
    @ApplicationContext private val context: Context
) {
    val json = Json {
        ignoreUnknownKeys = true
        prettyPrint = true
        encodeDefaults = true
        isLenient = true
    }

    val filesDir: String
        get() = context.filesDir.absolutePath

    val downloadsDir: File
        get() = android.os.Environment.getExternalStoragePublicDirectory(
            android.os.Environment.DIRECTORY_DOWNLOADS
        )

    suspend fun <T> read(filename: String, serializer: KSerializer<T>): T? {
        return withContext(Dispatchers.IO) {
            try {
                val file = File(context.filesDir, filename)
                if (!file.exists()) return@withContext null
                val text = file.readText()
                json.decodeFromString(serializer, text)
            } catch (e: Exception) {
                android.util.Log.e("JsonFileStorage", "Failed to read $filename: ${e.message}")
                null
            }
        }
    }

    suspend fun <T> write(filename: String, serializer: KSerializer<T>, data: T) {
        withContext(Dispatchers.IO) {
            try {
                val file = File(context.filesDir, filename)
                val tempFile = File(context.filesDir, "$filename.tmp")
                val text = json.encodeToString(serializer, data)
                tempFile.writeText(text)
                // Verify the temp file can be read back
                json.decodeFromString(serializer, tempFile.readText())
                tempFile.renameTo(file)
            } catch (e: Exception) {
                android.util.Log.e("JsonFileStorage", "Failed to write $filename: ${e.message}")
            }
        }
    }

    suspend fun readRawText(filename: String): String? {
        return withContext(Dispatchers.IO) {
            try {
                val file = File(context.filesDir, filename)
                if (!file.exists()) null else file.readText()
            } catch (e: Exception) {
                null
            }
        }
    }

    suspend fun writeRawText(filename: String, text: String) {
        withContext(Dispatchers.IO) {
            val file = File(context.filesDir, filename)
            val tempFile = File(context.filesDir, "$filename.tmp")
            tempFile.writeText(text)
            tempFile.renameTo(file)
        }
    }

    fun fileExists(filename: String): Boolean {
        return File(context.filesDir, filename).exists()
    }

    fun deleteFile(filename: String) {
        File(context.filesDir, filename).delete()
    }
}
