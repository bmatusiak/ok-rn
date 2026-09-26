package com.okrn.fido

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import com.okrn.R

/**
 * Keeps the process in the foreground while the GATT server is up.
 *
 * WHY A SERVICE AT ALL. The BLE security-key session is long: a desktop that
 * paired once holds the link for as long as the browser is open, and every
 * WebAuthn ceremony arrives on it. An Android process with no visible
 * activity and no foreground service is a background process, and the OS
 * throttles and then kills those. A foreground service is the one contract
 * Android offers for "this process is doing something the user asked for
 * and can see": the notification below IS that visibility. The README
 * carried this as a known gap ("the permissions are declared and the
 * service is not written") until 2026-09-11.
 *
 * WHY connectedDevice. Android 14 requires a foreground service to declare
 * its type and hold the matching permission; CONNECTED_DEVICE is the type
 * for "talking to a Bluetooth peripheral", and the manifest declares both
 * (FOREGROUND_SERVICE_CONNECTED_DEVICE next to the service entry).
 *
 * WHY THE PLATFORM BUILDER, NOT ANDROIDX. One notification does not earn a
 * compat layer. minSdk is 24 and channels arrived at 26, so the two
 * pre-channel releases get the old constructor behind a version check
 * rather than a dependency.
 *
 * NOT A PROCESS OF ITS OWN. It runs in the main process next to the GATT
 * server it protects; it holds no state and does no work. Start and stop
 * are called by NativeFidoGattModule exactly where the server opens and
 * closes, so the notification is on screen precisely while the phone is
 * advertising or connected as a security key, and gone otherwise.
 *
 * POST_NOTIFICATIONS is a runtime permission on API 33+. Without it the
 * notification is not SHOWN, but the service still runs in the foreground
 * and the process is still protected; the module asks for it together with
 * the Bluetooth permissions and does not require it.
 */
class FidoGattService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    ensureChannel()
    val notification = build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    /*
     * NOT sticky. If the OS ever kills the process anyway, a restarted
     * service would put up "acting as a security key" over a GATT server
     * that no longer exists; the module starts it again when it re-opens.
     */
    return START_NOT_STICKY
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Security key over Bluetooth",
      NotificationManager.IMPORTANCE_LOW, // no sound, no heads-up: a status, not an alert
    )
    channel.description = "Shown while this phone is acting as a security key for a paired computer."
    manager.createNotificationChannel(channel)
  }

  private fun build(): Notification {
    val open = PendingIntent.getActivity(
      this,
      0,
      packageManager.getLaunchIntentForPackage(packageName),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    @Suppress("DEPRECATION")
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      Notification.Builder(this)
    }
    return builder
      /*
       * The status-bar icon: drawable-nodpi/ic_stat_o.png, the O (O.png) on a
       * transparent square. Android draws a small icon from its alpha, and the
       * launcher icon's solid circle came out as a plain circle.
       *
       * A PLAIN PNG ON PURPOSE. The system tints a small icon only when it
       * recognises it as grayscale (ContrastColorUtil.isGrayscaleIcon), and
       * that understands a bitmap or a vector, not a layer-list. On the Galaxy
       * A13 (Android 13, 2026-09-25) a layer-list version stayed BLACK on the
       * dark status bar while every other icon turned white; the Pixel
       * (Android 17) tinted it anyway, which hid that. An XML <bitmap> with
       * gravity="center" was tinted but not scaled - it showed the middle of
       * the O. The square PNG is both recognised and scaled.
       */
      .setSmallIcon(R.drawable.ic_stat_o)
      .setContentTitle("Acting as a security key")
      .setContentText("A paired computer can ask this phone to sign in. Tap to open.")
      .setContentIntent(open)
      .setOngoing(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .build()
  }

  companion object {
    const val CHANNEL_ID = "okrn.fido.gatt"
    const val NOTIFICATION_ID = 0x0F1D

    /** Called by the module when the GATT server opens. Idempotent. */
    fun start(context: Context) {
      val intent = Intent(context, FidoGattService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    /** Called by the module when the GATT server closes. Safe when not running. */
    fun stop(context: Context) {
      context.stopService(Intent(context, FidoGattService::class.java))
    }
  }
}
