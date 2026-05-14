package nz.co.penguinmonitor.data.remote

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import nz.co.penguinmonitor.model.BoxTag
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class BoxTagApiService(
    private val apiUrl: String,
    private val apiKey: String
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    @Serializable
    private data class ApiResponse<T>(
        @SerialName("success") val success: Boolean = false,
        @SerialName("data") val data: T? = null,
        @SerialName("error") val error: String? = null,
        @SerialName("message") val message: String? = null
    )

    suspend fun getAllBoxTags(): Map<String, BoxTag> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(apiUrl)
            .addHeader("X-API-Key", apiKey)
            .get()
            .build()

        val response = client.newCall(request).execute()
        response.use {
            if (!it.isSuccessful) throw Exception("HTTP ${it.code}")
            val body = it.body?.string() ?: throw Exception("Empty response")
            val dataSerializer = MapSerializer(String.serializer(), BoxTag.serializer())
            val result = json.decodeFromString(ApiResponse.serializer(dataSerializer), body)
            if (result.success && result.data != null) result.data else emptyMap()
        }
    }

    suspend fun saveBoxTag(boxTag: BoxTag): Boolean = withContext(Dispatchers.IO) {
        val bodyJson = json.encodeToString(BoxTag.serializer(), boxTag)
        val request = Request.Builder()
            .url(apiUrl)
            .addHeader("X-API-Key", apiKey)
            .post(bodyJson.toRequestBody("application/json".toMediaType()))
            .build()

        val response = client.newCall(request).execute()
        response.use { it.isSuccessful }
    }

    suspend fun deleteBoxTag(boxId: String): Boolean = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("$apiUrl?box_id=${java.net.URLEncoder.encode(boxId, "UTF-8")}")
            .addHeader("X-API-Key", apiKey)
            .delete()
            .build()

        val response = client.newCall(request).execute()
        response.use { it.isSuccessful || it.code == 404 }
    }
}
