package com.okrn.btkbd

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothHidDevice
import android.bluetooth.BluetoothHidDeviceAppSdpSettings
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import com.okrn.specs.NativeBtKeyboardSpec
import java.util.concurrent.Executors

/**
 * The phone as a Bluetooth keyboard.
 *
 * `BluetoothHidDevice` is the Device half of Bluetooth Classic HID: the phone
 * publishes an SDP record describing a keyboard, a host bonds with it from its
 * own Bluetooth settings, and from then on `sendReport` puts bytes on the
 * interrupt channel. To the host it is a keyboard - not an app, not a file
 * transfer, not something it has to be told about.
 *
 * The reports are the firmware's own. Nothing here builds one.
 */
class NativeBtKeyboardModule(private val reactContext: ReactApplicationContext) :
  NativeBtKeyboardSpec(reactContext) {

  private val manager: BluetoothManager? =
    reactContext.getSystemService(BluetoothManager::class.java)

  private val adapter: BluetoothAdapter? get() = manager?.adapter

  /**
   * The profile proxy, once the platform hands it over.
   *
   * `getProfileProxy` is asynchronous and, on a build without the HID Device
   * profile, NEVER CALLS BACK AT ALL - it just returns false, or returns true
   * and stays silent. So everything that needs the proxy waits on a promise
   * with a deadline rather than assuming it will arrive.
   */
  private var proxy: BluetoothHidDevice? = null
  private var registered = false
  private var host: BluetoothDevice? = null

  /**
   * Callbacks arrive on this, and reports are sent from it.
   *
   * A dedicated single thread rather than the main looper: `sendReport` blocks
   * on the radio, and a slot being typed is dozens of reports back to back.
   */
  private val worker = Executors.newSingleThreadExecutor()

  private var state = "unregistered"

  /** The promise waiting on the system's discoverability dialog, if any. */
  private var pendingDiscoverable: Promise? = null

  private val activityListener: ActivityEventListener =
    object : BaseActivityEventListener() {
      override fun onActivityResult(
        activity: Activity,
        requestCode: Int,
        resultCode: Int,
        data: Intent?,
      ) {
        if (requestCode != DISCOVERABLE_REQUEST_CODE) return
        val promise = pendingDiscoverable ?: return
        pendingDiscoverable = null
        /*
         * RESULT_CANCELED means declined. Anything else is the number of
         * seconds granted, which the system may have shortened.
         */
        promise.resolve(resultCode != Activity.RESULT_CANCELED)
      }
    }

  init {
    reactContext.addActivityEventListener(activityListener)
  }

  // --------------------------------------------------------------- lifecycle

  override fun invalidate() {
    runCatching { reactApplicationContext.removeActivityEventListener(activityListener) }
    pendingDiscoverable?.reject(ERR, "the module was torn down")
    pendingDiscoverable = null
    runCatching { unregisterInternal() }
    runCatching { worker.shutdownNow() }
    super.invalidate()
  }

  override fun isSupported(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
        promise.resolve(false)
        return
      }
      val a = adapter
      if (a == null || !a.isEnabled) {
        promise.resolve(false)
        return
      }
      /*
       * Asking for the proxy IS the support check. The HID Device profile is
       * optional in AOSP and a build without it returns false here, which is
       * the only reliable signal - the constant exists on every API 28+ device
       * whether or not the profile behind it does.
       */
      promise.resolve(ensureProxy())
    } catch (e: Exception) {
      promise.reject(ERR, e.message ?: "isSupported failed", e)
    }
  }

  // -------------------------------------------------------------- permissions

  private fun requiredPermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      arrayOf(Manifest.permission.BLUETOOTH_CONNECT)
    } else {
      /*
       * Before API 31 the BLUETOOTH permissions are install-time, so there is
       * nothing to ask for and nothing to be refused.
       */
      arrayOf()
    }

  private fun hasPermissions(): Boolean = requiredPermissions().all {
    ContextCompat.checkSelfPermission(reactContext, it) == PackageManager.PERMISSION_GRANTED
  }

  override fun requestPermissions(promise: Promise) {
    if (hasPermissions()) {
      promise.resolve(true)
      return
    }
    val activity = reactApplicationContext.currentActivity as? PermissionAwareActivity
    if (activity == null) {
      promise.reject(ERR, "no activity available to request permissions")
      return
    }
    activity.requestPermissions(
      requiredPermissions(),
      PERMISSION_REQUEST_CODE,
      PermissionListener { requestCode, _, grantResults ->
        if (requestCode == PERMISSION_REQUEST_CODE) {
          promise.resolve(
            grantResults.isNotEmpty() &&
              grantResults.all { it == PackageManager.PERMISSION_GRANTED },
          )
        }
        true
      },
    )
  }

  // ------------------------------------------------------------------- proxy

  /** Blocks until the profile proxy arrives, or decides it is not coming. */
  private fun ensureProxy(): Boolean {
    proxy?.let { return true }

    val a = adapter ?: return false
    val latch = java.util.concurrent.CountDownLatch(1)

    val asked = a.getProfileProxy(
      reactContext,
      object : BluetoothProfile.ServiceListener {
        override fun onServiceConnected(profile: Int, service: BluetoothProfile?) {
          if (profile == BluetoothProfile.HID_DEVICE) {
            proxy = service as? BluetoothHidDevice
            latch.countDown()
          }
        }

        override fun onServiceDisconnected(profile: Int) {
          if (profile == BluetoothProfile.HID_DEVICE) {
            proxy = null
            registered = false
            host = null
            setState("unregistered", "the Bluetooth service went away")
          }
        }
      },
      BluetoothProfile.HID_DEVICE,
    )
    if (!asked) return false

    /* Bounded, because a build without the profile never calls back. */
    latch.await(PROXY_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
    return proxy != null
  }

  // ---------------------------------------------------------------- register

  override fun register(promise: Promise) {
    try {
      if (!hasPermissions()) {
        promise.reject(ERR, "BLUETOOTH_CONNECT has not been granted")
        return
      }
      if (registered) {
        promise.resolve(true)
        return
      }
      if (!ensureProxy()) {
        setState("unsupported", "this device does not offer the HID Device profile")
        promise.resolve(false)
        return
      }

      val sdp = BluetoothHidDeviceAppSdpSettings(
        SDP_NAME,
        SDP_DESCRIPTION,
        SDP_PROVIDER,
        BluetoothHidDevice.SUBCLASS1_KEYBOARD,
        KEYBOARD_DESCRIPTOR,
      )

      val ok = proxy!!.registerApp(sdp, null, null, worker, callback)
      if (!ok) {
        promise.reject(ERR, "the platform refused to publish the keyboard")
        return
      }
      /*
       * registerApp returning true only means the request was accepted. The
       * profile is not live until onAppStatusChanged says so, which is where
       * `registered` is actually set.
       */
      setState("registering", "publishing the keyboard")
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject(ERR, e.message ?: "register failed", e)
    }
  }

  private fun unregisterInternal() {
    proxy?.let { p ->
      runCatching { host?.let { p.disconnect(it) } }
      runCatching { p.unregisterApp() }
    }
    registered = false
    host = null
  }

  override fun unregister(promise: Promise) {
    try {
      unregisterInternal()
      setState("unregistered", "the keyboard is no longer published")
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject(ERR, e.message ?: "unregister failed", e)
    }
  }

  // ------------------------------------------------------------------- hosts

  override fun requestDiscoverable(seconds: Double, promise: Promise) {
    try {
      val activity = getCurrentActivity()
      if (activity == null) {
        promise.reject(ERR, "no activity; the app is not in the foreground")
        return
      }
      if (pendingDiscoverable != null) {
        promise.reject(ERR, "already asking to be discoverable")
        return
      }

      val intent = Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE).apply {
        putExtra(
          BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION,
          seconds.toInt().coerceIn(1, MAX_DISCOVERABLE_SECONDS),
        )
      }
      pendingDiscoverable = promise
      activity.startActivityForResult(intent, DISCOVERABLE_REQUEST_CODE)
    } catch (e: Exception) {
      pendingDiscoverable = null
      promise.reject(ERR, e.message ?: "requestDiscoverable failed", e)
    }
  }

  /**
   * The host to type at, asking the PROFILE rather than trusting our own note.
   *
   * The note is set from onConnectionStateChanged, and that callback is a
   * notification rather than the truth: a connection made while the app was
   * re-registering, or before this module instance existed, arrives with no
   * callback at all. It happened - the profile reported a connected device
   * while the screen still read "connecting". Gating typing on the note
   * instead of on the profile gives a keyboard that is connected and will
   * not type.
   */
  private fun currentHost(): BluetoothDevice? =
    host ?: proxy?.connectedDevices?.firstOrNull()?.also { host = it }

  override fun localName(promise: Promise) {
    try {
      promise.resolve(runCatching { adapter?.name }.getOrNull() ?: "")
    } catch (e: Exception) {
      promise.reject(ERR, e.message ?: "localName failed", e)
    }
  }

  override fun hosts(promise: Promise) {
    try {
      if (!hasPermissions()) {
        promise.reject(ERR, "BLUETOOTH_CONNECT has not been granted")
        return
      }
      val a = adapter
      if (a == null) {
        promise.resolve(Arguments.createArray())
        return
      }

      /*
       * Bonded devices, not a scan.
       *
       * A keyboard does not go looking for hosts - the host pairs with IT, and
       * the pairing is what makes the link trusted. Anything not bonded cannot
       * be typed at, so scanning would only offer choices that cannot work.
       */
      val connected = proxy?.connectedDevices ?: emptyList()
      val out = Arguments.createArray()
      for (device in a.bondedDevices.orEmpty()) {
        val row = Arguments.createMap()
        row.putString("address", device.address)
        row.putString("name", runCatching { device.name }.getOrNull() ?: "")
        row.putBoolean("connected", connected.any { it.address == device.address })
        out.pushMap(row)
      }
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject(ERR, e.message ?: "hosts failed", e)
    }
  }

  override fun connect(address: String, promise: Promise) {
    try {
      val p = proxy
      if (p == null || !registered) {
        promise.reject(ERR, "the keyboard is not published yet")
        return
      }
      val device = adapter?.bondedDevices?.firstOrNull { it.address == address }
      if (device == null) {
        /*
         * Deliberately not getRemoteDevice(address). That accepts any address
         * and would happily try to reach something this phone has never paired
         * with; a keyboard can only be typed at over a bond.
         */
        promise.reject(ERR, "no bonded device with that address")
        return
      }
      setState("connecting", "asking ${device.name ?: address} to connect")
      promise.resolve(p.connect(device))
    } catch (e: Exception) {
      promise.reject(ERR, e.message ?: "connect failed", e)
    }
  }

  override fun disconnect(promise: Promise) {
    try {
      val p = proxy
      val h = currentHost()
      if (p != null && h != null) p.disconnect(h)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject(ERR, e.message ?: "disconnect failed", e)
    }
  }

  // ------------------------------------------------------------------ typing

  override fun sendReport(hex: String, promise: Promise) {
    try {
      val p = proxy
      val h = currentHost()
      if (p == null || !registered || h == null) {
        /* Nothing is listening. The key types anyway; that is not an error. */
        promise.resolve(false)
        return
      }

      val bytes = hexToBytes(hex)
      if (bytes.size != REPORT_BYTES) {
        promise.reject(ERR, "a keyboard report is $REPORT_BYTES bytes, got ${bytes.size}")
        return
      }

      /*
       * Report id 0: the descriptor declares no Report ID item, so the report
       * travels bare, exactly as it does over USB.
       */
      promise.resolve(p.sendReport(h, 0, bytes))
    } catch (e: Exception) {
      promise.reject(ERR, e.message ?: "sendReport failed", e)
    }
  }

  // --------------------------------------------------------------- callbacks

  private val callback = object : BluetoothHidDevice.Callback() {
    override fun onAppStatusChanged(pluggedDevice: BluetoothDevice?, isRegistered: Boolean) {
      registered = isRegistered
      if (isRegistered) {
        setState("registered", "the keyboard is published; pair from the other device")
      } else {
        host = null
        setState("unregistered", "the keyboard is no longer published")
      }
    }

    override fun onConnectionStateChanged(device: BluetoothDevice?, newState: Int) {
      when (newState) {
        BluetoothProfile.STATE_CONNECTED -> {
          host = device
          setState("connected", "typing to ${nameOf(device)}")
        }
        BluetoothProfile.STATE_CONNECTING ->
          setState("connecting", "connecting to ${nameOf(device)}")
        BluetoothProfile.STATE_DISCONNECTED -> {
          if (device == null || device.address == host?.address) host = null
          setState("disconnected", "${nameOf(device)} is not connected")
        }
      }
    }

    /*
     * A host may ask the keyboard for its current state, and it may set the
     * LEDs (caps lock and friends). Neither is answered with anything real:
     * the firmware owns the key state and has no LED report to give, and
     * inventing one here would be inventing keyboard state the key does not
     * have. Replying with an empty report is well-formed and says nothing.
     */
    override fun onGetReport(device: BluetoothDevice?, type: Byte, id: Byte, bufferSize: Int) {
      val p = proxy ?: return
      if (device != null) p.replyReport(device, type, id, ByteArray(REPORT_BYTES))
    }

    override fun onSetReport(device: BluetoothDevice?, type: Byte, id: Byte, data: ByteArray?) {
      /* LED state from the host. Nothing here consumes it. */
    }
  }

  private fun nameOf(device: BluetoothDevice?): String =
    device?.let { runCatching { it.name }.getOrNull() ?: it.address } ?: "the host"

  // ------------------------------------------------------------------ events

  private fun setState(next: String, message: String) {
    state = next
    val event: WritableMap = Arguments.createMap()
    event.putString("state", next)
    event.putString("message", message)
    event.putString("address", host?.address ?: "")
    event.putString("name", host?.let { runCatching { it.name }.getOrNull() } ?: "")
    try {
      emitOnStatus(event)
    } catch (_: Exception) {
      /* Raised before JS subscribed, or after teardown. Dropping it is right. */
    }
  }

  private fun hexToBytes(hex: String): ByteArray {
    val clean = hex.trim()
    require(clean.length % 2 == 0) { "hex must have an even length" }
    return ByteArray(clean.length / 2) {
      clean.substring(it * 2, it * 2 + 2).toInt(16).toByte()
    }
  }

  companion object {
    const val ERR = "E_BT_KEYBOARD"
    private const val PERMISSION_REQUEST_CODE = 8213
    private const val DISCOVERABLE_REQUEST_CODE = 8214

    /** The platform ignores anything longer, so asking for more is a lie. */
    private const val MAX_DISCOVERABLE_SECONDS = 300
    private const val PROXY_TIMEOUT_MS = 4000L

    /** [modifiers, reserved, usage x 6] - the boot keyboard report. */
    private const val REPORT_BYTES = 8

    private const val SDP_NAME = "OnlyKey"
    private const val SDP_DESCRIPTION = "OnlyKey soft key"
    private const val SDP_PROVIDER = "OnlyKey"

    /**
     * The firmware's own keyboard report descriptor.
     *
     * Copied from `core/usb_desc.c:188-227` rather than written fresh, so the
     * reports the firmware emits describe themselves the same way over
     * Bluetooth as over USB - including `Logical Maximum 0x7F`, which is
     * higher than the usual boot-keyboard 101 and is what lets the key type
     * everything in its tables.
     *
     * The one omission is the trailing 8-byte Feature report (usage 0x76). On
     * USB that is the Yubikey OTP / HMAC-SHA1 channel and it rides control
     * transfers; there is no such channel here, and declaring a feature report
     * nothing can answer invites a host to ask for one.
     */
    private val KEYBOARD_DESCRIPTOR = byteArrayOf(
      0x05, 0x01,             // Usage Page (Generic Desktop)
      0x09, 0x06,             // Usage (Keyboard)
      0xA1.toByte(), 0x01,    // Collection (Application)
      0x05, 0x07,             //   Usage Page (Key Codes)
      0x19, 0xE0.toByte(),    //   Usage Minimum (224)
      0x29, 0xE7.toByte(),    //   Usage Maximum (231)
      0x15, 0x00,             //   Logical Minimum (0)
      0x25, 0x01,             //   Logical Maximum (1)
      0x75, 0x01,             //   Report Size (1)
      0x95.toByte(), 0x08,    //   Report Count (8)
      0x81.toByte(), 0x02,    //   Input (Data, Variable, Absolute)  modifiers
      0x95.toByte(), 0x01,    //   Report Count (1)
      0x75, 0x08,             //   Report Size (8)
      /*
       * A BARE CONSTANT, with no usage on it.
       *
       * This used to declare the reserved byte as Usage Page (Consumer) /
       * Usage (Eject) before the constant - which Apple's descriptor does, and
       * which is where this was copied from. Windows rejects the whole
       * descriptor for it:
       *
       *   DEVPKEY_Device_DriverProblemDesc
       *   "The HID Report Descriptor failed validation. An unknown item was
       *    found in the descriptor."
       *   ProblemStatus 0xC000001D, ProblemCode 10
       *
       * hidparse validates before HidBth starts, so the driver never starts,
       * never opens the HID L2CAP channels, and the host drops the ACL a few
       * seconds later. From the phone that reads as "the host refused us" and
       * from the host as "device cannot start" - neither of which names the
       * descriptor. Windows' own DriverProblemDesc does.
       *
       * The HID spec's boot keyboard (Appendix B.1) has nothing here but the
       * constant, and the byte is padding the host ignores either way: the
       * reports this forwards always carry 0 in it.
       */
      0x81.toByte(), 0x01,    //   Input (Constant)                  reserved
      0x95.toByte(), 0x05,    //   Report Count (5)
      0x75, 0x01,             //   Report Size (1)
      0x05, 0x08,             //   Usage Page (LEDs)
      0x19, 0x01,             //   Usage Minimum (1)
      0x29, 0x05,             //   Usage Maximum (5)
      0x91.toByte(), 0x02,    //   Output (Data, Variable, Absolute) LED report
      0x95.toByte(), 0x01,    //   Report Count (1)
      0x75, 0x03,             //   Report Size (3)
      0x91.toByte(), 0x01,    //   Output (Constant)                 LED padding
      0x95.toByte(), 0x06,    //   Report Count (6)
      0x75, 0x08,             //   Report Size (8)
      0x15, 0x00,             //   Logical Minimum (0)
      0x25, 0x7F,             //   Logical Maximum (127)
      0x05, 0x07,             //   Usage Page (Key Codes)
      0x19, 0x00,             //   Usage Minimum (0)
      0x29, 0x7F,             //   Usage Maximum (127)
      0x81.toByte(), 0x00,    //   Input (Data, Array)               keys
      0xC0.toByte(),          // End Collection
    )
  }
}
