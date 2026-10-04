package com.okrn.emu

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.ReactApplicationContext
import com.okrn.R
import com.okrn.specs.NativeEdgeAlertSpec

/**
 * B7: Edge alarms as phone notifications, one per link, so they stand out
 * without looking at the tab. Separate from PressAlert's single "press needed"
 * notification: that one is replaced while a press waits; these stay until read.
 *
 * Tapping one opens MainActivity with EXTRA_SEQ; MainActivity hands it to
 * [opened], and the Edge tab collects it with takeOpenedSeq() when it next looks
 * (on mount and on every return to the foreground).
 */
class NativeEdgeAlertModule(reactContext: ReactApplicationContext) : NativeEdgeAlertSpec(reactContext) {

  override fun getName() = NAME

  override fun post(seq: Double, title: String, text: String) {
    val app = reactApplicationContext.applicationContext
    val manager = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    channel(manager)
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
    @Suppress("DEPRECATION")
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(app, CHANNEL) else Notification.Builder(app)
    val n = builder
      .setSmallIcon(R.drawable.ic_stat_o)
      .setContentTitle(title)
      .setContentText(text)
      .setStyle(Notification.BigTextStyle().bigText(text))
      .setContentIntent(open)
      .setAutoCancel(true)
      .setCategory(Notification.CATEGORY_ALARM)
      .build()
    manager.notify(ID_BASE + (s and 0xffffff).toInt(), n)
  }

  override fun takeOpenedSeq(): Double {
    val s = opened
    opened = -1L
    return s.toDouble()
  }

  private fun channel(manager: NotificationManager) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (manager.getNotificationChannel(CHANNEL) != null) return
    val c = NotificationChannel(CHANNEL, "Edge alarms", NotificationManager.IMPORTANCE_HIGH)
    c.description = "Something an agent did with your key that should stand out: an alarm ticket, an ARM that did not match, a press during a live budget, a budget used up or expired."
    c.enableVibration(true)
    manager.createNotificationChannel(c)
  }

  companion object {
    const val NAME = "NativeEdgeAlert"
    const val CHANNEL = "okrn.edge.alarm"
    const val EXTRA_SEQ = "okrn.edgeSeq"
    private const val ID_BASE = 0x0E000000

    /** the link of the last tapped alarm, until the tab takes it; -1 = none */
    @Volatile @JvmStatic var opened: Long = -1L

    /** MainActivity: a launch or new intent from one of these notifications */
    @JvmStatic fun fromIntent(intent: Intent?) {
      if (intent != null && intent.hasExtra(EXTRA_SEQ)) {
        opened = intent.getLongExtra(EXTRA_SEQ, -1L)
        intent.removeExtra(EXTRA_SEQ)
      }
    }
  }
}
