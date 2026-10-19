package com.okrn.random

import com.facebook.react.bridge.ReactApplicationContext
import com.okrn.specs.NativeRandomSpec
import java.security.SecureRandom

/**
 * Random bytes for the JS side's crypto.getRandomValues (specs/NativeRandom.ts).
 *
 * One SecureRandom for the process: the platform's default provider, seeded by the system. Hex,
 * not base64, so the JS side decodes it with no library at all.
 */
class NativeRandomModule(reactContext: ReactApplicationContext) : NativeRandomSpec(reactContext) {

  override fun getName() = NAME

  override fun getRandomHex(byteLength: Double): String {
    val n = byteLength.toInt()
    require(n in 0..MAX) { "getRandomHex: 0 to $MAX bytes, not $n" }
    val bytes = ByteArray(n)
    random.nextBytes(bytes)
    val out = CharArray(n * 2)
    for (i in 0 until n) {
      val v = bytes[i].toInt() and 0xff
      out[i * 2] = HEX[v ushr 4]
      out[i * 2 + 1] = HEX[v and 0x0f]
    }
    bytes.fill(0)
    return String(out)
  }

  companion object {
    const val NAME = NativeRandomSpec.NAME
    private const val MAX = 65536
    private val HEX = "0123456789abcdef".toCharArray()
    private val random = SecureRandom()
  }
}
