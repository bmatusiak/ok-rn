package com.okrn.emu

import android.content.Intent
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
   *
   * A SLOT picks which device. A pinned firmware build (OKEMU_VERSION) gets its
   * own subdirectory, because a v2.1 firmware reading a v3.0 flash is not a
   * measurement of either one; an ordinary build passes "" and keeps the
   * directory it has always used, so nothing already on a phone moves.
   *
   * Debug and production builds of the SAME firmware share a slot deliberately.
   * The DEBUG gate changes what the firmware prints, not what it stores, and a
   * production build cannot be given a PIN at all
   * (FINDING-provisioning-needs-a-debug-build.md) - so provisioning on debug
   * and then running production against that state is the only way to exercise
   * one.
   */
  private fun storageDirFor(slot: String): File {
    val base = File(reactContext.filesDir, "okemu")
    val dir = if (slot.isEmpty()) base else File(base, slot)
    dir.mkdirs()
    return dir
  }

  /**
   * A slot is a plain name, and anything else is REFUSED rather than cleaned up.
   *
   * It arrives from JS and becomes a path under the app's private files. A
   * sanitiser that silently drops a `..` writes a device's state somewhere its
   * owner did not ask for, and the firmware would then boot happily against the
   * wrong flash - which is the exact failure this whole mechanism exists to
   * prevent.
   */
  private fun slotIsPlain(slot: String): Boolean =
    slot.isEmpty() || slot.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"))

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

  override fun start(storageSlot: String, promise: Promise) {
    executor.execute {
      try {
        promise.resolve(startLocked(storageSlot))
      } catch (e: Exception) {
        promise.reject(ERR_START, e.message ?: "start failed", e)
      }
    }
  }

  /** Runs on [executor]. Never throws for the ordinary "cannot start" cases. */
  private fun startLocked(storageSlot: String): WritableMap {
    if (!slotIsPlain(storageSlot)) {
      return result(
        false,
        "storage slot \"$storageSlot\" is not a plain name - it becomes a " +
          "directory under the app's private files, and a slot that is not " +
          "what it looks like would boot the firmware against the wrong flash",
        storageDirFor(""),
      )
    }
    val dir = storageDirFor(storageSlot)
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

  /**
   * Hold or release a touch button.
   *
   * A press is a hold then a release, and the DURATION between them is what the
   * firmware bands on: a tap, a hold past 72 ticks, a long hold past 180. The
   * caller owns that timing, because the bands are what distinguish confirming
   * from cancelling from entering config mode.
   *
   * Serialised onto the same executor as every other call into the firmware, so
   * a press cannot interleave with a HID write.
   */
  override fun setButton(button: Double, down: Boolean, promise: Promise) {
    executor.execute {
      try {
        if (!isRunning()) {
          promise.reject(ERR_NOT_RUNNING, "firmware is not running")
          return@execute
        }
        val n = button.toInt()
        if (n < 1 || n > 6) {
          promise.reject(ERR_WRITE, "button must be 1-6, got $n")
          return@execute
        }
        OkEmuNative.nativeSetButton(n, down)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject(ERR_WRITE, e.message ?: "setButton failed", e)
      }
    }
  }

  /**
   * A hold measured in firmware main-loop iterations, released by the HAL.
   *
   * The bands are counted in iterations and never in time, so this is the only
   * way to land in one on purpose. Above 72 iterations the firmware stops
   * treating the press as a slot read and starts running gestures - backup,
   * lock-and-restart, config mode - which is why the JS layer refuses that
   * range unless a caller says it means it.
   */
  override fun setButtonTicks(button: Double, ticks: Double, promise: Promise) {
    executor.execute {
      try {
        if (!isRunning()) {
          promise.reject(ERR_NOT_RUNNING, "firmware is not running")
          return@execute
        }
        val n = button.toInt()
        if (n < 1 || n > 6) {
          promise.reject(ERR_WRITE, "button must be 1-6, got $n")
          return@execute
        }
        OkEmuNative.nativeSetButtonTicks(n, ticks.toInt())
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject(ERR_WRITE, e.message ?: "setButtonTicks failed", e)
      }
    }
  }

  /**
   * Queue presses to be handed to the loop rather than sensed.
   *
   * On the executor like every other mutating call. The whole run crosses in
   * one call on purpose - a seven-digit PIN was seven presses, each with its
   * own polled settle, and that is what made entering one take five seconds.
   */
  override fun pressQueue(buttons: String, ticks: Double, promise: Promise) {
    executor.execute {
      try {
        if (!isRunning()) {
          promise.reject(ERR_NOT_RUNNING, "firmware is not running")
          return@execute
        }
        val n = ticks.toInt()
        if (n <= 0) {
          promise.reject(ERR_WRITE, "ticks must be positive, got $n")
          return@execute
        }
        promise.resolve(OkEmuNative.nativePressQueue(buttons, n).toDouble())
      } catch (e: Exception) {
        promise.reject(ERR_WRITE, e.message ?: "pressQueue failed", e)
      }
    }
  }

  /**
   * How many presses are still waiting to be taken.
   *
   * NOT on the executor, deliberately - the same reason buttonTicksLeft is
   * not. A caller asks this WHILE the firmware thread is busy consuming the
   * queue, and queueing it behind the work it is asking about would answer
   * only once that work had finished.
   */
  override fun pressPending(promise: Promise) {
    try {
      promise.resolve(if (isRunning()) OkEmuNative.nativePressPending().toDouble() else 0.0)
    } catch (e: Exception) {
      promise.reject(ERR_WRITE, e.message ?: "pressPending failed", e)
    }
  }

  /**
   * Iterations still owed on a counted hold - the press timer, and the only
   * honest way to know a hold has finished.
   *
   * NOT serialised onto the executor. A poll must be answerable while the
   * firmware thread is mid-press; queueing it behind the work it is asking
   * about would report 0 only once everything else had drained. The HAL reads
   * one int under its own mutex, so this is safe from any thread.
   */
  override fun buttonTicksLeft(button: Double, promise: Promise) {
    try {
      if (!isRunning()) {
        promise.resolve(0.0)
        return
      }
      val n = button.toInt()
      if (n < 1 || n > 6) {
        promise.reject(ERR_WRITE, "button must be 1-6, got $n")
        return
      }
      promise.resolve(OkEmuNative.nativeButtonTicksLeft(n).toDouble())
    } catch (e: Exception) {
      promise.reject(ERR_WRITE, e.message ?: "buttonTicksLeft failed", e)
    }
  }

  override fun rounds(promise: Promise) {
    try {
      promise.resolve(OkEmuNative.nativeRounds())
    } catch (e: Exception) {
      promise.reject(ERR_WRITE, e.message ?: "rounds failed", e)
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

  /**
   * Relaunch the app, which is the only way back from a dead firmware.
   *
   * makeRestartActivityTask is Android's own idiom for this: it builds the
   * same task the launcher would, so the new process starts clean rather than
   * resuming whatever the old one had on screen. The kill has to follow the
   * start, or the system simply resumes the existing task.
   *
   * exitProcess rather than finishing the activity, because the point is a NEW
   * PROCESS: the firmware's globals live in this one and nothing short of
   * replacing it resets them.
   */
  override fun restartApp(promise: Promise) {
    try {
      /*
       * Hand the relaunch to a process that will still be alive to do it.
       *
       * Two simpler routes were tried and measured: startActivity() then
       * exit(), and an AlarmManager PendingIntent then exit(). Both die the
       * same way - the process goes and nothing comes back - because Android
       * refuses activity starts from a background process, and once we have
       * exited that is what we are. RestartActivity runs in :restart, stays
       * visible while this process is killed, and starts the app from there.
       */
      val restart = Intent(reactContext, com.okrn.RestartActivity::class.java)
      restart.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      reactContext.startActivity(restart)

      Thread {
        // Long enough for :restart to be up, short enough to feel immediate.
        Thread.sleep(RESTART_DELAY_MS)
        Runtime.getRuntime().exit(0)
      }.start()

      // Not resolved: the process is about to go, and a resolution racing that
      // would only ever be seen if the restart had failed.
    } catch (e: Exception) {
      promise.reject("E_RESTART", e.message ?: "restartApp failed", e)
    }
  }

  companion object {
    private const val ERR_START = "ERR_EMU_START"
    private const val ERR_STOP = "ERR_EMU_STOP"
    private const val ERR_RESET = "ERR_EMU_RESET"
    private const val ERR_WRITE = "ERR_EMU_WRITE"
    private const val ERR_NOT_RUNNING = "ERR_EMU_NOT_RUNNING"
    private const val ERR_RESTART_UNSUPPORTED = "ERR_EMU_RESTART_UNSUPPORTED"
    private const val RESTART_DELAY_MS = 250L
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
