package com.okrn.emu

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.okrn.okemu.OkEmuNative
import com.okrn.specs.NativeOkEmuSpec
import java.io.File
import java.util.concurrent.Executors

/**
 * The soft key: the OnlyKey firmware running in-process.
 *
 * This module deliberately knows nothing about the OnlyKey protocol. It starts
 * and stops the firmware, moves bytes to and from its four USB interfaces, and
 * forwards its LED and restart signals. Interpreting any of that is JS's job -
 * the same JS that drives a physical key over USB, so both look identical from
 * above.
 */
@ReactModule(name = NativeOkEmuSpec.NAME)
class NativeOkEmuModule(
  private val reactContext: ReactApplicationContext,
) : NativeOkEmuSpec(reactContext), OkEmuNative.Listener {

  /**
   * start/stop and every write are serialised here. nativeStart() spawns the
   * firmware thread and nativeStop() tears down its HAL; interleaving those
   * from two JS calls would be a use-after-free rather than a race on a flag.
   */
  private val executor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "ok-emu").apply { isDaemon = true }
  }

  /**
   * flash.bin (256 KB) and eeprom.bin (2 KB) live here - the device's entire
   * persistent state. getFilesDir() is app-private and survives updates, which
   * is what makes a restored backup outlive a reinstall of nothing else.
   */
  private val storageDir: File
    get() = File(reactContext.filesDir, "okemu").apply { mkdirs() }

  override fun invalidate() {
    executor.execute { if (OkEmuNative.isLoaded()) OkEmuNative.nativeStop() }
    executor.shutdown()
    super.invalidate()
  }

  // ------------------------------------------------------------- availability

  override fun isAvailable(): Boolean = OkEmuNative.load()

  override fun isRunning(): Boolean =
    OkEmuNative.isLoaded() && OkEmuNative.nativeIsRunning()

  // ---------------------------------------------------------------- lifecycle

  override fun start(promise: Promise) {
    executor.execute {
      try {
        promise.resolve(startLocked())
      } catch (e: Exception) {
        promise.reject(ERR_START, e.message ?: "start failed", e)
      }
    }
  }

  /** Runs on [executor]. Never throws for the ordinary "cannot start" cases. */
  private fun startLocked(): WritableMap {
    val dir = storageDir
    if (!OkEmuNative.load()) {
      return result(false, "libokemu.so is not available for this ABI", dir)
    }
    if (OkEmuNative.nativeIsRunning()) {
      return result(false, "already running", dir)
    }
    val error = OkEmuNative.nativeStart(dir.absolutePath, this)
    return if (error.isEmpty()) {
      result(true, "", dir)
    } else {
      result(false, error, dir)
    }
  }

  override fun stop(promise: Promise) {
    executor.execute {
      try {
        if (OkEmuNative.isLoaded()) OkEmuNative.nativeStop()
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject(ERR_STOP, e.message ?: "stop failed", e)
      }
    }
  }

  /**
   * The firmware's own CPU_RESTART(): tear down and boot again against the same
   * storage. Deliberately not a process restart - flash and EEPROM are
   * file-backed, so device state survives exactly as it does across a real
   * power cycle.
   */
  override fun restart(promise: Promise) {
    /*
     * Not supported in-process, and failing loudly is the honest answer.
     *
     * okemu_firmware_run() never returns: SoftTimerClass::run() is an infinite
     * scheduler loop, exactly as it is on the device. The only exit is the
     * AIRCR trap in okemu_restart.cpp, which parks the thread via siglongjmp
     * when the firmware itself calls CPU_RESTART().
     *
     * So stop-then-start does not restart the firmware, it starts a SECOND
     * one while the first is still looping - and since okemu_hal_shutdown()
     * now unmaps the flash, that first thread would fault on its next access.
     * Upstream never meets this because a restart there is a process restart:
     * pm2 respawns the daemon and the address space goes with it.
     *
     * Restarting the app process has the same semantics and is safe today,
     * because flash.bin and eeprom.bin are file-backed - device state survives
     * exactly as it does across a power cycle on real hardware.
     */
    promise.reject(
      ERR_RESTART_UNSUPPORTED,
      "in-process firmware restart is not implemented: the firmware thread " +
        "only exits through the AIRCR trap. Restart the app process instead - " +
        "flash.bin and eeprom.bin persist, so device state is preserved.",
    )
  }

  override fun factoryReset(promise: Promise) {
    executor.execute {
      try {
        if (!OkEmuNative.isLoaded()) {
          promise.reject(ERR_NOT_RUNNING, "firmware is not loaded")
          return@execute
        }
        OkEmuNative.nativeFactoryReset()
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject(ERR_RESET, e.message ?: "factoryReset failed", e)
      }
    }
  }

  // -------------------------------------------------------------------- io

  override fun writeHid(iface: Double, hex: String, promise: Promise) {
    executor.execute {
      try {
        if (!isRunning()) {
          promise.reject(ERR_NOT_RUNNING, "firmware is not running")
          return@execute
        }
        val rc = OkEmuNative.nativeWriteHid(iface.toInt(), hex.hexToBytes())
        if (rc < 0) {
          promise.reject(ERR_WRITE, "interface ${iface.toInt()} rejected the report")
        } else {
          promise.resolve(rc.toDouble())
        }
      } catch (e: Exception) {
        promise.reject(ERR_WRITE, e.message ?: "writeHid failed", e)
      }
    }
  }

  override fun kbdSetReport(hex: String, promise: Promise) {
    executor.execute {
      try {
        if (!isRunning()) {
          promise.reject(ERR_NOT_RUNNING, "firmware is not running")
          return@execute
        }
        OkEmuNative.nativeKbdSetReport(hex.hexToBytes())
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject(ERR_WRITE, e.message ?: "kbdSetReport failed", e)
      }
    }
  }

  override fun kbdGetReport(promise: Promise) {
    executor.execute {
      try {
        if (!isRunning()) {
          promise.reject(ERR_NOT_RUNNING, "firmware is not running")
          return@execute
        }
        promise.resolve(OkEmuNative.nativeKbdGetReport().toHex())
      } catch (e: Exception) {
        promise.reject(ERR_WRITE, e.message ?: "kbdGetReport failed", e)
      }
    }
  }

  // ------------------------------------------------- OkEmuNative.Listener
  // All three arrive on the firmware thread, not the JS thread.

  override fun onStream(data: ByteArray, iface: Int, dir: Int) {
    val map = Arguments.createMap()
    map.putInt("iface", iface)
    map.putInt("dir", dir)
    map.putString("hex", data.toHex())
    map.putInt("length", data.size)
    emit { emitOnStream(map) }
  }

  override fun onLed(packedRgb: IntArray) {
    val pixels = Arguments.createArray()
    for (p in packedRgb) pixels.pushInt(p)
    val map = Arguments.createMap()
    map.putArray("pixels", pixels)
    emit { emitOnLed(map) }
  }

  override fun onRestart() {
    emit { emitOnRestartRequested() }
  }

  /**
   * Events raised before JS subscribes, or after teardown, have no listener.
   * Dropping them is correct - there is nothing to deliver to.
   */
  private inline fun emit(block: () -> Unit) {
    try {
      block()
    } catch (_: Exception) {
      // No JS listener attached.
    }
  }

  // ------------------------------------------------------------------ helpers

  private fun result(started: Boolean, message: String, dir: File): WritableMap =
    Arguments.createMap().apply {
      putBoolean("started", started)
      putString("message", message)
      putString("storageDir", dir.absolutePath)
    }

  companion object {
    private const val ERR_START = "ERR_EMU_START"
    private const val ERR_STOP = "ERR_EMU_STOP"
    private const val ERR_RESET = "ERR_EMU_RESET"
    private const val ERR_WRITE = "ERR_EMU_WRITE"
    private const val ERR_NOT_RUNNING = "ERR_EMU_NOT_RUNNING"
    private const val ERR_RESTART_UNSUPPORTED = "ERR_EMU_RESTART_UNSUPPORTED"
  }
}

private val HEX_CHARS = "0123456789abcdef".toCharArray()

internal fun ByteArray.toHex(): String {
  val out = CharArray(size * 2)
  for (i in indices) {
    val v = this[i].toInt() and 0xff
    out[i * 2] = HEX_CHARS[v ushr 4]
    out[i * 2 + 1] = HEX_CHARS[v and 0x0f]
  }
  return String(out)
}

internal fun String.hexToBytes(): ByteArray {
  require(length % 2 == 0) { "hex string must have an even length, got $length" }
  val out = ByteArray(length / 2)
  for (i in out.indices) {
    val hi = Character.digit(this[i * 2], 16)
    val lo = Character.digit(this[i * 2 + 1], 16)
    require(hi >= 0 && lo >= 0) { "invalid hex at offset ${i * 2}" }
    out[i] = ((hi shl 4) or lo).toByte()
  }
  return out
}
