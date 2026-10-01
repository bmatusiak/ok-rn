package com.okrn.kdf

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.okrn.specs.NativeKdfSpec
import com.okrn.okssl.OkSsl

/**
 * PBKDF2-HMAC-SHA256 natively - see specs/NativeKdf.ts.
 *
 * OpenSSL's PKCS5_PBKDF2_HMAC (native-sea-openssl, via android/okssl): all
 * the rounds in one native call, over the exact bytes the lib hashed (UTF-8)
 * - no character-set step in between. Off the JS thread.
 */
class NativeKdfModule(reactContext: ReactApplicationContext) :
  NativeKdfSpec(reactContext) {

  override fun pbkdf2Sha256(passwordHex: String, saltHex: String, iterations: Double, dkLen: Double, promise: Promise) {
    val rounds = iterations.toInt()
    val length = dkLen.toInt()
    if (rounds < 1 || length < 1 || length > 1024) {
      promise.reject("KDF", "PBKDF2 needs at least one round and 1..1024 bytes")
      return
    }
    Thread {
      val password = fromHex(passwordHex)
      val salt = fromHex(saltHex)
      try {
        val out = OkSsl.pbkdf2Sha256(password, salt, rounds, length)
        val result = toHex(out, length)
        out.fill(0)
        promise.resolve(result)
      } catch (e: Exception) {
        promise.reject("KDF", e.message ?: "PBKDF2 failed", e)
      } finally {
        password.fill(0)
        salt.fill(0)
      }
    }.start()
  }

  private fun fromHex(hex: String): ByteArray {
    val out = ByteArray(hex.length / 2)
    for (i in out.indices) out[i] = hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
    return out
  }

  private fun toHex(bytes: ByteArray, length: Int): String {
    val sb = StringBuilder(length * 2)
    for (i in 0 until length) sb.append(String.format("%02x", bytes[i].toInt() and 0xff))
    return sb.toString()
  }

  companion object {
    const val NAME = NativeKdfSpec.NAME
  }
}
