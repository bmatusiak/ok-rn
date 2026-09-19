package com.okrn.btkbd

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothHidDevice
import android.bluetooth.BluetoothHidDeviceAppSdpSettings
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.util.Log
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
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

  init {
    Held.live = this
    /* Both outlive this module, so they are set up from whichever one is first. */
    Held.watchAdapter(reactContext.applicationContext)
  }

  /*
   * EVERY FIELD BELOW LIVES IN `Held`, and these are accessors onto it. Same
   * shape as NativeFidoGattModule.kt:111-122, and for the same reason - see
   * the comment on `Held` at the bottom of this file, which is the whole
   * reason the keyboard used to disappear from Windows.
   */
  private var proxy: BluetoothHidDevice?
    get() = Held.proxy
    set(value) { Held.proxy = value }

  private var registered: Boolean
    get() = Held.registered
    set(value) { Held.registered = value }

  private var host: BluetoothDevice?
    get() = Held.host
    set(value) { Held.host = value }

  private val worker get() = Held.worker
  private val callback get() = Held.callback

  private var state: String
    get() = Held.state
    set(value) { Held.state = value }

  // --------------------------------------------------------------- lifecycle

  /**
   * THE SDP RECORD OUTLIVES THE JS BRIDGE, and that is the point.
   *
   * This used to call unregisterInternal() - disconnect plus unregisterApp() -
   * and shut the worker down. invalidate() runs on EVERY bridge teardown: a
   * Metro reload, a rotation, the activity being destroyed. So in development
   * the keyboard's SDP record was absent more often than it was present.
   *
   * That is invisible until you notice what Windows does with it. Windows
   * reads a Classic device's SDP record ONCE, when it bonds, and never again.
   * Bond during one of those windows and the host caches a phone with no
   * keyboard - permanently, for that bond, whatever the app does afterwards.
   * Re-pair at a luckier moment and it works again, which is why this looked
   * like it was being fixed and broken by unrelated changes for two days.
   * tools/btcache.js reads the host's side of it; tools/btpurge.ps1 clears it.
   *
   * So teardown drops the JS pointer and nothing else, exactly as
   * NativeFidoGattModule does. unregisterApp() is now reachable only from
   * unregister(), which the master switch calls - a deliberate act.
   */
  override fun invalidate() {
    if (Held.live === this) Held.live = null
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
            /*
             * ASK FOR IT BACK. This used to stop here, and the keyboard simply
             * stayed down until someone restarted the app - which is both a
             * dead feature and the window in which a host bonds without a
             * keyboard and caches that forever.
             */
            Held.reacquire()
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
      /*
       * "OFF" AND "ABSENT" ARE DIFFERENT ANSWERS, and only one of them is
       * permanent. ensureProxy() fails for either reason, and this used to
       * call both of them `unsupported` - a state the app treats as terminal
       * and stops retrying. Toggling Bluetooth off for four seconds was enough
       * to latch it: observed at 23:19:41 on 2026-09-18, between the adapter
       * going down and coming back, on a phone that plainly does offer the
       * profile and had been publishing a keyboard seconds earlier.
       */
      val a = adapter
      if (a == null || !a.isEnabled) {
        setState("unregistered", "Bluetooth is off")
        promise.resolve(false)
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
      /*
       * The INTENT, recorded after the request is accepted so recovery cannot
       * race the first publish. Held.reacquire() reads this to decide whether
       * a stack bounce should be followed by republishing.
       */
      Held.wantRegistered = true
      setState("registering", "publishing the keyboard")
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject(ERR, e.message ?: "register failed", e)
    }
  }

  private fun unregisterInternal() {
    /* A deliberate withdrawal, so nothing should bring it back. */
    Held.wantRegistered = false
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

  // ------------------------------------------------------------------ events

  private fun setState(next: String, message: String) {
    Held.setState(next, message)
  }

  /** Put one status on the JS bridge. Called by `Held`, which owns the state. */
  internal fun emitStatus(next: String, message: String) {
    /*
     * TO LOGCAT AS WELL AS TO JS, for the same reason the hard key does it
     * (useHardKey.ts:116): the in-app log cannot be read from a terminal, and
     * every state this keyboard passes through - unsupported, registering,
     * registered, connecting, connected, disconnected - was previously
     * invisible to anyone not looking at the screen. A report of "it does not
     * connect" could not be told apart from "it never tried", because nothing
     * anywhere recorded which. tools/logwatch.js watches for these.
     */
    Log.i(TAG, "$next: $message")
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
    internal const val PROXY_TIMEOUT_MS = 4000L

    /** [modifiers, reserved, usage x 6] - the boot keyboard report. */
    /* internal, not private: `Held`'s callback replies with an empty one. */
    internal const val REPORT_BYTES = 8

    internal const val SDP_NAME = "OnlyKey"
    /* internal, not private: `Held` logs adapter recovery under the same tag. */
    internal const val TAG = "btkbd"

    internal const val SDP_DESCRIPTION = "OnlyKey soft key"
    internal const val SDP_PROVIDER = "OnlyKey"

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
    internal val KEYBOARD_DESCRIPTOR = byteArrayOf(
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

private fun nameOf(device: BluetoothDevice?): String =
  device?.let { runCatching { it.name }.getOrNull() ?: it.address } ?: "the host"

/**
 * The keyboard, for as long as the PROCESS lives rather than the JS bridge.
 *
 * ## Why any of this is here
 *
 * All of this state used to be instance fields on the module, and the module
 * is recreated on every Metro reload, rotation and activity restart. Its
 * invalidate() unregistered the HID app each time, which removes the phone's
 * SDP record from the adapter - so the keyboard blinked out of existence
 * constantly while the authenticator, which already holds its GATT server this
 * way (NativeFidoGattModule `Held`), stayed up throughout.
 *
 * That asymmetry is what made the two roles look like they were fighting. They
 * share no transport at all: the authenticator is BLE GATT, this is Bluetooth
 * Classic HID with an SDP record. Nothing here can break that one. What broke
 * was the host's CACHE - Windows reads a Classic SDP record once, at bond
 * time, and if the record is missing then, that bond has no keyboard forever.
 * Fixing "the other role" and re-pairing appeared to fix it, every time.
 *
 * ## What this changes
 *
 * The record is published once and stays published until something deliberate
 * takes it down. The worker is process-scoped too - a per-instance executor
 * shut down on reload is the same bug wearing a different hat, and it would
 * have stopped reports mid-type.
 */
private object Held {
  /** The module JS is currently talking to. Null between teardown and remount. */
  var live: NativeBtKeyboardModule? = null

  var proxy: BluetoothHidDevice? = null
  var registered = false
  var host: BluetoothDevice? = null
  var state = "unregistered"

  /**
   * Whether the keyboard is SUPPOSED to be published, as distinct from whether
   * it currently is.
   *
   * Android drops an app's HID registration when the Bluetooth stack bounces -
   * an adapter toggle, or a device being unpaired - and the profile proxy goes
   * with it. Observed on 2026-09-18: removing the host pairing produced
   *
   *   btkbd: unregistered: the Bluetooth service went away
   *
   * and the keyboard stayed down. The authenticator rode the same bounce out,
   * because NativeFidoGattModule has a watchdog; this had nothing, so the
   * phone silently stopped being a keyboard and the screen agreed with it.
   *
   * That matters beyond development. The window where the SDP record is absent
   * is exactly the window in which a host bonding with this phone caches a
   * device with no keyboard - permanently, for that bond. See
   * FINDING-a-bond-caches-the-sdp-record-and-the-phone-kept-deleting-it.md.
   */
  var wantRegistered = false

  /** Outlives the module, so recovery does not need a live JS bridge. */
  var appContext: android.content.Context? = null

  private var watchingAdapter = false

  /**
   * Callbacks arrive on this, and reports are sent from it.
   *
   * A dedicated single thread rather than the main looper: `sendReport` blocks
   * on the radio, and a slot being typed is dozens of reports back to back.
   * Process-scoped, so a reload mid-slot does not drop the rest of it.
   */
  val worker: java.util.concurrent.ExecutorService = Executors.newSingleThreadExecutor()

  /**
   * ONE callback object for the life of the process.
   *
   * registerApp() binds this instance; a per-module one would mean the object
   * that registered no longer being the object still receiving - and the
   * unregisterApp() that matched it gone with the previous module.
   */
  val callback = object : BluetoothHidDevice.Callback() {
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
      if (device != null) {
        p.replyReport(device, type, id, ByteArray(NativeBtKeyboardModule.REPORT_BYTES))
      }
    }

    override fun onSetReport(device: BluetoothDevice?, type: Byte, id: Byte, data: ByteArray?) {
      /* LED state from the host. Nothing here consumes it. */
    }
  }

  /**
   * The state is kept HERE, and only the telling of it needs a live module.
   *
   * A status raised while JS is away - which is exactly when a reload-induced
   * bounce would happen - updates the truth and is simply not delivered. The
   * next mount reads getState() and sees where things actually stand, rather
   * than inheriting "unregistered" from a fresh instance's initialiser.
   */
  fun setState(next: String, message: String) {
    state = next
    live?.emitStatus(next, message)
  }

  private fun adapter(): BluetoothAdapter? =
    appContext?.getSystemService(BluetoothManager::class.java)?.adapter

  private fun sdp() = BluetoothHidDeviceAppSdpSettings(
    NativeBtKeyboardModule.SDP_NAME,
    NativeBtKeyboardModule.SDP_DESCRIPTION,
    NativeBtKeyboardModule.SDP_PROVIDER,
    BluetoothHidDevice.SUBCLASS1_KEYBOARD,
    NativeBtKeyboardModule.KEYBOARD_DESCRIPTOR,
  )

  /** Publish the record. The caller has already decided that it should be. */
  fun registerNow(): Boolean {
    val p = proxy ?: return false
    return runCatching { p.registerApp(sdp(), null, null, worker, callback) }
      .getOrDefault(false)
  }

  /**
   * Get the profile back and republish, after the stack took both away.
   *
   * `getProfileProxy` is asynchronous and gives no failure callback, so this
   * asks and lets the listener do the work if an answer arrives. Nothing here
   * blocks: it runs from `onServiceDisconnected`, which is a system callback.
   */
  fun reacquire() {
    if (!wantRegistered || proxy != null) return
    val a = adapter() ?: return
    val ctx = appContext ?: return
    if (!a.isEnabled) return  /* the adapter receiver will come back to this */

    runCatching {
      a.getProfileProxy(
        ctx,
        object : BluetoothProfile.ServiceListener {
          override fun onServiceConnected(profile: Int, service: BluetoothProfile?) {
            if (profile != BluetoothProfile.HID_DEVICE) return
            proxy = service as? BluetoothHidDevice
            if (wantRegistered && !registered) {
              setState("registering", "republishing the keyboard")
              if (!registerNow()) {
                setState("unregistered", "the platform refused to republish the keyboard")
              }
            }
          }

          override fun onServiceDisconnected(profile: Int) {
            if (profile != BluetoothProfile.HID_DEVICE) return
            proxy = null
            registered = false
            host = null
            setState("unregistered", "the Bluetooth service went away")
            reacquire()
          }
        },
        BluetoothProfile.HID_DEVICE,
      )
    }
  }

  /**
   * An adapter that comes back on has to be noticed, because the profile
   * service is not there to disconnect while it is off - so
   * `onServiceDisconnected` may be the last thing that ever fires.
   *
   * Registered once, process-wide, and never unregistered: it is how the
   * keyboard survives the user toggling Bluetooth.
   */
  fun watchAdapter(ctx: android.content.Context) {
    if (watchingAdapter) return
    watchingAdapter = true
    appContext = ctx.applicationContext
    runCatching {
      ctx.applicationContext.registerReceiver(
        object : android.content.BroadcastReceiver() {
          override fun onReceive(c: android.content.Context?, intent: android.content.Intent?) {
            if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
            val next = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, -1)
            if (next == BluetoothAdapter.STATE_ON) {
              Log.i(NativeBtKeyboardModule.TAG, "adapter is back; republishing if it should be")
              reacquire()
            } else if (next == BluetoothAdapter.STATE_TURNING_OFF) {
              proxy = null
              registered = false
              host = null
            }
          }
        },
        android.content.IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED),
      )
    }
  }
}
