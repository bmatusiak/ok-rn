package com.okrn.okssl

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.okrn.specs.NativeOkSslSpec

/**
 * The linked OpenSSL's self-checks - see specs/NativeOkSsl.ts. Only the e2e
 * suite calls these; off the JS thread like the other OpenSSL calls.
 */
class NativeOkSslModule(reactContext: ReactApplicationContext) :
  NativeOkSslSpec(reactContext) {

  override fun version(promise: Promise) {
    try {
      promise.resolve(OkSsl.version())
    } catch (e: Exception) {
      promise.reject("OKSSL", e.message ?: "version failed", e)
    }
  }

  override fun randStatus(promise: Promise) {
    try {
      promise.resolve(OkSsl.randStatus())
    } catch (e: Exception) {
      promise.reject("OKSSL", e.message ?: "RAND_status failed", e)
    }
  }

  override fun randomBytes(n: Double, promise: Promise) {
    Thread {
      try {
        val bytes = OkSsl.randomBytes(n.toInt())
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) sb.append(String.format("%02x", b.toInt() and 0xff))
        bytes.fill(0)
        promise.resolve(sb.toString())
      } catch (e: Exception) {
        promise.reject("OKSSL", e.message ?: "RAND_bytes failed", e)
      }
    }.start()
  }

  /*
   * Edge's checks, SYNCHRONOUS on the JS thread (the library's checks are): each is
   * one small native call, far quicker than the JS it replaces (A13, 2026-10-07).
   */
  override fun sha256Hex(hex: String): String = OkSsl.sha256Hex(hex)
  override fun sha256RepeatHex(hex: String, times: Double): String = OkSsl.sha256RepeatHex(hex, times.toInt())
  override fun sha256CutsHex(hex: String, cutsCsv: String): String = OkSsl.sha256CutsHex(hex, cutsCsv)
  override fun hmacSha256Hex(keyHex: String, msgHex: String): String = OkSsl.hmacSha256Hex(keyHex, msgHex)
  override fun p256VerifyDigestHex(sigHex: String, digestHex: String, pubHex: String): Boolean =
    OkSsl.p256VerifyDigestHex(sigHex, digestHex, pubHex)
  override fun ed25519VerifyHex(sigHex: String, msgHex: String, pubHex: String): Boolean =
    OkSsl.ed25519VerifyHex(sigHex, msgHex, pubHex)

  companion object {
    const val NAME = NativeOkSslSpec.NAME
  }
}
