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

/*
 * Whether a firmware thread has EVER been created in this process.
 *
 * Distinct from g_running, which only says whether stop() has been called. The
 * thread cannot be stopped: okemu_firmware_run() is the Arduino loop and never
 * returns, so nativeStop() shuts the HAL down and leaves it running. Starting
 * again would pthread_create a SECOND one, and both would then race the same
 * global input queues - the same reason restart() is unsupported.
 */
bool g_fw_thread_created = false;
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

  /*
   * Refused rather than quietly spawning a second firmware.
   *
   * This used to succeed, and the consequence was invisible: two firmware
   * threads draining one hid_in queue, so PIN digits and HID reports went to
   * whichever woke first. It presented as an unlock that failed twice and then
   * worked, which reads like a flaky device rather than a leak.
   */
  if (g_fw_thread_created) {
    return env->NewStringUTF(
        "the firmware thread cannot be restarted in this process - it only exits "
        "through the AIRCR trap, so starting again would run a second one "
        "alongside it. Restart the app; flash.bin and eeprom.bin persist.");
  }

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
  g_fw_thread_created = true;
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

/*
 * A button, as the firmware understands one.
 *
 * okemu_touch_for_pin() reports a high capacitance while a button is held and a
 * low one otherwise, and the firmware baselines each pad at rest and treats the
 * excursion as a touch - so holding and releasing is a real press, timed by the
 * caller, and reaches every path a physical button does.
 *
 * This existed in the HAL from the beginning and was never wired up: nothing
 * called okemu_set_button(). Without it the only way to press anything on a
 * phone was the DEBUG serial console, which is #ifdef DEBUG and would vanish in
 * a release build - and user presence is not optional, since every FIDO2
 * signing operation waits on one.
 */
JNIEXPORT void JNICALL
Java_com_okrn_okemu_OkEmuNative_nativeSetButton(JNIEnv *, jclass,
                                                jint button, jboolean down) {
  if (!g_running) return;
  okemu_set_button((int)button, down ? 1 : 0);
}

/*
 * A press measured in the firmware's own units.
 *
 * The band a press lands in - type slot N, type slot N+6, or run backup() -
 * is decided by a COUNT OF MAIN-LOOP ITERATIONS, never by a clock. Holding
 * for a wall time and hoping is a race against the handset's loop speed, and
 * losing it means taking a backup or restarting the key rather than reading a
 * slot. The HAL counts the samples instead and releases at exactly N.
 */
JNIEXPORT void JNICALL
Java_com_okrn_okemu_OkEmuNative_nativeSetButtonTicks(JNIEnv *, jclass,
                                                     jint button, jint ticks) {
  if (!g_running) return;
  okemu_set_button_ticks((int)button, (int)ticks);
}

/* Samples still owed on a counted hold - the press timer the UI shows. */
JNIEXPORT jint JNICALL
Java_com_okrn_okemu_OkEmuNative_nativeButtonTicksLeft(JNIEnv *, jclass,
                                                      jint button) {
  if (!g_running) return 0;
  return (jint)okemu_button_ticks_left((int)button);
}

/*
 * Sense rounds since boot, so a caller can wait for a release to be SEEN.
 *
 * jdouble rather than jlong because it crosses to JS, where every number is
 * one anyway; a round is tens of milliseconds, so 2^53 of them is longer than
 * the phone will exist.
 */
JNIEXPORT jdouble JNICALL
Java_com_okrn_okemu_OkEmuNative_nativeRounds(JNIEnv *, jclass) {
  if (!g_running) return 0;
  return (jdouble)okemu_rounds();
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
