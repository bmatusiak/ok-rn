package com.okrn.okssl

/**
 * OpenSSL (native-sea-openssl, linked into libokssl.so) for Key Chain - see
 * okssl/build.gradle for where it comes from and okssl.cpp for the calls.
 * Both block for as long as the work takes; callers run them off the JS
 * thread.
 */
object OkSsl {
  init {
    System.loadLibrary("okssl")
  }

  /** PBKDF2-HMAC-SHA256 over raw bytes. */
  @JvmStatic external fun pbkdf2Sha256(password: ByteArray, salt: ByteArray, iterations: Int, dkLen: Int): ByteArray

  /** A fresh RSA key's primes [p, q], each bits/16 bytes, big-endian. */
  @JvmStatic external fun rsaPrimes(bits: Int, publicExponent: Int): Array<ByteArray>

  /** Self-checks for the e2e suite: the linked OpenSSL's version line, RAND_status(), raw RAND_bytes. */
  @JvmStatic external fun version(): String
  @JvmStatic external fun randStatus(): Boolean
  @JvmStatic external fun randomBytes(n: Int): ByteArray
}
