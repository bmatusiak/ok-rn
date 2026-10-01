package com.okrn.rsagen

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.okrn.specs.NativeRsaGenSpec
import com.okrn.okssl.OkSsl

/**
 * RSA key generation for Key Chain - see specs/NativeRsaGen.ts.
 *
 * OpenSSL's generator (native-sea-openssl, via android/okssl), in memory:
 * the key's whole purpose is to be loaded onto an OnlyKey (and maybe
 * exported, encrypted), so it is never a Keystore key. Only p and q cross to
 * JavaScript. Off the JS thread: 4096 bits can take a few seconds.
 */
class NativeRsaGenModule(reactContext: ReactApplicationContext) :
  NativeRsaGenSpec(reactContext) {

  override fun generatePrimes(bits: Double, publicExponent: Double, promise: Promise) {
    val size = bits.toInt()
    if (size !in setOf(2048, 3072, 4096)) {
      promise.reject("RSA_GEN", "RSA keys are 2048, 3072 or 4096 bits; got $size")
      return
    }
    Thread {
      try {
        val primes = OkSsl.rsaPrimes(size, publicExponent.toInt())
        val half = size / 16
        val result = "${toHex(primes[0], half)}:${toHex(primes[1], half)}"
        primes.forEach { it.fill(0) }
        promise.resolve(result)
      } catch (e: Exception) {
        promise.reject("RSA_GEN", e.message ?: "RSA key generation failed", e)
      }
    }.start()
  }

  private fun toHex(bytes: ByteArray, length: Int): String {
    val sb = StringBuilder(length * 2)
    for (i in 0 until length) sb.append(String.format("%02x", bytes[i].toInt() and 0xff))
    return sb.toString()
  }

  companion object {
    const val NAME = NativeRsaGenSpec.NAME
  }
}
