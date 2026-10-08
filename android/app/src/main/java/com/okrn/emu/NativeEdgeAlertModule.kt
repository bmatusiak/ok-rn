package com.okrn.emu

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.ReactApplicationContext
import com.okrn.R
import com.okrn.specs.NativeEdgeAlertSpec
import java.lang.ref.WeakReference

/**
 * B7: Edge alarms as phone notifications, one per event, so they stand out
 * without looking at the tab. Separate from PressAlert's single "press needed"
 * notification: that one is replaced while a press waits; these stay until read.
 *
 * Stage 2, option A (spec 2026-10-04): the JS side keeps watching with the app
 * in the background (one implementation of the rules, in the lib). This side owns
 * what must not depend on JS:
 *  - the lock screen: VISIBILITY_PRIVATE with a public version that says only
 *    "Edge alarm" and the budget - the reason, identities and messages show
 *    after unlock;
 *  - Hold, from the lock screen: a broadcast action (no unlock - Hold only makes
 *    the key stricter). JS running: handed to it (onHoldRequested), which holds
 *    every live budget the normal way. JS not running: kept, and a notice asks to
 *    open ok-rn; the app holds as soon as it is up (takeHoldRequest). Android
 *    forbids opening an activity from a notification's broadcast, so the notice
 *    is the way in;
 *  - a heartbeat watchdog: JS beats every 10 s while watching; 30 s without one
 *    posts "Edge watching stopped: open ok-rn", a beat clears it.
 *
 * Tapping an alarm opens MainActivity with EXTRA_SEQ; MainActivity hands it to
 * [fromIntent], and the app collects it with takeOpenedSeq().
 */
class NativeEdgeAlertModule(reactContext: ReactApplicationContext) : NativeEdgeAlertSpec(reactContext) {

  init {
    instance = WeakReference(this)
    appContext = reactContext.applicationContext
  }

  override fun getName() = NAME

  override fun post(seq: Double, title: String, text: String, lockText: String, quiet: Boolean) {
    val app = reactApplicationContext.applicationContext
    val manager = manager(app)
    channels(manager)
    val s = seq.toLong()
    val launch = (app.packageManager.getLaunchIntentForPackage(app.packageName) ?: Intent()).apply {
      putExtra(EXTRA_SEQ, s)
      addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    /* requestCode = the link, so each notification keeps its own extra */
    val open = PendingIntent.getActivity(
      app, (s and 0x7fffffff).toInt(), launch,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val channel = if (quiet) CHANNEL_NOTICE else CHANNEL
    /* what the lock screen shows: no reason, no identity, no message */
    val public = builder(app, channel)
      .setSmallIcon(R.drawable.ic_stat_o)
      .setContentTitle(if (quiet) "Edge notice" else "Edge alarm")
      .setContentText(lockText)
      .setContentIntent(open)
    if (!quiet) public.addAction(holdAction(app))
    /*
     * THE NOTIFICATION ITSELF SAYS ONLY "Edge alarm" AND THE BUDGET. On the Pixel
     * (2026-10-04) the lock screen showed the full private text: Android shows it
     * there whenever the phone's own setting is "show all notification content",
     * so a public version guarantees nothing. The details (title/text) are in the
     * app - a tap opens Presses on the link.
     */
    android.util.Log.i("okemu", "[edge-watch] alarm ${com.okrn.LogSafe.detail("#$s: $title", "posted")}")
    val full = builder(app, channel)
      .setSmallIcon(R.drawable.ic_stat_o)
      .setContentTitle(if (quiet) "Edge notice" else "Edge alarm")
      .setContentText(if (quiet) "$lockText · open ok-rn" else "$lockText · open ok-rn to see what happened")
      .setContentIntent(open)
      .setAutoCancel(true)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setPublicVersion(public.build())
      .setCategory(if (quiet) Notification.CATEGORY_STATUS else Notification.CATEGORY_ALARM)
    if (!quiet) full.addAction(holdAction(app))
    manager.notify(ID_BASE + (s and 0xffffff).toInt(), full.build())
  }

  /**
   * Part T: a Bluetooth pairing alarm (a copied pairing, a revoke, an expiry).
   * The same alarm channel and the same lock-screen rule as Edge's: the lock
   * screen says only "Bluetooth alarm"; the details are in the app. No Hold - it
   * is not about a budget. A tap opens the app with EXTRA_SEQ = BT_SEQ_BASE + id,
   * which App.tsx reads as "open the Bluetooth tab".
   */
  override fun postBluetooth(id: Double, text: String) {
    val app = reactApplicationContext.applicationContext
    val manager = manager(app)
    channels(manager)
    val s = BT_SEQ_BASE + (id.toLong() and 0xffff)
    val launch = (app.packageManager.getLaunchIntentForPackage(app.packageName) ?: Intent()).apply {
      putExtra(EXTRA_SEQ, s)
      addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    val open = PendingIntent.getActivity(
      app, (s and 0x7fffffff).toInt(), launch,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val public = builder(app, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_o)
      .setContentTitle("Bluetooth alarm")
      .setContentText("open ok-rn")
      .setContentIntent(open)
    val full = builder(app, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_o)
      .setContentTitle("Bluetooth alarm")
      .setContentText(text)
      .setStyle(Notification.BigTextStyle().bigText(text))
      .setContentIntent(open)
      .setAutoCancel(true)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setPublicVersion(public.build())
      .setCategory(Notification.CATEGORY_ALARM)
    manager.notify(ID_BT_BASE + (id.toLong() and 0xffff).toInt(), full.build())
  }

  override fun takeOpenedSeq(): Double {
    val s = opened
    opened = -1L
    return s.toDouble()
  }

  override fun beat() {
    lastBeat = System.currentTimeMillis()
    if (stoppedShown) {
      manager(reactApplicationContext.applicationContext).cancel(ID_STOPPED)
      stoppedShown = false
    }
  }

  override fun setWatching(on: Boolean) {
    watching = on
    keepJsTimers(on)
    if (on) {
      lastBeat = System.currentTimeMillis()
      startWatchdog()
    } else if (stoppedShown) {
      manager(reactApplicationContext.applicationContext).cancel(ID_STOPPED)
      stoppedShown = false
    }
  }

  /*
   * JS TIMERS IN THE BACKGROUND. React Native pauses them when the app leaves the
   * front; the lib's Edge calls wait on them (busQuiet, timeouts), so every sync
   * hung ("skip: busy" on the Pixel, 2026-10-04). While a headless JS task is
   * active, React Native keeps its timers running (JavaTimerManager
   * onHeadlessJsTaskStart). So while watching, one task that never ends
   * (index.js OkrnEdgeWatch); it finishes when watching stops.
   */
  private fun keepJsTimers(on: Boolean) {
    com.facebook.react.bridge.UiThreadUtil.runOnUiThread {
      try {
        val tasks = com.facebook.react.jstasks.HeadlessJsTaskContext.getInstance(reactApplicationContext)
        if (on && watchTask < 0) {
          watchTask = tasks.startTask(com.facebook.react.jstasks.HeadlessJsTaskConfig(
            "OkrnEdgeWatch", com.facebook.react.bridge.Arguments.createMap(), 0, true))
        } else if (!on && watchTask >= 0) {
          tasks.finishTask(watchTask)
          watchTask = -1
        }
      } catch (e: Throwable) {
        android.util.Log.w("okemu", "[edge-watch] headless task: ${com.okrn.LogSafe.error(e)}")
      }
    }
  }

  override fun takeHoldRequest(): Boolean {
    val app = reactApplicationContext.applicationContext
    val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val pending = prefs.getBoolean(KEY_HOLD, false)
    if (pending) {
      prefs.edit().putBoolean(KEY_HOLD, false).apply()
      manager(app).cancel(ID_HOLD_WAITING)
    }
    return pending
  }

  internal fun requestHold() = emitOnHoldRequested()

  /** A notification's Hold: to the running JS side, or kept until the app is up. */
  class HoldReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      val app = context.applicationContext
      val js = instance?.get()
      val sinceBeat = System.currentTimeMillis() - lastBeat
      android.util.Log.i("okemu", "[edge-watch] Hold tapped: js=${js != null} sinceBeat=${sinceBeat}ms")
      if (js != null && sinceBeat < JS_ALIVE_MS) {
        js.requestHold()
        return
      }
      app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_HOLD, true).apply()
      val manager = manager(app)
      channels(manager)
      val launch = app.packageManager.getLaunchIntentForPackage(app.packageName)
      val open = PendingIntent.getActivity(app, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      manager.notify(ID_HOLD_WAITING, builder(app, CHANNEL)
        .setSmallIcon(R.drawable.ic_stat_o)
        .setContentTitle("Hold waiting: open ok-rn")
        .setContentText("ok-rn is not running. Open it and every live budget is held as soon as it is up.")
        .setContentIntent(open)
        .setAutoCancel(true)
        .setVisibility(Notification.VISIBILITY_PUBLIC)
        .build())
    }
  }

  companion object {
    const val NAME = "NativeEdgeAlert"
    const val CHANNEL = "okrn.edge.alarm"
    const val CHANNEL_NOTICE = "okrn.edge.notice"
    const val EXTRA_SEQ = "okrn.edgeSeq"
    private const val ACTION_HOLD = "com.okrn.EDGE_HOLD"
    private const val PREFS = "okrn.edge.alert"
    private const val KEY_HOLD = "holdPending"
    private const val ID_BASE = 0x0E000000
    /* Part T alarms: their own id range, and a seq range App.tsx maps to the Bluetooth tab (edgeAlerts.ts BT_SEQ_BASE) */
    private const val ID_BT_BASE = 0x0E100000
    const val BT_SEQ_BASE = 1_000_000_000L
    private const val ID_STOPPED = 0x0E0F0001
    private const val ID_HOLD_WAITING = 0x0E0F0002
    private const val BEAT_TIMEOUT_MS = 30_000L
    private const val JS_ALIVE_MS = 20_000L
    private const val CHECK_MS = 10_000L

    @Volatile private var instance: WeakReference<NativeEdgeAlertModule>? = null
    @Volatile private var appContext: Context? = null
    @Volatile private var lastBeat = 0L
    @Volatile private var watching = false
    @Volatile private var stoppedShown = false
    @Volatile private var watchdogOn = false
    @Volatile private var watchTask = -1
    private val handler by lazy { Handler(Looper.getMainLooper()) }

    /** the link of the last tapped alarm, until the app takes it; -1 = none */
    @Volatile @JvmStatic var opened: Long = -1L

    /** MainActivity: a launch or new intent from one of these notifications */
    @JvmStatic fun fromIntent(intent: Intent?) {
      if (intent != null && intent.hasExtra(EXTRA_SEQ)) {
        opened = intent.getLongExtra(EXTRA_SEQ, -1L)
        intent.removeExtra(EXTRA_SEQ)
      }
    }

    private fun manager(c: Context) = c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    @Suppress("DEPRECATION")
    private fun builder(c: Context, channel: String) =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(c, channel) else Notification.Builder(c)

    private fun holdAction(c: Context): Notification.Action {
      val i = Intent(c, HoldReceiver::class.java).setAction(ACTION_HOLD)
      val p = PendingIntent.getBroadcast(c, 0, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      @Suppress("DEPRECATION")
      val b = Notification.Action.Builder(null, "Hold", p)
      /* from the lock screen without unlocking: Hold only makes the key stricter (spec 2026-10-04) */
      if (Build.VERSION.SDK_INT >= 31) b.setAuthenticationRequired(false)
      return b.build()
    }

    private fun channels(manager: NotificationManager) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      if (manager.getNotificationChannel(CHANNEL) == null) {
        val c = NotificationChannel(CHANNEL, "Edge alarms", NotificationManager.IMPORTANCE_HIGH)
        c.description = "Something an agent did with your key that should stand out: an alarm receipt, an ARM that did not match, a press during a live budget, refused ARMs, a receipt owed too long."
        c.enableVibration(true)
        c.lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        manager.createNotificationChannel(c)
      }
      if (manager.getNotificationChannel(CHANNEL_NOTICE) == null) {
        val c = NotificationChannel(CHANNEL_NOTICE, "Edge notices", NotificationManager.IMPORTANCE_LOW)
        c.description = "Quiet news: a budget used up or expired (expect a continue request)."
        manager.createNotificationChannel(c)
      }
    }

    /* the heartbeat watchdog: native, so it notices when the JS side has gone */
    private fun startWatchdog() {
      if (watchdogOn) return
      watchdogOn = true
      handler.postDelayed(object : Runnable {
        override fun run() {
          val app = appContext
          if (app != null && watching && !stoppedShown && System.currentTimeMillis() - lastBeat > BEAT_TIMEOUT_MS) {
            val manager = manager(app)
            channels(manager)
            val launch = app.packageManager.getLaunchIntentForPackage(app.packageName)
            val open = PendingIntent.getActivity(app, 1, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            manager.notify(ID_STOPPED, builder(app, CHANNEL)
              .setSmallIcon(R.drawable.ic_stat_o)
              .setContentTitle("Edge watching stopped: open ok-rn")
              .setContentText("No Edge alarms reach you until ok-rn is open again.")
              .setContentIntent(open)
              .setVisibility(Notification.VISIBILITY_PUBLIC)
              .build())
            stoppedShown = true
          }
          /* the JS side's clock: its own timers stop in the background (see the spec's onWatchTick) */
          if (watching) instance?.get()?.let { m -> try { m.emitOnWatchTick() } catch (_: Throwable) {} }
          handler.postDelayed(this, CHECK_MS)
        }
      }, CHECK_MS)
    }
  }
}
