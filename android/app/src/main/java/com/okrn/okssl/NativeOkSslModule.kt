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

  companion object {
    const val NAME = NativeOkSslSpec.NAME
  }
}
