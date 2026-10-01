/*
 * okssl - the two OpenSSL calls Key Chain needs, for Kotlin (com.okrn.okssl.OkSsl).
 *
 *   pbkdf2Sha256  PKCS5_PBKDF2_HMAC with SHA-256: all the rounds in one native
 *                 call (600000 for an encrypted copy's passphrase).
 *   rsaPrimes     a fresh RSA key from OpenSSL's generator; only p and q are
 *                 handed back (node-onlykey-lib completes the key), each
 *                 exactly bits/16 bytes, big-endian.
 *
 * Bytes in, bytes out; every buffer that held a secret is cleansed before it
 * is freed. Errors come back as a Java exception naming the step.
 */
#include <jni.h>
#include <openssl/bn.h>
#include <openssl/core_names.h>
#include <openssl/crypto.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/rsa.h>
#include <string>
#include <vector>

namespace {

void throwError(JNIEnv *env, const std::string &what) {
  char detail[256] = {0};
  unsigned long code = ERR_get_error();
  if (code) ERR_error_string_n(code, detail, sizeof detail);
  ERR_clear_error();
  jclass cls = env->FindClass("java/lang/IllegalStateException");
  env->ThrowNew(cls, (what + (code ? std::string(": ") + detail : std::string())).c_str());
}

std::vector<unsigned char> bytesOf(JNIEnv *env, jbyteArray array) {
  jsize n = env->GetArrayLength(array);
  std::vector<unsigned char> out(static_cast<size_t>(n));
  if (n) env->GetByteArrayRegion(array, 0, n, reinterpret_cast<jbyte *>(out.data()));
  return out;
}

jbyteArray arrayOf(JNIEnv *env, const unsigned char *data, size_t n) {
  jbyteArray out = env->NewByteArray(static_cast<jsize>(n));
  if (out) env->SetByteArrayRegion(out, 0, static_cast<jsize>(n), reinterpret_cast<const jbyte *>(data));
  return out;
}

}  // namespace

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_okrn_okssl_OkSsl_pbkdf2Sha256(JNIEnv *env, jclass, jbyteArray password, jbyteArray salt, jint iterations, jint dkLen) {
  if (iterations < 1 || dkLen < 1 || dkLen > 1024) {
    throwError(env, "PBKDF2 needs at least one round and 1..1024 bytes");
    return nullptr;
  }
  std::vector<unsigned char> pw = bytesOf(env, password);
  std::vector<unsigned char> s = bytesOf(env, salt);
  std::vector<unsigned char> out(static_cast<size_t>(dkLen));
  int ok = PKCS5_PBKDF2_HMAC(reinterpret_cast<const char *>(pw.data()), static_cast<int>(pw.size()),
                             s.data(), static_cast<int>(s.size()), iterations, EVP_sha256(), dkLen, out.data());
  OPENSSL_cleanse(pw.data(), pw.size());
  if (ok != 1) {
    OPENSSL_cleanse(out.data(), out.size());
    throwError(env, "PKCS5_PBKDF2_HMAC failed");
    return nullptr;
  }
  jbyteArray result = arrayOf(env, out.data(), out.size());
  OPENSSL_cleanse(out.data(), out.size());
  return result;
}

/*
 * SELF-CHECKS (owner, 2026-10-01: "OpenSSL is all about security - test its
 * core for sanity and randomness"). The e2e suite asks which OpenSSL is linked
 * (it must be the release build.gradle pins), whether its RNG says it is
 * seeded, and draws raw bytes from it to run the same statistics it runs on
 * the primes.
 */
extern "C" JNIEXPORT jstring JNICALL
Java_com_okrn_okssl_OkSsl_version(JNIEnv *env, jclass) {
  return env->NewStringUTF(OpenSSL_version(OPENSSL_VERSION));
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_okrn_okssl_OkSsl_randStatus(JNIEnv *, jclass) {
  return RAND_status() == 1 ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_okrn_okssl_OkSsl_randomBytes(JNIEnv *env, jclass, jint n) {
  if (n < 1 || n > 65536) {
    throwError(env, "randomBytes takes 1..65536 bytes");
    return nullptr;
  }
  std::vector<unsigned char> out(static_cast<size_t>(n));
  if (RAND_bytes(out.data(), n) != 1) {
    throwError(env, "RAND_bytes failed");
    return nullptr;
  }
  jbyteArray result = arrayOf(env, out.data(), out.size());
  OPENSSL_cleanse(out.data(), out.size());
  return result;
}

extern "C" JNIEXPORT jobjectArray JNICALL
Java_com_okrn_okssl_OkSsl_rsaPrimes(JNIEnv *env, jclass, jint bits, jint publicExponent) {
  if (bits != 2048 && bits != 3072 && bits != 4096) {
    throwError(env, "RSA keys are 2048, 3072 or 4096 bits");
    return nullptr;
  }
  EVP_PKEY_CTX *ctx = EVP_PKEY_CTX_new_from_name(nullptr, "RSA", nullptr);
  EVP_PKEY *key = nullptr;
  BIGNUM *e = BN_new();
  BIGNUM *p = nullptr;
  BIGNUM *q = nullptr;
  jobjectArray result = nullptr;
  const size_t half = static_cast<size_t>(bits) / 16;
  std::vector<unsigned char> pb(half), qb(half);

  if (!ctx || !e || !BN_set_word(e, static_cast<BN_ULONG>(publicExponent)) || EVP_PKEY_keygen_init(ctx) != 1 ||
      EVP_PKEY_CTX_set_rsa_keygen_bits(ctx, bits) != 1 || EVP_PKEY_CTX_set1_rsa_keygen_pubexp(ctx, e) != 1 ||
      EVP_PKEY_generate(ctx, &key) != 1) {
    throwError(env, "RSA key generation failed");
  } else if (EVP_PKEY_get_bn_param(key, OSSL_PKEY_PARAM_RSA_FACTOR1, &p) != 1 ||
             EVP_PKEY_get_bn_param(key, OSSL_PKEY_PARAM_RSA_FACTOR2, &q) != 1 ||
             BN_bn2binpad(p, pb.data(), static_cast<int>(half)) < 0 || BN_bn2binpad(q, qb.data(), static_cast<int>(half)) < 0) {
    throwError(env, "reading the RSA primes failed");
  } else {
    jclass byteArray = env->FindClass("[B");
    result = env->NewObjectArray(2, byteArray, nullptr);
    if (result) {
      env->SetObjectArrayElement(result, 0, arrayOf(env, pb.data(), half));
      env->SetObjectArrayElement(result, 1, arrayOf(env, qb.data(), half));
    }
  }
  OPENSSL_cleanse(pb.data(), pb.size());
  OPENSSL_cleanse(qb.data(), qb.size());
  BN_clear_free(p);
  BN_clear_free(q);
  BN_free(e);
  EVP_PKEY_free(key);
  EVP_PKEY_CTX_free(ctx);
  return result;
}
