package com.okrn.rsagen

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.okrn.specs.NativeRsaGenSpec
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.RSAPrivateCrtKey
import java.security.spec.RSAKeyGenParameterSpec

/**
 * Android's RSA generator for Key Chain - see specs/NativeRsaGen.ts.
 *
 * The DEFAULT provider, deliberately not AndroidKeyStore: a Keystore key can
 * never leave the phone, and this key's whole purpose is to be loaded onto an
 * OnlyKey (and optionally exported, encrypted). So it is generated in memory,
 * its primes handed to JavaScript, and the references dropped.
 *
 * Off the JS thread: a 4096-bit key can take seconds.
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
        val gen = KeyPairGenerator.getInstance("RSA")
        gen.initialize(RSAKeyGenParameterSpec(size, BigInteger.valueOf(publicExponent.toLong())), SecureRandom())
        val key = gen.generateKeyPair().private as RSAPrivateCrtKey
        val half = size / 16
        promise.resolve("${fixedHex(key.primeP, half)}:${fixedHex(key.primeQ, half)}")
      } catch (e: Exception) {
        promise.reject("RSA_GEN", e.message ?: "RSA key generation failed", e)
      }
    }.start()
  }

  /** Big-endian, exactly `length` bytes: BigInteger adds a sign byte, or drops leading zeros. */
  private fun fixedHex(value: BigInteger, length: Int): String {
    val raw = value.toByteArray()
    val out = ByteArray(length)
    val from = maxOf(0, raw.size - length)
    System.arraycopy(raw, from, out, length - (raw.size - from), raw.size - from)
    val hex = StringBuilder(length * 2)
    for (b in out) hex.append(String.format("%02x", b.toInt() and 0xff))
    out.fill(0)
    raw.fill(0)
    return hex.toString()
  }

  companion object {
    const val NAME = NativeRsaGenSpec.NAME
  }
}
