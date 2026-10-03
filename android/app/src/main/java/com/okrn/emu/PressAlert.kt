package com.okrn.emu

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.media.AudioAttributes
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.okrn.R
import com.okrn.okemu.OkEmuNative

/**
 * A SOUND WHEN THE SOFT KEY WANTS A PRESS (Brad, 2026-10-03: "i think i need a
 * sound or something so i know" - a timeout test ran its whole course with the
 * phone face down, nobody knowing it asked).
 *
 * A press request arrives over Bluetooth while the phone may be in a pocket, so
 * this lives in NATIVE code, not in the app's JS: it reads the firmware's own
 * confirm state (OkEmuNative.nativeConfirmState - the same value the in-app
 * banner decodes, src/transport/OkEmu.ts decodeConfirmState) every 400 ms while
 * the soft key runs, whatever the screen is doing.
 *
 *   waiting starts             -> a "Press needed" notification (silent), and
 *                                 soft.mp3 at once and every 2 s
 *   the SAME wait past 10 s    -> loud.mp3 every 3 s instead (the first 2 s after the last soft) (the key gives up at 20 s)
 *   the wait ends              -> sounds stop, the notification goes away
 * (Brad, 2026-10-03: "repeat soft every 2 seconds, and loud every 3 (first one 2 seconds)".)
 *
 * The notification is the visible prompt - it shows with the screen off and
 * opens ok-rn at its Confirm button. The SOUNDS play here (SoundPool, on the
 * notification audio stream, so the phone's notification volume and silent
 * mode still decide): Android throttles repeated alerts from one notification,
 * so a channel sound cannot repeat every 2 s.
 */
object PressAlert {
  private const val POLL_MS = 400L
  private const val LOUD_AFTER_MS = 10_000L
  private const val SOFT_EVERY_MS = 2_000L
  private const val LOUD_EVERY_MS = 3_000L
  /* one silent channel for the prompt; the first try (okrn.press.soft/loud) carried sounds and is removed */
  private const val CHANNEL = "okrn.press.prompt"
  private val OLD_CHANNELS = listOf("okrn.press.soft", "okrn.press.loud")
  private const val NOTIFICATION_ID = 0x0C0F

  /* firmware opcodes (okcore.h), as decodeConfirmState knows them */
  private const val OP_SIGN = 0xed
  private const val OP_DECRYPT = 0xf0
  private const val OP_HMAC = 0xf5
  private const val OP_WEBAUTHN = 0xf6
  private const val OP_EDGE = 0xf8

  private val handler = Handler(Looper.getMainLooper())
  private var started = false
  /* the wait being alerted, by its opcode/slot, and when it began */
  private var current: Int? = null
  private var since = 0L
  private var nextSound = 0L
  private lateinit var app: Context
  private var pool: android.media.SoundPool? = null
  private var softId = 0
  private var loudId = 0

  fun start(context: Context) {
    if (started) return
    started = true
    app = context.applicationContext
    channels()
    val attrs = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()
    pool = android.media.SoundPool.Builder().setMaxStreams(2).setAudioAttributes(attrs).build().also {
      softId = it.load(app, R.raw.press_soft, 1)
      loudId = it.load(app, R.raw.press_loud, 1)
    }
    handler.post(tick)
  }

  private val tick = object : Runnable {
    override fun run() {
      try {
        check()
      } catch (_: Throwable) {
        /* the native library not loaded yet, or the firmware stopping: try again next tick */
      }
      handler.postDelayed(this, POLL_MS)
    }
  }

  /** The same rule as decodeConfirmState: CRYPTO_AUTH 1..3 with the window open = waiting. -> opcode<<8|slot, or null */
  private fun waitingFor(): Int? {
    if (!OkEmuNative.isLoaded() || !OkEmuNative.nativeIsRunning()) return null
    val packed = OkEmuNative.nativeConfirmState()
    if (packed < 0) return null
    val auth = packed and 0xff
    val opcode = (packed ushr 8) and 0xff
    val slot = (packed ushr 16) and 0xff
    val open = ((packed ushr 27) and 1) == 1
    if (auth < 1 || auth > 3 || !open || opcode == 0) return null
    return (opcode shl 8) or slot
  }

  private fun check() {
    val w = waitingFor()
    val now = System.currentTimeMillis()
    if (w == null) {
      if (current != null) {
        current = null
        manager().cancel(NOTIFICATION_ID)
      }
      return
    }
    if (w != current) {
      current = w
      since = now
      nextSound = now
      post(w)
    }
    if (now >= nextSound) {
      val loud = now - since >= LOUD_AFTER_MS
      pool?.play(if (loud) loudId else softId, 1f, 1f, 1, 0, 1f)
      nextSound = now + if (loud) LOUD_EVERY_MS else SOFT_EVERY_MS
    }
  }

  private fun what(w: Int): String = when (w ushr 8) {
    OP_SIGN -> "a sign"
    OP_DECRYPT -> "a decrypt"
    OP_HMAC -> "an HMAC"
    OP_EDGE -> "an Edge approval"
    OP_WEBAUTHN -> "a security-key request"
    else -> "a request"
  }

  private fun post(w: Int) {
    val open = PendingIntent.getActivity(
      app, 0, app.packageManager.getLaunchIntentForPackage(app.packageName),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    @Suppress("DEPRECATION")
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(app, CHANNEL) else Notification.Builder(app)
    val n = builder
      .setSmallIcon(R.drawable.ic_stat_o)
      .setContentTitle("Press needed")
      .setContentText("Confirm on your key: ${what(w)}. It stops waiting after 20 s.")
      .setContentIntent(open)
      .setAutoCancel(true)
      .setCategory(Notification.CATEGORY_ALARM)
      .build()
    manager().notify(NOTIFICATION_ID, n)
  }

  private fun manager() = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  private fun channels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    for (old in OLD_CHANNELS) manager().deleteNotificationChannel(old)
    if (manager().getNotificationChannel(CHANNEL) != null) return
    val c = NotificationChannel(CHANNEL, "Press needed", NotificationManager.IMPORTANCE_HIGH)
    c.description = "The soft key is waiting for your press. The sound plays from ok-rn itself (soft every 2 s, loud every 3 s past 10 s)."
    c.setSound(null, null)
    c.enableVibration(true)
    manager().createNotificationChannel(c)
  }
}
