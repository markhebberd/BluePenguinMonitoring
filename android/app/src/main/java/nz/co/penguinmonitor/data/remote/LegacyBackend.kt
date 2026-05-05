package nz.co.penguinmonitor.data.remote

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import nz.co.penguinmonitor.util.Constants
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.io.PrintWriter
import java.net.Socket
import java.security.KeyPairGenerator
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Legacy encrypted TCP communication with the PenguinMonitor server.
 * Ported from Backend.cs - uses RSA key exchange + AES encryption.
 * @deprecated Will be replaced by PHP REST API.
 */
@Deprecated("Will be replaced by PHP REST API")
@Singleton
class LegacyBackend @Inject constructor() {

    suspend fun requestServerResponse(question: String): String = withContext(Dispatchers.IO) {
        try {
            Socket(Constants.LEGACY_SERVER_IP, Constants.LEGACY_SERVER_PORT).use { socket ->
                socket.soTimeout = 5000
                val reader = BufferedReader(InputStreamReader(socket.getInputStream()))
                val writer = PrintWriter(OutputStreamWriter(socket.getOutputStream()), true)

                // Generate RSA key pair
                val keyPairGen = KeyPairGenerator.getInstance("RSA")
                keyPairGen.initialize(1024)
                val keyPair = keyPairGen.generateKeyPair()

                val rsaPublicKey = keyPair.public as java.security.interfaces.RSAPublicKey
                // Send modulus and exponent
                writer.println(Base64.getEncoder().encodeToString(rsaPublicKey.modulus.toByteArray()))
                writer.println(Base64.getEncoder().encodeToString(rsaPublicKey.publicExponent.toByteArray()))

                // Receive AES key and IV (RSA encrypted)
                val rsaCipher = Cipher.getInstance("RSA/ECB/PKCS1Padding")
                rsaCipher.init(Cipher.DECRYPT_MODE, keyPair.private)

                val encryptedKey = Base64.getDecoder().decode(reader.readLine())
                val encryptedIv = Base64.getDecoder().decode(reader.readLine())
                val aesKey = rsaCipher.doFinal(encryptedKey)
                val aesIv = rsaCipher.doFinal(encryptedIv)

                val secretKey = SecretKeySpec(aesKey, "AES")
                val ivSpec = IvParameterSpec(aesIv)

                // Send encrypted passphrase
                val encryptCipher = Cipher.getInstance("AES/CBC/ISO10126Padding")
                encryptCipher.init(Cipher.ENCRYPT_MODE, secretKey, ivSpec)
                val passphraseBytes = Constants.LEGACY_PASSPHRASE.toByteArray(Charsets.UTF_16LE)
                val encryptedPassphrase = encryptCipher.doFinal(passphraseBytes)
                writer.println(Base64.getEncoder().encodeToString(encryptedPassphrase))

                // Send encrypted question
                val encryptCipher2 = Cipher.getInstance("AES/CBC/ISO10126Padding")
                encryptCipher2.init(Cipher.ENCRYPT_MODE, secretKey, ivSpec)
                val questionBytes = question.toByteArray(Charsets.UTF_16LE)
                val encryptedQuestion = encryptCipher2.doFinal(questionBytes)
                writer.println(Base64.getEncoder().encodeToString(encryptedQuestion))

                // Receive encrypted response
                val encryptedResponse = Base64.getDecoder().decode(reader.readLine())
                val decryptCipher = Cipher.getInstance("AES/CBC/NoPadding")
                decryptCipher.init(Cipher.DECRYPT_MODE, secretKey, ivSpec)
                val plainBytes = decryptCipher.doFinal(encryptedResponse)

                // Remove padding (last byte indicates padding length)
                val paddingLength = plainBytes.last().toInt() and 0xFF
                val responseBytes = plainBytes.copyOfRange(0, plainBytes.size - paddingLength)
                String(responseBytes, Charsets.UTF_16LE)
            }
        } catch (_: Exception) {
            "fail"
        }
    }
}
