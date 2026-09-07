/*
 * okemu_jni.cpp - JNI bridge to the firmware.
 *
 * Replaces node-onlykey-emulator/emulator/src/addon.cpp, which is the only
 * N-API-aware file in that project. Everything below this line is the same
 * portable C ABI declared in src/ok_hal.h; nothing in the firmware, the HAL or
 * the core overrides knows which runtime it is hosted by.
 *
 * THREADING
 *
 * The firmware runs on its own thread and never returns from
 * okemu_firmware_run() - SoftTimerClass::run() is an infinite loop, exactly as
 * it is on the device. Every sink below is therefore invoked on that thread,
 * not on a JVM thread, so each one has to attach before it can touch JNI. We
 * attach once per callback thread and detach via pthread_key destructor rather
 * than per call, because AttachCurrentThread on every HID report would dominate
 * the cost of the report itself.
 *
 * Stack size is set explicitly: bionic's default thread stack is 1 MB where
 * glibc gives 8 MB, and the firmware puts uint8_t large_temp[18000] and several
 * 2 KB buffers on the stack, with ML-DSA adding more. The default would fault
 * in code that is correct on the device and correct under the Node emulator.
 */
#include <jni.h>
#include <pthread.h>
#include <android/log.h>

#include <cstring>
#include <cstdlib>
#include <string>

extern "C" {
#include "ok_hal.h"
}

#define LOG_TAG "okemu"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

JavaVM *g_vm = nullptr;
jobject g_listener = nullptr;      /* global ref to the Kotlin callback object */
jmethodID g_onStream = nullptr;    /* (byte[] data, int iface, int dir) -> void */
jmethodID g_onLed = nullptr;       /* (int[] packedRgb) -> void */
jmethodID g_onRestart = nullptr;   /* () -> void */

pthread_t g_fw_thread = 0;
bool g_running = false;

/* ------------------------------------------------------- thread attachment */

pthread_key_t g_env_key;
pthread_once_t g_env_once = PTHREAD_ONCE_INIT;

void detach_current_thread(void *value) {
  if (value && g_vm) {
    g_vm->DetachCurrentThread();
  }
}

void make_env_key() { pthread_key_create(&g_env_key, detach_current_thread); }

/*
 * The JNIEnv for whichever thread is calling. Attaches on first use and leaves
 * the thread attached; the pthread key detaches it when the thread exits.
 */
JNIEnv *env_for_current_thread() {
  if (!g_vm) return nullptr;
  pthread_once(&g_env_once, make_env_key);

  JNIEnv *env = nullptr;
  jint rc = g_vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6);
  if (rc == JNI_OK) return env;

  if (rc == JNI_EDETACHED) {
    JavaVMAttachArgs args = {JNI_VERSION_1_6, "okemu-firmware", nullptr};
    if (g_vm->AttachCurrentThread(&env, &args) != JNI_OK) return nullptr;
    /* Non-null marker; the value itself is unused. */
    pthread_setspecific(g_env_key, env);
    return env;
  }
  return nullptr;
}

/* --------------------------------------------------------------- the sinks */

void stream_sink(const uint8_t *data, size_t len, int iface, int dir, void *) {
  JNIEnv *env = env_for_current_thread();
  if (!env || !g_listener || !g_onStream) return;

  jbyteArray arr = env->NewByteArray(static_cast<jsize>(len));
  if (!arr) return;
  env->SetByteArrayRegion(arr, 0, static_cast<jsize>(len),
                          reinterpret_cast<const jbyte *>(data));
  env->CallVoidMethod(g_listener, g_onStream, arr, iface, dir);
  env->DeleteLocalRef(arr);
  if (env->ExceptionCheck()) env->ExceptionClear();
}

void led_sink(const okemu_rgb *px, int count, void *) {
  JNIEnv *env = env_for_current_thread();
  if (!env || !g_listener || !g_onLed) return;

  jintArray arr = env->NewIntArray(count);
  if (!arr) return;
  /* Packed 0x00RRGGBB so one primitive array carries the whole strip. */
  jint *packed = static_cast<jint *>(malloc(sizeof(jint) * (count > 0 ? count : 1)));
  if (!packed) { env->DeleteLocalRef(arr); return; }
  for (int i = 0; i < count; i++) {
    packed[i] = (px[i].r << 16) | (px[i].g << 8) | px[i].b;
  }
  env->SetIntArrayRegion(arr, 0, count, packed);
  free(packed);

  env->CallVoidMethod(g_listener, g_onLed, arr);
  env->DeleteLocalRef(arr);
  if (env->ExceptionCheck()) env->ExceptionClear();
}

void restart_sink(void *) {
  JNIEnv *env = env_for_current_thread();
  if (!env || !g_listener || !g_onRestart) return;
  env->CallVoidMethod(g_listener, g_onRestart);
  if (env->ExceptionCheck()) env->ExceptionClear();
}

/* ----------------------------------------------------------- firmware body */

void *firmware_main(void *) {
  okemu_firmware_run();   /* never returns */
  return nullptr;
}

std::string jstr(JNIEnv *env, jstring s) {
  if (!s) return {};
  const char *c = env->GetStringUTFChars(s, nullptr);
  std::string out(c ? c : "");
  if (c) env->ReleaseStringUTFChars(s, c);
  return out;
}

}  // namespace

extern "C" {

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *) {
  g_vm = vm;
  return JNI_VERSION_1_6;
}

/*
 * Returns "" on success, or a human-readable reason. A string rather than a
 * boolean because every failure here is a distinct environment problem - the
 * peripheral window being taken, the storage directory being unwritable - and
 * the difference is exactly what a bug report needs.
 */
JNIEXPORT jstring JNICALL
Java_com_okrn_okemu_OkEmuNative_nativeStart(JNIEnv *env, jclass,
                                            jstring storageDir,
                                            jobject listener) {
  if (g_running) return env->NewStringUTF("already running");

  const std::string dir = jstr(env, storageDir);
  if (dir.empty()) return env->NewStringUTF("storage directory is empty");

  /* Resolve the callback methods once, up front: a wrong signature should
   * fail at start() rather than silently drop every packet later. */
  if (g_listener) env->DeleteGlobalRef(g_listener);
  g_listener = env->NewGlobalRef(listener);
  jclass cls = env->GetObjectClass(listener);
  g_onStream = env->GetMethodID(cls, "onStream", "([BII)V");
  g_onLed = env->GetMethodID(cls, "onLed", "([I)V");
  g_onRestart = env->GetMethodID(cls, "onRestart", "()V");
  if (!g_onStream || !g_onLed || !g_onRestart) {
    env->ExceptionClear();
    return env->NewStringUTF("listener is missing onStream/onLed/onRestart");
  }

  char err[256] = {0};
  if (okemu_hal_init(dir.c_str(), err, sizeof err) != 0) {
    return env->NewStringUTF(err[0] ? err : "okemu_hal_init failed");
  }

  okemu_set_stream_sink(stream_sink, nullptr);
  okemu_set_led_sink(led_sink, nullptr);
  okemu_set_restart_sink(restart_sink, nullptr);

  okemu_time_start();
  okemu_systick_start();

  pthread_attr_t attr;
  pthread_attr_init(&attr);
  /* See the threading note at the top: bionic's 1 MB default is not enough. */
  pthread_attr_setstacksize(&attr, 8 * 1024 * 1024);
  int rc = pthread_create(&g_fw_thread, &attr, firmware_main, nullptr);
  pthread_attr_destroy(&attr);

  if (rc != 0) {
    okemu_systick_stop();
    okemu_hal_shutdown();
    return env->NewStringUTF("could not start the firmware thread");
  }

  g_running = true;
  LOGI("firmware started, storage=%s", dir.c_str());
  return env->NewStringUTF("");
}

JNIEXPORT void JNICALL
Java_com_okrn_okemu_OkEmuNative_nativeStop(JNIEnv *env, jclass) {
  if (!g_running) return;
  g_running = false;

  okemu_systick_stop();
  okemu_hal_shutdown();

  /*
   * The firmware thread is not joined. okemu_firmware_run() never returns, so
   * there is nothing to join on - the same reason the Node addon detaches it.
   * Shutting the HAL down first unblocks any wait it is parked in.
   */
  okemu_set_stream_sink(nullptr, nullptr);
  okemu_set_led_sink(nullptr, nullptr);
  okemu_set_restart_sink(nullptr, nullptr);

  if (g_listener) {
    env->DeleteGlobalRef(g_listener);
    g_listener = nullptr;
  }
  LOGI("firmware stopped");
}

JNIEXPORT jboolean JNICALL
Java_com_okrn_okemu_OkEmuNative_nativeIsRunning(JNIEnv *, jclass) {
  return g_running ? JNI_TRUE : JNI_FALSE;
}

/* host -> device. iface must be FIDO, VENDOR or SEREMU. */
JNIEXPORT jint JNICALL
Java_com_okrn_okemu_OkEmuNative_nativeWriteHid(JNIEnv *env, jclass,
                                               jint iface, jbyteArray data) {
  if (!g_running) return -1;
  const jsize len = env->GetArrayLength(data);
  jbyte *bytes = env->GetByteArrayElements(data, nullptr);
  if (!bytes) return -1;
  int rc = okemu_hid_deliver(reinterpret_cast<const uint8_t *>(bytes),
                             static_cast<size_t>(len), iface);
  env->ReleaseByteArrayElements(data, bytes, JNI_ABORT);
  return rc;
}

/* The Yubikey OTP / HMAC-SHA1 channel rides keyboard control transfers. */
JNIEXPORT void JNICALL
Java_com_okrn_okemu_OkEmuNative_nativeKbdSetReport(JNIEnv *env, jclass,
                                                   jbyteArray data) {
  if (!g_running) return;
  const jsize len = env->GetArrayLength(data);
  jbyte *bytes = env->GetByteArrayElements(data, nullptr);
  if (!bytes) return;
  okemu_kbd_set_report(reinterpret_cast<const uint8_t *>(bytes),
                       static_cast<uint32_t>(len));
  env->ReleaseByteArrayElements(data, bytes, JNI_ABORT);
}

JNIEXPORT jbyteArray JNICALL
Java_com_okrn_okemu_OkEmuNative_nativeKbdGetReport(JNIEnv *env, jclass) {
  uint8_t out[8] = {0};
  if (!g_running || okemu_kbd_get_report(out) <= 0) {
    return env->NewByteArray(0);
  }
  jbyteArray arr = env->NewByteArray(8);
  if (arr) {
    env->SetByteArrayRegion(arr, 0, 8, reinterpret_cast<const jbyte *>(out));
  }
  return arr;
}

JNIEXPORT void JNICALL
Java_com_okrn_okemu_OkEmuNative_nativeFactoryReset(JNIEnv *, jclass) {
  okemu_factory_reset();
}

JNIEXPORT jboolean JNICALL
Java_com_okrn_okemu_OkEmuNative_nativeRestartRequested(JNIEnv *, jclass) {
  return okemu_restart_requested() ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_okrn_okemu_OkEmuNative_nativeClearRestart(JNIEnv *, jclass) {
  okemu_clear_restart();
}

}  // extern "C"
