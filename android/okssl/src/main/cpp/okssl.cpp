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
#include <openssl/ecdsa.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/param_build.h>
#include <openssl/rand.h>
#include <openssl/rsa.h>
#include <cstdlib>
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

/*
 * EDGE'S CHECKS IN OPENSSL (A13, 2026-10-07: ~1 s a sync of SHA-256 and P-256 in JS
 * under Hermes; Brad: "try not to use JS crypto if okssl can provide it as a faster
 * version"). The library's crypto provider (node-onlykey-lib src/crypto/provider.js)
 * calls these SYNCHRONOUSLY, as its checks are synchronous - so they take and give
 * hex strings straight across JNI (no Kotlin loops) and do one small job each. The
 * verdict rules (P-256 lowS, input lengths) stay in the provider, so OpenSSL and the
 * JS answer the same; here a bad input is an exception or false, never a guess.
 */
namespace {

int nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* hex -> bytes; false on an odd length or a non-hex character */
bool unhex(JNIEnv *env, jstring hex, std::vector<unsigned char> &out) {
  if (!hex) return false;
  const char *s = env->GetStringUTFChars(hex, nullptr);
  if (!s) return false;
  const size_t n = static_cast<size_t>(env->GetStringUTFLength(hex));
  bool ok = n % 2 == 0;
  out.assign(n / 2, 0);
  for (size_t i = 0; ok && i < n / 2; i++) {
    const int hi = nibble(s[2 * i]), lo = nibble(s[2 * i + 1]);
    if (hi < 0 || lo < 0) ok = false;
    else out[i] = static_cast<unsigned char>(hi << 4 | lo);
  }
  env->ReleaseStringUTFChars(hex, s);
  return ok;
}

const char HEX_DIGITS[] = "0123456789abcdef";

void appendHex(std::string &s, const unsigned char *data, size_t n) {
  for (size_t i = 0; i < n; i++) {
    s += HEX_DIGITS[data[i] >> 4];
    s += HEX_DIGITS[data[i] & 15];
  }
}

jstring hexOf(JNIEnv *env, const unsigned char *data, size_t n) {
  std::string s;
  s.reserve(n * 2);
  appendHex(s, data, n);
  return env->NewStringUTF(s.c_str());
}

bool needHex(JNIEnv *env, jstring hex, std::vector<unsigned char> &out, const char *what) {
  if (unhex(env, hex, out)) return true;
  throwError(env, std::string(what) + ": not hex");
  return false;
}

const EVP_MD *sha256Md() {
  static EVP_MD *md = EVP_MD_fetch(nullptr, "SHA256", nullptr);
  return md;
}

}  // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_com_okrn_okssl_OkSsl_sha256Hex(JNIEnv *env, jclass, jstring hex) {
  std::vector<unsigned char> in;
  if (!needHex(env, hex, in, "sha256")) return nullptr;
  unsigned char out[32];
  unsigned int n = 0;
  if (!EVP_Digest(in.data(), in.size(), out, &n, sha256Md(), nullptr)) { throwError(env, "sha256"); return nullptr; }
  return hexOf(env, out, n);
}

/* SHA-256 applied `times` times (a budget's hash chain: up to 1,024 a reveal) */
extern "C" JNIEXPORT jstring JNICALL
Java_com_okrn_okssl_OkSsl_sha256RepeatHex(JNIEnv *env, jclass, jstring hex, jint times) {
  std::vector<unsigned char> x;
  if (!needHex(env, hex, x, "sha256Repeat")) return nullptr;
  if (times < 0) { throwError(env, "sha256Repeat: negative count"); return nullptr; }
  unsigned char out[32];
  unsigned int n = 0;
  for (jint k = 0; k < times; k++) {
    if (!EVP_Digest(x.data(), x.size(), out, &n, sha256Md(), nullptr)) { throwError(env, "sha256Repeat"); return nullptr; }
    x.assign(out, out + n);
  }
  return hexOf(env, x.data(), x.size());
}

/*
 * One pass over a byte string, the digest of each prefix asked for: cuts are byte
 * offsets, comma-separated, ascending. -> the digests, comma-separated, same order.
 * (ok-rn's copy hash: the whole stored copy and the part this session verified.)
 */
extern "C" JNIEXPORT jstring JNICALL
Java_com_okrn_okssl_OkSsl_sha256CutsHex(JNIEnv *env, jclass, jstring hex, jstring cutsCsv) {
  std::vector<unsigned char> in;
  if (!needHex(env, hex, in, "sha256Cuts")) return nullptr;
  const char *c = cutsCsv ? env->GetStringUTFChars(cutsCsv, nullptr) : nullptr;
  const std::string cuts = c ? c : "";
  if (c) env->ReleaseStringUTFChars(cutsCsv, c);
  EVP_MD_CTX *ctx = EVP_MD_CTX_new();
  EVP_MD_CTX *fork = EVP_MD_CTX_new();
  std::string result;
  size_t at = 0, pos = 0;
  bool ok = ctx && fork && EVP_DigestInit_ex(ctx, sha256Md(), nullptr);
  while (ok && pos < cuts.size()) {
    size_t comma = cuts.find(',', pos);
    if (comma == std::string::npos) comma = cuts.size();
    const std::string one = cuts.substr(pos, comma - pos);
    pos = comma + 1;
    char *end = nullptr;
    const unsigned long cut = std::strtoul(one.c_str(), &end, 10);
    if (one.empty() || *end || cut < at || cut > in.size()) { ok = false; break; }
    if (cut > at && !EVP_DigestUpdate(ctx, in.data() + at, cut - at)) { ok = false; break; }
    at = cut;
    unsigned char out[32];
    unsigned int n = 0;
    if (!EVP_MD_CTX_copy_ex(fork, ctx) || !EVP_DigestFinal_ex(fork, out, &n)) { ok = false; break; }
    if (!result.empty()) result += ',';
    appendHex(result, out, n);
  }
  EVP_MD_CTX_free(fork);
  EVP_MD_CTX_free(ctx);
  if (!ok) { throwError(env, "sha256Cuts: bad cut list"); return nullptr; }
  return env->NewStringUTF(result.c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_okrn_okssl_OkSsl_hmacSha256Hex(JNIEnv *env, jclass, jstring keyHex, jstring msgHex) {
  std::vector<unsigned char> key, msg;
  if (!needHex(env, keyHex, key, "hmac key") || !needHex(env, msgHex, msg, "hmac msg")) return nullptr;
  unsigned char out[32];
  unsigned int n = 0;
  if (!HMAC(sha256Md(), key.data(), static_cast<int>(key.size()), msg.data(), msg.size(), out, &n)) {
    throwError(env, "hmacSha256");
    return nullptr;
  }
  return hexOf(env, out, n);
}

/* P-256 over a 32-byte digest: sig r||s (64), pub SEC1 0x04||x||y (65). Anything malformed: false. */
extern "C" JNIEXPORT jboolean JNICALL
Java_com_okrn_okssl_OkSsl_p256VerifyDigestHex(JNIEnv *env, jclass, jstring sigHex, jstring digestHex, jstring pubHex) {
  std::vector<unsigned char> sig, digest, pub;
  if (!unhex(env, sigHex, sig) || !unhex(env, digestHex, digest) || !unhex(env, pubHex, pub)) return JNI_FALSE;
  if (sig.size() != 64 || digest.size() != 32 || pub.size() != 65 || pub[0] != 0x04) return JNI_FALSE;
  bool good = false;
  EVP_PKEY *key = nullptr;
  OSSL_PARAM_BLD *bld = OSSL_PARAM_BLD_new();
  OSSL_PARAM *params = nullptr;
  EVP_PKEY_CTX *mk = EVP_PKEY_CTX_new_from_name(nullptr, "EC", nullptr);
  ECDSA_SIG *es = ECDSA_SIG_new();
  BIGNUM *r = BN_bin2bn(sig.data(), 32, nullptr);
  BIGNUM *s = BN_bin2bn(sig.data() + 32, 32, nullptr);
  unsigned char *der = nullptr;
  EVP_PKEY_CTX *vctx = nullptr;
  if (bld && mk && es && r && s &&
      OSSL_PARAM_BLD_push_utf8_string(bld, OSSL_PKEY_PARAM_GROUP_NAME, "prime256v1", 0) &&
      OSSL_PARAM_BLD_push_octet_string(bld, OSSL_PKEY_PARAM_PUB_KEY, pub.data(), pub.size()) &&
      (params = OSSL_PARAM_BLD_to_param(bld)) != nullptr &&
      EVP_PKEY_fromdata_init(mk) > 0 && EVP_PKEY_fromdata(mk, &key, EVP_PKEY_PUBLIC_KEY, params) > 0 &&
      ECDSA_SIG_set0(es, r, s)) {
    r = s = nullptr; /* owned by es now */
    const int derLen = i2d_ECDSA_SIG(es, &der);
    vctx = EVP_PKEY_CTX_new_from_pkey(nullptr, key, nullptr);
    good = derLen > 0 && vctx && EVP_PKEY_verify_init(vctx) > 0 &&
           EVP_PKEY_verify(vctx, der, static_cast<size_t>(derLen), digest.data(), digest.size()) == 1;
  }
  OPENSSL_free(der);
  EVP_PKEY_CTX_free(vctx);
  BN_free(r);
  BN_free(s);
  ECDSA_SIG_free(es);
  EVP_PKEY_CTX_free(mk);
  OSSL_PARAM_free(params);
  OSSL_PARAM_BLD_free(bld);
  EVP_PKEY_free(key);
  ERR_clear_error();
  return good ? JNI_TRUE : JNI_FALSE;
}

/* Ed25519, RFC 8032 strict (OpenSSL's own rule). Anything malformed: false. */
extern "C" JNIEXPORT jboolean JNICALL
Java_com_okrn_okssl_OkSsl_ed25519VerifyHex(JNIEnv *env, jclass, jstring sigHex, jstring msgHex, jstring pubHex) {
  std::vector<unsigned char> sig, msg, pub;
  if (!unhex(env, sigHex, sig) || !unhex(env, msgHex, msg) || !unhex(env, pubHex, pub)) return JNI_FALSE;
  if (sig.size() != 64 || pub.size() != 32) return JNI_FALSE;
  EVP_PKEY *key = EVP_PKEY_new_raw_public_key(EVP_PKEY_ED25519, nullptr, pub.data(), pub.size());
  EVP_MD_CTX *ctx = EVP_MD_CTX_new();
  const bool good = key && ctx && EVP_DigestVerifyInit(ctx, nullptr, nullptr, nullptr, key) > 0 &&
                    EVP_DigestVerify(ctx, sig.data(), sig.size(), msg.data(), msg.size()) == 1;
  EVP_MD_CTX_free(ctx);
  EVP_PKEY_free(key);
  ERR_clear_error();
  return good ? JNI_TRUE : JNI_FALSE;
}
