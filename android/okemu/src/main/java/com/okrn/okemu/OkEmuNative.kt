package com.okrn.okemu

/**
 * Thin Kotlin face on libokemu.so.
 *
 * The package and class name are load-bearing: JNI symbol names encode them,
 * so jni/okemu_jni.cpp exports Java_com_okrn_okemu_OkEmuNative_*. Moving or
 * renaming this class silently breaks the binding at runtime, not at compile
 * time.
 *
 * Deliberately dumb - no threading, no state beyond `loaded`, no policy. The
 * firmware runs on its own native thread and calls back on it; anything that
 * needs to reach the JS thread is the TurboModule's job.
 */
object OkEmuNative {

    /**
     * Callbacks from the firmware thread. Every one of these arrives on a
     * native thread that JNI attached, NOT on the main looper - implementations
     * must not touch UI state directly.
     */
    interface Listener {
        /**
         * One packet on one interface, in one direction.
         *
         * @param data  the raw report
         * @param iface [IFACE_KEYBOARD], [IFACE_FIDO], [IFACE_VENDOR] or [IFACE_SEREMU]
         * @param dir   [DIR_OUT] (device to host) or [DIR_IN] (host to device)
         */
        fun onStream(data: ByteArray, iface: Int, dir: Int)

        /** NeoPixel state, one packed 0x00RRGGBB entry per pixel. */
        fun onLed(packedRgb: IntArray)

        /** The firmware executed CPU_RESTART(). */
        fun onRestart()
    }

    @Volatile
    private var loaded = false

    /**
     * Loads the native library. Separate from [start] so a device that cannot
     * load it at all - a missing ABI, most likely - reports that distinctly
     * from the firmware failing to boot.
     */
    @Synchronized
    fun load(): Boolean {
        if (loaded) return true
        return try {
            System.loadLibrary("okemu")
            loaded = true
            true
        } catch (e: UnsatisfiedLinkError) {
            false
        }
    }

    fun isLoaded(): Boolean = loaded

    /**
     * Boots the firmware against a storage directory, which must be writable
     * and private to the app - it holds flash.bin (256 KB) and eeprom.bin
     * (2 KB), the device's entire persistent state.
     *
     * @return an empty string on success, or a human-readable reason. A string
     *   rather than a boolean because every failure is a distinct environment
     *   problem and the difference is exactly what a bug report needs.
     */
    external fun nativeStart(storageDir: String, listener: Listener): String

    external fun nativeStop()

    external fun nativeIsRunning(): Boolean

    /** host to device. `iface` must be FIDO, VENDOR or SEREMU. */
    external fun nativeWriteHid(iface: Int, data: ByteArray): Int

    /** The Yubikey OTP / HMAC-SHA1 channel rides keyboard control transfers. */
    external fun nativeKbdSetReport(data: ByteArray)

    external fun nativeKbdGetReport(): ByteArray

    /** Erases flash and EEPROM. Irreversible. */
    external fun nativeFactoryReset()

    external fun nativeRestartRequested(): Boolean

    external fun nativeClearRestart()

    /* usb_desc.h's interface numbers, which the firmware and descriptors use. */
    const val IFACE_KEYBOARD = 0
    const val IFACE_FIDO = 1
    const val IFACE_VENDOR = 2

    /** Debug serial. Present only in DEBUG firmware builds - 4 interfaces, not 3. */
    const val IFACE_SEREMU = 3

    const val DIR_OUT = 0
    const val DIR_IN = 1
}
