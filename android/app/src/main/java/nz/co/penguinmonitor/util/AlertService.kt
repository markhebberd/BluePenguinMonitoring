package nz.co.penguinmonitor.util

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class AlertService @Inject constructor(
    @ApplicationContext private val context: Context
) {
    private val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
    } else {
        @Suppress("DEPRECATION")
        context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }

    private val alertMediaPlayer: MediaPlayer? = try {
        val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        MediaPlayer.create(context, uri)?.apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
        }
    } catch (_: Exception) {
        null
    }

    suspend fun triggerAlert() = withContext(Dispatchers.IO) {
        try {
            // Vibrate for 500ms
            vibrator?.let {
                val effect = VibrationEffect.createOneShot(500, VibrationEffect.DEFAULT_AMPLITUDE)
                it.vibrate(effect)
            }

            // Play alert sound 3 times
            alertMediaPlayer?.let { player ->
                repeat(3) {
                    try {
                        if (player.isPlaying) {
                            player.stop()
                            player.prepare()
                        }
                        player.start()
                        delay(1000)
                    } catch (_: Exception) { }
                }
            }
        } catch (_: Exception) { }
    }
}
