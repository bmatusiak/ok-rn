package com.okrn.usb

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import java.util.concurrent.ConcurrentHashMap

/**
 * Turns Android's asynchronous USB permission intent into a callback, and
 * surfaces hot-plug events.
 *
 * Both are called out in EXPLAINER/!.md section 1: permission arrives via a
 * broadcast rather than a return value, and devices come and go while the app
 * is running, so reconnect has to be event-driven rather than polled.
 */
class UsbPermissionBroker(
  private val context: Context,
  private val usbManager: UsbManager,
) {
  private val pending = ConcurrentHashMap<String, (Boolean) -> Unit>()
  private var registered = false

  /** Fired when a matching device is plugged in or pulled out. */
  var onAttached: ((UsbDevice) -> Unit)? = null
  var onDetached: ((UsbDevice) -> Unit)? = null

  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
      val device: UsbDevice? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
      }

      when (intent.action) {
        ACTION_USB_PERMISSION -> {
          val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
          val key = device?.deviceName ?: return
          pending.remove(key)?.invoke(granted)
        }
        UsbManager.ACTION_USB_DEVICE_ATTACHED -> device?.let { onAttached?.invoke(it) }
        UsbManager.ACTION_USB_DEVICE_DETACHED -> device?.let { onDetached?.invoke(it) }
      }
    }
  }

  fun register() {
    if (registered) return
    val filter = IntentFilter().apply {
      addAction(ACTION_USB_PERMISSION)
      addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
      addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      context.registerReceiver(receiver, filter)
    }
    registered = true
  }

  fun unregister() {
    if (!registered) return
    try {
      context.unregisterReceiver(receiver)
    } catch (_: IllegalArgumentException) {
      // Not registered; nothing to do.
    }
    registered = false
    pending.clear()
  }

  /**
   * Requests permission for [device], invoking [callback] once the user answers.
   * Resolves immediately if permission is already held.
   */
  fun request(device: UsbDevice, callback: (Boolean) -> Unit) {
    if (usbManager.hasPermission(device)) {
      callback(true)
      return
    }
    register()
    pending[device.deviceName] = callback

    val intent = Intent(ACTION_USB_PERMISSION).setPackage(context.packageName)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val pendingIntent = PendingIntent.getBroadcast(context, 0, intent, flags)
    usbManager.requestPermission(device, pendingIntent)
  }

  companion object {
    const val ACTION_USB_PERMISSION = "com.okrn.USB_PERMISSION"
  }
}
