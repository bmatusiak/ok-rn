package com.okrn.fido

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.content.BroadcastReceiver
import android.content.IntentFilter
import android.provider.Settings
import android.net.Uri
import android.content.Intent
import android.util.Log
import android.os.ParcelUuid
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.core.content.ContextCompat
import com.okrn.specs.NativeFidoGattSpec
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * CTAP2-over-BLE peripheral: advertises the FIDO service so a desktop can use
 * this phone as a roaming security key. See EXPLAINER/z.md.
 *
 * WHAT THIS DOES: the transport half, and only that. GATT server, service and
 * characteristic layout, advertising, MTU negotiation, and BLE
 * fragmentation/reassembly. A reassembled command goes to JS as an
 * onCtapRequest event; JS hands it to the FIRMWARE and returns what the
 * firmware said.
 *
 * THE PHONE IS NOT THE AUTHENTICATOR - the firmware is. So there is no CBOR to
 * build here, no attestation to sign and no credential store to keep. See
 * src/fidoBridge.ts, which states the same thing from the other side.
 *
 * ## The KeyStore credential functions below are from a DIFFERENT design
 *
 * This file used to carry a "SCAFFOLD STATUS" notice saying the CTAP2 command
 * handlers were "still to be built", with makeCredential/getAssertion CBOR and
 * a BiometricPrompt gate named as the next work. That work was never done,
 * because the architecture changed: routing to the firmware replaced making the
 * phone an authenticator in its own right.
 *
 * `createCredential` and `signWithCredential` are what remains of that design -
 * hardware-backed P-256 in the Android KeyStore. Nothing calls them. They are
 * KEPT DELIBERATELY, not overlooked: older firmware may not answer over this
 * path at all, and a phone-side credential is the obvious fallback if it does
 * not. That is a question the firmware version matrix will settle, and deleting
 * the answer before asking the question is the wrong order.
 *
 * Until then they are gated - see UNUSED_KEYSTORE_CREDENTIALS below - so no
 * caller reaches them by accident and nobody reads their presence as a promise.
 */
@ReactModule(name = NativeFidoGattSpec.NAME)
class NativeFidoGattModule(
  private val reactContext: ReactApplicationContext,
) : NativeFidoGattSpec(reactContext) {

  private val bluetoothManager: BluetoothManager? =
    reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

  /*
   * EVERY PIECE OF AUTHENTICATOR STATE LIVES IN `Held`, NOT ON THIS INSTANCE.
   *
   * A React module instance dies with its JS bridge - reload, activity
   * destroyed, app swiped from recents - and a fresh one is built for the next
   * bridge. The GATT server, the advertiser, the half-assembled CTAP frame
   * and the notification queue must NOT die with it, or the phone stops being
   * a security key every time the app blinks (see invalidate()). So the
   * fields below are accessors onto one process-wide holder, and the rest of
   * this file reads exactly as it did when they were plain fields.
   *
   * It also means the callback object the server was opened with may belong
   * to an EARLIER instance than the one JS is currently talking to. That is
   * fine: it reads and writes the same Held state, and emit() routes every
   * event to whichever instance is live now.
   */
  init {
    Held.live = this
  }

  private var gattServer: BluetoothGattServer?
    get() = Held.gattServer
    set(value) { Held.gattServer = value }
  private var advertiser: BluetoothLeAdvertiser?
    get() = Held.advertiser
    set(value) { Held.advertiser = value }
  private var statusCharacteristic: BluetoothGattCharacteristic?
    get() = Held.statusCharacteristic
    set(value) { Held.statusCharacteristic = value }
  private var connectedDevice: BluetoothDevice?
    get() = Held.connectedDevice
    set(value) { Held.connectedDevice = value }

  private val assembler get() = Held.assembler
  private val pendingRequests get() = Held.pendingRequests
  private val requestCounter get() = Held.requestCounter

  /*
   * ANDROID ALLOWS ONE OUTSTANDING NOTIFICATION PER CONNECTION.
   *
   * notifyCharacteristicChanged() hands the fragment to the stack and returns
   * immediately; the next one may only go out after onNotificationSent() says
   * the last was delivered. Firing them in a loop - which is what this did -
   * means everything after the first is dropped, silently, with a success
   * return value on every call.
   *
   * Nothing longer than one fragment had ever worked, and that is nearly
   * everything: authenticatorGetInfo alone is a few hundred bytes against a
   * default 20-byte payload, so the very first thing any browser asks was
   * arriving as its first twenty bytes and then nothing. It presents as the
   * host timing out, which reads like the authenticator never answered.
   */
  private val notifyQueue get() = Held.notifyQueue
  private var notifyInFlight: Boolean
    get() = Held.notifyInFlight
    set(value) { Held.notifyInFlight = value }
  private var pendingRespond: Promise?
    get() = Held.pendingRespond
    set(value) { Held.pendingRespond = value }
  private val notifyLock get() = Held.notifyLock

  /*
   * What the central last wrote to the Status CCCD. Read back by
   * onDescriptorReadRequest - a host that subscribes and then reads is
   * entitled to see what it wrote, and some check.
   */
  private var notificationsEnabled: Boolean
    get() = Held.notificationsEnabled
    set(value) { Held.notificationsEnabled = value }

  /** Latched by onServiceAdded; advertising waits for it. */
  private var serviceAdded: Boolean
    get() = Held.serviceAdded
    set(value) { Held.serviceAdded = value }

  /* The JVM names are set because the spec already owns getState(). */
  @get:JvmName("heldState")
  @set:JvmName("setHeldState")
  private var state: String
    get() = Held.state
    set(value) { Held.state = value }
  private var mtu: Int
    get() = Held.mtu
    set(value) { Held.mtu = value }
  private var config: AuthenticatorConfig
    get() = Held.config
    set(value) { Held.config = value }

  private data class AuthenticatorConfig(
    val displayName: String = "OnlyKey Mobile",
    val aaguid: String = "00000000000000000000000000000000",
    val requireUserVerification: Boolean = true,
    val preferStrongBox: Boolean = true,
  )

  // ---------------------------------------------------------------- lifecycle

  /*
   * DO NOT TAKE THE AUTHENTICATOR DOWN WITH THE JS BRIDGE.
   *
   * invalidate() fires whenever the React instance goes away - a Metro
   * reload, a Fast Refresh that cannot be applied incrementally, the activity
   * being destroyed, the app swiped out of recents. None of those mean the
   * phone stopped being a security key: the GATT server belongs to the
   * PROCESS, and FidoGattService is a CONNECTED_DEVICE foreground service
   * holding that process up precisely so it can outlive any particular mount.
   *
   * Tearing it down here made 0xFFFD vanish and reappear on every one of those
   * events, which is the exact thing the comment on configure() says Windows
   * punishes: it keeps a PnP node per service, stops trusting one that keeps
   * disappearing, and once that node is dead the WebAuthn stack no longer
   * enumerates this phone as a security key AT ALL - measured with the service
   * still answering over the air. That is why the browser offered no other
   * device to use while this screen cheerfully said "advertising", and why it
   * got worse the more the app was restarted rather than better.
   *
   * Nothing is leaked by staying up. configure() already ADOPTS a server that
   * is still good (`gattServer != null && serviceAdded`) and restarts only the
   * advertisement, so the next JS instance reattaches to the running one
   * instead of building a second. stopAdvertising() remains the one way to
   * actually stand the authenticator down, and that is a deliberate act.
   */
  override fun invalidate() {
    if (Held.live === this) Held.live = null
    super.invalidate()
  }

  override fun getState(): String = state

  override fun isSupported(promise: Promise) {
    try {
      val adapter = bluetoothManager?.adapter
      val supported = adapter != null &&
        adapter.isMultipleAdvertisementSupported &&
        adapter.bluetoothLeAdvertiser != null &&
        reactContext.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)
      promise.resolve(supported)
    } catch (e: Exception) {
      promise.reject(ERR_UNSUPPORTED, e.message ?: "isSupported failed", e)
    }
  }

  // -------------------------------------------------------------- permissions

  private fun requiredPermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      arrayOf(Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT)
    } else {
      arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

  private fun hasPermissions(): Boolean = requiredPermissions().all {
    ContextCompat.checkSelfPermission(reactContext, it) == PackageManager.PERMISSION_GRANTED
  }

  /*
   * Asked for alongside the required ones, never required: without it the
   * foreground service's notification is not shown (API 33+), but the
   * service still runs and the process is still protected. Requiring it
   * would let a denied notification prompt block the security key itself.
   */
  private fun wantedPermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      arrayOf(Manifest.permission.POST_NOTIFICATIONS)
    } else {
      emptyArray()
    }

  private fun hasWantedPermissions(): Boolean = wantedPermissions().all {
    ContextCompat.checkSelfPermission(reactContext, it) == PackageManager.PERMISSION_GRANTED
  }

  override fun requestPermissions(promise: Promise) {
    if (hasPermissions() && hasWantedPermissions()) {
      promise.resolve(true)
      return
    }
    val activity = reactApplicationContext.currentActivity as? PermissionAwareActivity
    if (activity == null) {
      promise.reject(ERR_PERMISSION, "No activity available to request permissions")
      return
    }
    /* One dialog for both lists; only the required ones decide the answer. */
    val required = requiredPermissions()
    activity.requestPermissions(
      required + wantedPermissions(),
      PERMISSION_REQUEST_CODE,
      PermissionListener { requestCode, _, grantResults ->
        if (requestCode == PERMISSION_REQUEST_CODE) {
          val granted = grantResults.size >= required.size &&
            grantResults.take(required.size).all { it == PackageManager.PERMISSION_GRANTED }
          promise.resolve(granted)
        }
        true
      },
    )
  }

  override fun permissionStatus(promise: Promise) {
    val map: WritableMap = Arguments.createMap()
    map.putBoolean("bluetooth", hasPermissions())
    map.putBoolean("notifications", hasWantedPermissions())
    map.putBoolean("notificationsApply", Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
    promise.resolve(map)
  }

  /*
   * Notifications alone, for the Settings screen: the first ask rides along
   * with the Bluetooth dialog, and a person who dismissed that one has no
   * other way back to it. Android shows the dialog at most twice per
   * permission; after "don't ask again" this resolves false without a
   * dialog, which is what openAppSettings() is for.
   */
  override fun requestNotificationPermission(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || hasWantedPermissions()) {
      promise.resolve(true)
      return
    }
    val activity = reactApplicationContext.currentActivity as? PermissionAwareActivity
    if (activity == null) {
      promise.reject(ERR_PERMISSION, "No activity available to request permissions")
      return
    }
    activity.requestPermissions(
      wantedPermissions(),
      NOTIFICATION_REQUEST_CODE,
      PermissionListener { requestCode, _, grantResults ->
        if (requestCode == NOTIFICATION_REQUEST_CODE) {
          promise.resolve(grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED })
        }
        true
      },
    )
  }

  override fun openAppSettings() {
    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
      .setData(Uri.fromParts("package", reactContext.packageName, null))
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    reactContext.startActivity(intent)
  }

  override fun configure(configMap: ReadableMap) {
    config = AuthenticatorConfig(
      displayName = configMap.getString("displayName") ?: config.displayName,
      aaguid = configMap.getString("aaguid") ?: config.aaguid,
      requireUserVerification = if (configMap.hasKey("requireUserVerification")) {
        configMap.getBoolean("requireUserVerification")
      } else {
        config.requireUserVerification
      },
      preferStrongBox = if (configMap.hasKey("preferStrongBox")) {
        configMap.getBoolean("preferStrongBox")
      } else {
        config.preferStrongBox
      },
    )
  }

  // --------------------------------------------------------------- gatt server

  @SuppressLint("MissingPermission")
  override fun startAdvertising(promise: Promise) {
    if (!hasPermissions()) {
      promise.reject(ERR_PERMISSION, "Bluetooth permissions not granted")
      return
    }
    val manager = bluetoothManager
    val adapter = manager?.adapter
    if (manager == null || adapter == null || !adapter.isEnabled) {
      promise.reject(ERR_UNSUPPORTED, "Bluetooth is off or unavailable")
      return
    }

    try {
      /*
       * DO NOT REBUILD A SERVER THAT IS ALREADY GOOD.
       *
       * This used to call stopEverything() unconditionally, so every press of
       * Start closed the GATT server and opened a new one - and a host watches
       * the service disappear and come back each time. Windows keeps a PnP
       * device node per service and stops trusting one that keeps vanishing:
       * the node for 0xFFFD goes to status Unknown, and once it does the
       * WebAuthn stack no longer enumerates the phone as a security key at
       * all. Measured - the service was still there over the air, all three
       * UUIDs answered on connect, and the node stayed dead regardless.
       *
       * So if the service is registered, only the advertisement is restarted.
       */
      /*
       * ...AND DO NOT ADOPT A SERVER THAT IS NO LONGER SERVING.
       *
       * The flag remembers that addService() once succeeded; it does not know
       * that the adapter has restarted since. Android drops an app's GATT
       * registration when Bluetooth bounces - a toggle, an unpair that
       * restarts the stack - and the remembered server object is then dead
       * while `serviceAdded` stays true. Adopting it restarted the ADVERTISER
       * (a fresh object, happy to comply) over a GATT table with no FIDO
       * service in it. Measured 2026-09-17 from the host: 0xFFFD in the
       * advertisement, absent from the live table with the cache bypassed,
       * and Windows' picker offering no security key. So the server is ASKED.
       */
      if (gattServer != null && serviceAdded && serviceIsLive()) {
        if (!beginAdvertising()) {
          throw IllegalStateException("startAdvertising was refused by the adapter")
        }
        setState(STATE_ADVERTISING, "service 0xFFFD")
        promise.resolve(null)
        return
      }

      rebuildAndAdvertise(manager, adapter)
      promise.resolve(null)
    } catch (e: Exception) {
      stopEverything()
      setState(STATE_ERROR, e.message ?: "startAdvertising failed")
      promise.reject(ERR_ADVERTISE, e.message ?: "startAdvertising failed", e)
    }
  }

  /**
   * Start (or restart) the advertisement. Separate from startAdvertising()
   * because it has to run again after every disconnect, without tearing down
   * the GATT server and its registered service.
   */

  /**
   * Whether the server we hold still has the FIDO service registered.
   *
   * `internal` so the watchdog can ask before deciding to leave things alone -
   * a connection to a server whose service the stack has dropped looks healthy
   * from every other angle and answers nothing.
   */
  internal fun serviceIsLive(): Boolean =
    runCatching { gattServer?.getService(FIDO_SERVICE_UUID) != null }.getOrDefault(false)

  /**
   * Tear down and bring up: open a server, register 0xFFFD, wait for it to
   * land, then advertise. Throws on any failure; the caller decides the state.
   * Shared by startAdvertising() and the watchdog, so a service the adapter
   * dropped comes back the same way it was first built.
   */
  @SuppressLint("MissingPermission")
  private fun rebuildAndAdvertise(manager: BluetoothManager, adapter: android.bluetooth.BluetoothAdapter) {
    try {
      stopEverything()

      val server = manager.openGattServer(reactContext, gattCallback)
        ?: throw IllegalStateException("openGattServer returned null")
      gattServer = server
      /* The process is now doing what the notification says; see FidoGattService. */
      FidoGattService.start(reactContext)

      /*
       * addService() is ASYNCHRONOUS - it completes at onServiceAdded() - and
       * advertising below can put us on the air before it lands. A central
       * that connects in that window enumerates a GATT table holding only the
       * mandatory 0x1800/0x1801, and hosts CACHE what they discover: Windows
       * materialises it as PnP device nodes and keeps serving that table on
       * every later connection, so one badly-timed connect poisons the pairing
       * until the device record is removed by hand.
       *
       * Measured at 29ms between the two on this handset - small, and not
       * zero. serviceAdded is latched by the callback below.
       */
      serviceAdded = false
      server.addService(buildFidoService())

      val leAdvertiser = adapter.bluetoothLeAdvertiser
        ?: throw IllegalStateException("This device cannot act as a BLE peripheral")
      advertiser = leAdvertiser

      // Registration takes a handful of milliseconds; the ceiling is generous
      // because being late here is invisible and being early poisons a cache.
      var waited = 0
      while (!serviceAdded && waited < SERVICE_ADD_TIMEOUT_MS) {
        Thread.sleep(SERVICE_ADD_POLL_MS.toLong())
        waited += SERVICE_ADD_POLL_MS
      }
      if (!serviceAdded) {
        throw IllegalStateException(
          "the FIDO service did not register within ${SERVICE_ADD_TIMEOUT_MS}ms",
        )
      }

      if (!beginAdvertising()) {
        throw IllegalStateException("startAdvertising was refused by the adapter")
      }
      setState(STATE_ADVERTISING, "service 0xFFFD")
    } catch (e: Exception) {
      throw e
    }
  }

  @SuppressLint("MissingPermission")
  private fun beginAdvertising(): Boolean {
    val leAdvertiser = advertiser ?: return false
    return try {
      // Stopping first is harmless when nothing is running, and avoids
      // ALREADY_STARTED on the paths where something is.
      try {
        leAdvertiser.stopAdvertising(advertiseCallback)
      } catch (_: Exception) {
      }
      Held.advertisingOn = false

      val settings = AdvertiseSettings.Builder()
        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
        .setConnectable(true)
        .setTimeout(0)
        .build()

      val data = AdvertiseData.Builder()
        .setIncludeDeviceName(true)
        .addServiceUuid(ParcelUuid(FIDO_SERVICE_UUID))
        .build()

      leAdvertiser.startAdvertising(settings, data, advertiseCallback)
      Held.wantAdvertising = true
      armWatchdog()
      true
    } catch (e: Exception) {
      false
    }
  }

  /*
   * THE RADIO IS ASKED, NOT TRUSTED.
   *
   * A legacy connectable advertisement is stopped BY THE CONTROLLER the moment
   * a central connects - and not every connection reaches this GATT server's
   * callbacks. Windows pairs through a connection the STACK makes for SMP, so
   * onConnectionStateChange never fires here, the advertisement dies with that
   * link, and this module goes on reporting "advertising" for an authenticator
   * that is no longer on the air. Measured 2026-09-17: the screen said
   * advertising, the stack listed no advertisement from com.okrn, no
   * onStartFailure had fired, and Windows could not connect - right after the
   * first pairing that had produced a proper LE key.
   *
   * So while advertising is WANTED and nothing is connected, it is re-issued on
   * a short cadence. beginAdvertising() stops first, so re-issuing over a live
   * advertisement is a brief blink rather than ALREADY_STARTED; a controller
   * that silently dropped it simply gets it back within a few seconds. The
   * ACL-disconnect broadcast makes the common case immediate instead of
   * waiting for the next tick.
   *
   * Armed once per process, on the process-owned handler, so it outlives the
   * module instance like everything else the authenticator depends on.
   */
  /**
   * Put the authenticator back the way it is supposed to be: the service
   * served, the advertisement on the air. Cheap when both already hold - a
   * brief blink of the advertisement - and a full rebuild when the adapter
   * has dropped the service under us.
   */
  @SuppressLint("MissingPermission")
  private fun reassert() {
    val manager = bluetoothManager ?: return
    val adapter = manager.adapter ?: return
    if (!adapter.isEnabled || !hasPermissions()) return
    try {
      if (gattServer != null && serviceAdded && serviceIsLive()) {
        /*
         * PASSIVE. beginAdvertising() stops before it starts, and calling it
         * on every tick blinked the advertisement every six seconds - a host
         * mid-connect had it pulled away, over and over (measured: start/stop
         * pairs at :34, :40, :46, :52). So a healthy advertisement is left
         * alone; only one the controller has stopped is re-armed.
         */
        if (!Held.advertisingOn) beginAdvertising()
      } else {
        rebuildAndAdvertise(manager, adapter)
      }
    } catch (e: Exception) {
      setState(STATE_ERROR, e.message ?: "could not restore the authenticator")
    }
  }

  private fun armWatchdog() {
    /*
     * OFF, DELIBERATELY, UNTIL A REAL CEREMONY SAYS OTHERWISE.
     *
     * Written to re-arm an advertisement the controller had stopped, and it
     * cannot be verified from this machine at all: Windows reserves GATT
     * 0xFFFD for its own WebAuthn stack and refuses every script
     * (FINDING-windows-reserves-the-fido-service.md), so the only test is a
     * browser doing a real ceremony. Untestable code that RESTARTS the
     * advertisement is the wrong thing to have running underneath that test -
     * an early version blinked it every six seconds, and a restart mid-
     * ceremony ends the ceremony. The service already survives a JS reload by
     * living in Held; this was belt and braces, and the braces were unproven.
     */
    if (WATCHDOG_ENABLED.not()) return
    if (Held.watchdogArmed) return
    Held.watchdogArmed = true
    val tick = object : Runnable {
      override fun run() {
        try {
          /*
           * A CONNECTION IS NOT PROOF THE SERVICE IS STILL THERE.
           *
           * This used to check `connectedDevice == null` alone, so a host that
           * held an LE link kept the watchdog quiet - even when the stack had
           * dropped the GATT registration underneath it. Re-pairing does
           * exactly that: the bond change bounces the stack, Android drops the
           * service, and the link survives. Every local signal then agrees the
           * authenticator is fine - the screen says advertising, a device is
           * connected - and WebAuthn cannot register, because the host is
           * talking to a server with nothing registered on it.
           *
           * Measured on 2026-09-18: after re-pairing, a ceremony failed until
           * the app's Bluetooth was toggled off and on by hand, which is just
           * rebuildAndAdvertise() reached the long way round.
           *
           * serviceIsLive() reads the server we hold, so a ceremony in flight
           * answers true and is left alone; only a server the stack has
           * emptied is rebuilt. reassert() is already passive when things are
           * healthy.
           */
          if (Held.wantAdvertising &&
            (Held.connectedDevice == null || Held.live?.serviceIsLive() == false)
          ) {
            Held.live?.reassert()
          }
        } catch (_: Exception) {
        }
        Held.main.postDelayed(this, WATCHDOG_MS)
      }
    }
    Held.main.postDelayed(tick, WATCHDOG_MS)
    try {
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
          val action = intent.action
          /*
           * LE TRANSPORT ONLY. A classic ACL is not our link: a phone bonded
           * to a laptop keeps trying to be its headset, fails every few
           * seconds, and each attempt bounces the BR/EDR ACL. Treating those
           * as "our advertisement was stopped" restarted it on the same
           * cadence - measured as start/stop pairs six seconds apart, in step
           * with HEADSET/A2DP CONNECTING -> DISCONNECTED in the stack log -
           * which is precisely the blink this watchdog exists to prevent.
           */
          val isAcl = action == BluetoothDevice.ACTION_ACL_CONNECTED ||
            action == BluetoothDevice.ACTION_ACL_DISCONNECTED
          if (isAcl) {
            val transport = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
              intent.getIntExtra(BluetoothDevice.EXTRA_TRANSPORT, BluetoothDevice.TRANSPORT_AUTO)
            } else {
              BluetoothDevice.TRANSPORT_AUTO
            }
            if (transport != BluetoothDevice.TRANSPORT_LE) return
          }
          if (action == BluetoothDevice.ACTION_ACL_CONNECTED) {
            /* Legacy advertising stops on an LE connect, whoever made it. */
            Held.advertisingOn = false
            return
          }
          val adapterOn = action == android.bluetooth.BluetoothAdapter.ACTION_STATE_CHANGED &&
            intent.getIntExtra(android.bluetooth.BluetoothAdapter.EXTRA_STATE, -1) ==
              android.bluetooth.BluetoothAdapter.STATE_ON
          if ((action == BluetoothDevice.ACTION_ACL_DISCONNECTED || adapterOn) &&
              Held.wantAdvertising && Held.connectedDevice == null) {
            Held.live?.reassert()
          }
        }
      }
      val app = reactContext.applicationContext
      val filter = IntentFilter(BluetoothDevice.ACTION_ACL_DISCONNECTED).apply {
        addAction(BluetoothDevice.ACTION_ACL_CONNECTED)
        addAction(android.bluetooth.BluetoothAdapter.ACTION_STATE_CHANGED)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        app.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
      } else {
        @Suppress("UnspecifiedRegisterReceiverFlag")
        app.registerReceiver(receiver, filter)
      }
    } catch (_: Exception) {
      // The tick alone is enough; the broadcast only makes recovery faster.
    }
  }

  override fun stopAdvertising(promise: Promise) {
    try {
      stopEverything()
      setState(STATE_STOPPED, "stopped by app")
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject(ERR_ADVERTISE, e.message ?: "stopAdvertising failed", e)
    }
  }

  @SuppressLint("MissingPermission")
  private fun stopEverything() {
    Held.wantAdvertising = false
    Held.advertisingOn = false
    try {
      advertiser?.stopAdvertising(advertiseCallback)
    } catch (_: Exception) {
      // Advertiser may already be torn down.
    }
    try {
      gattServer?.close()
    } catch (_: Exception) {
      // Server may already be closed.
    }
    advertiser = null
    gattServer = null
    statusCharacteristic = null
    connectedDevice = null
    assembler.reset()
    /* No server, no foreground: the notification goes with it. */
    FidoGattService.stop(reactContext)
    pendingRequests.clear()
    clearNotifications("GATT server stopped")
    mtu = DEFAULT_MTU
  }

  private fun buildFidoService(): BluetoothGattService {
    val service = BluetoothGattService(FIDO_SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)

    /*
     * Control Point: the host writes CTAP commands here.
     *
     * PERMISSION_WRITE_ENCRYPTED, not PERMISSION_WRITE. CTAP 2.1 section
     * 11.2.7 requires the FIDO service to be reachable only over an encrypted
     * link, and real hosts enforce it - a Windows or macOS browser pairs
     * before it will send a command, and a control point that accepts plain
     * writes is either refused or, worse, carries a credential ceremony over
     * an unencrypted link that anything nearby can read.
     *
     * Declaring it here is what makes Android demand pairing at the moment of
     * the first write, rather than leaving the app to ask for a bond it has no
     * good moment to ask for.
     */
    service.addCharacteristic(
      BluetoothGattCharacteristic(
        FIDO_CONTROL_POINT_UUID,
        BluetoothGattCharacteristic.PROPERTY_WRITE,
        BluetoothGattCharacteristic.PERMISSION_WRITE_ENCRYPTED,
      ),
    )

    // Status: notifications carry the response back to the host.
    val status = BluetoothGattCharacteristic(
      FIDO_STATUS_UUID,
      BluetoothGattCharacteristic.PROPERTY_NOTIFY,
      BluetoothGattCharacteristic.PERMISSION_READ,
    )
    status.addDescriptor(
      BluetoothGattDescriptor(
        CLIENT_CHARACTERISTIC_CONFIG_UUID,
        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
      ),
    )
    service.addCharacteristic(status)
    statusCharacteristic = status

    // Control Point Length: how large a single Control Point write may be.
    val cpLength = BluetoothGattCharacteristic(
      FIDO_CONTROL_POINT_LENGTH_UUID,
      BluetoothGattCharacteristic.PROPERTY_READ,
      BluetoothGattCharacteristic.PERMISSION_READ,
    )
    service.addCharacteristic(cpLength)

    /*
     * Service Revision Bitfield: 0x20 advertises FIDO2 / CTAP2 support.
     *
     * Read AND write. CTAP 2.1 11.2.5.4 has the client write back the one
     * version bit it selected, so a read-only characteristic answers that with
     * WRITE_NOT_PERMITTED - which a strict host treats as a broken service
     * rather than as a version it can still use.
     */
    val revision = BluetoothGattCharacteristic(
      FIDO_SERVICE_REVISION_UUID,
      BluetoothGattCharacteristic.PROPERTY_READ or BluetoothGattCharacteristic.PROPERTY_WRITE,
      BluetoothGattCharacteristic.PERMISSION_READ or BluetoothGattCharacteristic.PERMISSION_WRITE,
    )
    service.addCharacteristic(revision)

    return service
  }

  private val advertiseCallback get() = Held.advertiseCallback

  @SuppressLint("MissingPermission")
  private val gattCallback = object : BluetoothGattServerCallback() {

    override fun onServiceAdded(status: Int, service: BluetoothGattService) {
      serviceAdded = status == BluetoothGatt.GATT_SUCCESS
      if (!serviceAdded) {
        setState(STATE_ERROR, "the FIDO service was rejected with status $status")
      }
    }

    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      if (newState == BluetoothGatt.STATE_CONNECTED) {
        Held.advertisingOn = false
        connectedDevice = device
        setState(STATE_CONNECTED, "central connected")
      } else {
        connectedDevice = null
        notificationsEnabled = false
        assembler.reset()
        clearNotifications("The central disconnected")
        /*
         * Android STOPS ADVERTISING when a central connects, and does not
         * resume on disconnect. This used to set the state back to
         * 'advertising' and stop there - so the phone reported itself
         * discoverable while being invisible, and the only way back was to
         * toggle the screen's switch off and on.
         */
        if (gattServer != null && beginAdvertising()) {
          setState(STATE_ADVERTISING, "central disconnected - advertising again")
        } else {
          setState(if (gattServer != null) STATE_ERROR else STATE_STOPPED, "central disconnected")
        }
      }
    }

    /**
     * The stack has delivered the previous fragment; send the next.
     *
     * This override is the whole fix. Without it nothing paces the queue, and
     * Android's one-outstanding-notification rule silently discards every
     * fragment after the first.
     */
    override fun onNotificationSent(device: BluetoothDevice, status: Int) {
      synchronized(notifyLock) { notifyInFlight = false }
      if (status != BluetoothGatt.GATT_SUCCESS) {
        clearNotifications("Notification failed with status $status")
        return
      }
      pumpNotifications()
    }

    override fun onMtuChanged(device: BluetoothDevice, newMtu: Int) {
      mtu = newMtu
      setState(state, "MTU negotiated to $newMtu")
    }

    override fun onCharacteristicReadRequest(
      device: BluetoothDevice,
      requestId: Int,
      offset: Int,
      characteristic: BluetoothGattCharacteristic,
    ) {
      /*
       * Logged because a host that rejects a value RETRIES rather than
       * complaining, and a silent retry loop is indistinguishable from a host
       * that has lost interest. Knowing which characteristic it keeps asking
       * for is the whole diagnosis.
       */
      Log.d(TAG, "read request: ${characteristic.uuid}")

      val value = when (characteristic.uuid) {
        // Max Control Point write, big-endian, capped to the negotiated MTU.
        FIDO_CONTROL_POINT_LENGTH_UUID -> {
          val len = maxFragmentSize()
          byteArrayOf(((len shr 8) and 0xff).toByte(), (len and 0xff).toByte())
        }
        // Bit 5 set = FIDO2 (CTAP2) supported.
        FIDO_SERVICE_REVISION_UUID -> byteArrayOf(0x20)
        else -> ByteArray(0)
      }
      gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
    }

    /**
     * Answer a descriptor read. Without this, discovery hangs forever.
     *
     * BluetoothGattServerCallback's default implementation of this method does
     * NOTHING - it does not respond - and ATT permits exactly one outstanding
     * request per connection. So a central that reads the Status CCCD while
     * enumerating the service (Windows does, as the third request after the
     * MTU exchange) waits for a response that is never sent, and every request
     * behind it queues behind that one.
     *
     * From the outside this is indistinguishable from a device that connected
     * and died: the link is up, the MTU is negotiated, and service discovery
     * simply never returns. Measured against Windows - MTU 517 agreed, two
     * characteristic reads answered, then req_type=2 and thirty seconds of
     * silence to the disconnect.
     */
    override fun onDescriptorReadRequest(
      device: BluetoothDevice,
      requestId: Int,
      offset: Int,
      descriptor: BluetoothGattDescriptor,
    ) {
      val value = if (descriptor.uuid == CLIENT_CHARACTERISTIC_CONFIG_UUID) {
        if (notificationsEnabled) {
          BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        } else {
          BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
        }
      } else {
        ByteArray(0)
      }
      gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
    }

    override fun onDescriptorWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray,
    ) {
      if (descriptor.uuid == CLIENT_CHARACTERISTIC_CONFIG_UUID) {
        notificationsEnabled =
          value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
      }
      if (responseNeeded) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
      }
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray,
    ) {
      /*
       * Logged before anything else decides what to do with it. A write that
       * is quietly filtered out looks exactly like a write that never arrived,
       * and the host retries either way.
       */
      Log.d(
        TAG,
        "write: ${characteristic.uuid} len=${value.size} offset=$offset " +
          "prepared=$preparedWrite bytes=${value.take(12).joinToString("") {
            "%02x".format(it)
          }}",
      )

      if (responseNeeded) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
      }

      /*
       * The Service Revision Bitfield is writable, and the write is how the
       * client SELECTS a version (CTAP 2.1 11.2.5.4) - it writes back the
       * single bit it chose. There is nothing to act on with one version on
       * offer, but it must be accepted: answering an attempt with
       * WRITE_NOT_PERMITTED is grounds for a host to abandon the service.
       */
      if (characteristic.uuid == FIDO_SERVICE_REVISION_UUID) {
        return
      }

      if (characteristic.uuid != FIDO_CONTROL_POINT_UUID) {
        return
      }

      val message = assembler.push(value)
      if (message == null) {
        Log.d(TAG, "control point: fragment held, message incomplete")
        return
      }
      Log.d(TAG, "control point: message cmd=0x${"%02x".format(message.command)} " +
        "len=${message.payload.size}")
      val id = "req-" + requestCounter.incrementAndGet()
      pendingRequests[id] = message.command

      // The CTAP2 command byte leads the payload; the rest is CBOR.
      val ctap2Command = message.payload.firstOrNull()?.toInt()?.and(0xff) ?: -1

      val event = Arguments.createMap()
      event.putString("requestId", id)
      event.putInt("command", message.command)
      event.putString(
        "commandName",
        if (message.command == CtapBle.CMD_MSG && ctap2Command >= 0) {
          CtapBle.ctap2CommandName(ctap2Command)
        } else {
          ""
        },
      )
      event.putString("hex", message.payload.toHexString())
      // Extracting rpId needs a CBOR decoder, which is not wired up yet.
      event.putString("rpId", "")
      emit(event, isStatus = false)
    }
  }

  /**
   * The most this authenticator will accept in one Control Point write.
   *
   * CLAMPED TO 512, WHICH IS THE SPEC'S CEILING. CTAP 2.1 11.2.5.2 says
   * fidoControlPointLength "shall be between 20 and 512" - and an MTU of 517,
   * which is what a modern host negotiates, gives 514 without the clamp.
   *
   * Windows reads this characteristic, finds the value out of range, and
   * REREADS IT rather than failing: a read every 600ms, forever, with no write
   * ever following. From the phone it looks like a host that connected and
   * then did nothing; from the browser it looks like the key never responded.
   */
  private fun maxFragmentSize(): Int =
    (mtu - ATT_HEADER_BYTES).coerceIn(MIN_FRAGMENT, MAX_FRAGMENT)

  // ------------------------------------------------------------------ respond

  @SuppressLint("MissingPermission")
  override fun respondToRequest(requestId: String, hex: String, promise: Promise) {
    try {
      val command = pendingRequests.remove(requestId)
        ?: throw IllegalStateException("Unknown or already-answered requestId: $requestId")
      val device = connectedDevice
        ?: throw IllegalStateException("No connected central to respond to")
      val status = statusCharacteristic
        ?: throw IllegalStateException("Status characteristic is not registered")
      val server = gattServer
        ?: throw IllegalStateException("GATT server is not running")

      val payload = hex.hexToByteArray()
      val fragments = CtapBle.fragment(command, payload, maxFragmentSize())

      // Queued, not looped. The promise resolves when the LAST fragment has
      // been acknowledged, so JS learns the response actually went out rather
      // than that it was handed to a queue.
      enqueueNotifications(fragments, promise)
    } catch (e: Exception) {
      promise.reject(ERR_RESPOND, e.message ?: "respondToRequest failed", e)
    }
  }

  /**
   * Relay a KEEPALIVE to the host while the authenticator waits.
   *
   * Not the same thing as a response: the request stays pending, because the
   * real answer is still to come. The firmware sends one keepalive when its
   * status changes and then goes quiet for up to nineteen seconds waiting for
   * a finger (device.cpp:172, ctap.h:173) - a host hearing nothing for that
   * long abandons a ceremony the user is midway through confirming.
   */
  @SuppressLint("MissingPermission")
  override fun sendKeepAlive(requestId: String, status: Double, promise: Promise) {
    try {
      if (!pendingRequests.containsKey(requestId)) {
        throw IllegalStateException("Unknown or already-answered requestId: $requestId")
      }
      connectedDevice ?: throw IllegalStateException("No connected central to notify")
      statusCharacteristic ?: throw IllegalStateException("Status characteristic is not registered")
      gattServer ?: throw IllegalStateException("GATT server is not running")

      val fragments = CtapBle.fragment(
        CtapBle.CMD_KEEPALIVE,
        byteArrayOf(status.toInt().toByte()),
        maxFragmentSize(),
      )
      enqueueNotifications(fragments, promise)
    } catch (e: Exception) {
      promise.reject(ERR_RESPOND, e.message ?: "sendKeepAlive failed", e)
    }
  }

  // ------------------------------------------------------- notification queue

  private fun enqueueNotifications(fragments: List<ByteArray>, promise: Promise) {
    synchronized(notifyLock) {
      /*
       * One outstanding response at a time. Two overlapping ones would
       * interleave their fragments on the wire, and the host reassembles by
       * position - so it would decode a message made of halves of two.
       */
      if (pendingRespond != null) {
        promise.reject(ERR_RESPOND, "A response is still being sent")
        return
      }
      pendingRespond = promise
      notifyQueue.addAll(fragments)
    }
    pumpNotifications()
  }

  /** Send the next fragment, if the stack is ready for one. */
  @SuppressLint("MissingPermission")
  private fun pumpNotifications() {
    val fragment: ByteArray
    val device: BluetoothDevice
    val characteristic: BluetoothGattCharacteristic
    val server: BluetoothGattServer

    synchronized(notifyLock) {
      if (notifyInFlight) return
      if (notifyQueue.isEmpty()) {
        // Drained: the whole response is on the wire.
        pendingRespond?.resolve(null)
        pendingRespond = null
        return
      }
      device = connectedDevice ?: run {
        clearNotifications("The central disconnected mid-response")
        return
      }
      characteristic = statusCharacteristic ?: run {
        clearNotifications("Status characteristic is not registered")
        return
      }
      server = gattServer ?: run {
        clearNotifications("GATT server is not running")
        return
      }
      fragment = notifyQueue.removeFirst()
      notifyInFlight = true
    }

    /*
     * Outside the lock: this call reaches into the Bluetooth stack, and on
     * some builds it can complete - and call onNotificationSent - before it
     * returns. Holding the lock across it would deadlock against the very
     * callback that is supposed to release it.
     */
    val ok = try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        server.notifyCharacteristicChanged(device, characteristic, false, fragment) ==
          BluetoothStatusCodes.SUCCESS
      } else {
        @Suppress("DEPRECATION")
        characteristic.value = fragment
        @Suppress("DEPRECATION")
        server.notifyCharacteristicChanged(device, characteristic, false)
      }
    } catch (e: Exception) {
      false
    }

    if (!ok) {
      /*
       * The stack refused it outright - a full queue, or a link that has just
       * dropped. onNotificationSent will not fire, so nothing would ever
       * resolve the promise if this were ignored.
       */
      synchronized(notifyLock) { notifyInFlight = false }
      clearNotifications("The Bluetooth stack rejected a notification")
    }
  }

  /**
   * Abandon whatever is queued and tell JS why.
   *
   * Rejecting matters as much as clearing: respondToRequest() resolves only
   * when the last fragment is acknowledged, so a queue dropped without a
   * rejection leaves that promise pending forever and the JS bridge waits on a
   * response it will never finish sending.
   */
  private fun clearNotifications(reason: String) {
    val promise: Promise?
    synchronized(notifyLock) {
      notifyQueue.clear()
      notifyInFlight = false
      promise = pendingRespond
      pendingRespond = null
    }
    promise?.reject(ERR_RESPOND, reason)
  }

  // ------------------------------------------------------------- key material

  /* ---- the gated KeyStore credential path ------------------------------ */

  /**
   * Whether the phone-side credential functions may be used at all.
   *
   * FALSE, and that is the point. These belong to an abandoned design in which
   * the phone was the authenticator; today the firmware is, and nothing calls
   * them. They are kept because older firmware may not answer over the BLE
   * path, and if it does not, a phone-side credential is the obvious fallback -
   * a question the firmware version matrix will settle.
   *
   * The gate means the dead path cannot be reached by accident, and that
   * anyone who wants it has to turn it on deliberately and say why. Deleting
   * the code would answer the question by forgetting it.
   */
  private val UNUSED_KEYSTORE_CREDENTIALS = false

  private fun refuseGated(name: String, promise: Promise) {
    promise.reject(
      ERR_KEYSTORE,
      "$name belongs to the phone-as-authenticator design, which this app does " +
        "not use - the firmware is the authenticator. It is kept, disabled, " +
        "until the firmware version matrix shows whether older firmware needs " +
        "a fallback. See the header of this file.",
    )
  }

  /**
   * Generates a P-256 credential key inside the TEE (or StrongBox when the
   * device has a dedicated secure element). The private key never enters app
   * memory - only a KeyStore handle to it does.
   *
   * GATED - see UNUSED_KEYSTORE_CREDENTIALS.
   */
  override fun createCredential(rpId: String, userHandleHex: String, promise: Promise) {
    if (!UNUSED_KEYSTORE_CREDENTIALS) {
      refuseGated("createCredential", promise)
      return
    }
    try {
      val alias = credentialAlias(rpId, userHandleHex)
      val generator = KeyPairGenerator.getInstance(
        KeyProperties.KEY_ALGORITHM_EC,
        ANDROID_KEYSTORE,
      )

      val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_SHA256)
        .apply {
          if (config.requireUserVerification) {
            setUserAuthenticationRequired(true)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
              setUserAuthenticationParameters(
                USER_AUTH_VALIDITY_SECONDS,
                KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
              )
            } else {
              @Suppress("DEPRECATION")
              setUserAuthenticationValidityDurationSeconds(USER_AUTH_VALIDITY_SECONDS)
            }
          }
          if (config.preferStrongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            setIsStrongBoxBacked(true)
          }
        }
        .build()

      try {
        generator.initialize(spec)
        generator.generateKeyPair()
      } catch (e: Exception) {
        // StrongBox is absent on most phones; fall back to the TEE rather than
        // failing registration outright.
        if (config.preferStrongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          val fallback = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .apply {
              if (config.requireUserVerification) {
                setUserAuthenticationRequired(true)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                  setUserAuthenticationParameters(
                    USER_AUTH_VALIDITY_SECONDS,
                    KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
                  )
                }
              }
            }
            .build()
          generator.initialize(fallback)
          generator.generateKeyPair()
        } else {
          throw e
        }
      }

      promise.resolve(alias.toByteArray(Charsets.UTF_8).toHexString())
    } catch (e: Exception) {
      promise.reject(ERR_KEYSTORE, e.message ?: "createCredential failed", e)
    }
  }

  /** GATED - see UNUSED_KEYSTORE_CREDENTIALS. */
  override fun signWithCredential(credentialIdHex: String, payloadHex: String, promise: Promise) {
    if (!UNUSED_KEYSTORE_CREDENTIALS) {
      refuseGated("signWithCredential", promise)
      return
    }
    try {
      val alias = String(credentialIdHex.hexToByteArray(), Charsets.UTF_8)
      val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
      val key = keyStore.getKey(alias, null) as? PrivateKey
        ?: throw IllegalStateException("No credential key for alias $alias")

      // With setUserAuthenticationRequired(true) this throws
      // UserNotAuthenticatedException until a BiometricPrompt has unlocked the
      // key. Wiring that prompt to this signature is the remaining work.
      val signature = Signature.getInstance("SHA256withECDSA")
      signature.initSign(key)
      signature.update(payloadHex.hexToByteArray())
      promise.resolve(signature.sign().toHexString())
    } catch (e: Exception) {
      promise.reject(ERR_KEYSTORE, e.message ?: "signWithCredential failed", e)
    }
  }

  private fun credentialAlias(rpId: String, userHandleHex: String): String =
    "okrn-cred-" + rpId.replace(Regex("[^A-Za-z0-9._-]"), "_") + "-" + userHandleHex.take(32)

  // ------------------------------------------------------------------- events

  private fun setState(next: String, message: String) {
    state = next
    val event = Arguments.createMap()
    event.putString("state", next)
    event.putString("message", message)
    event.putInt("mtu", mtu)
    emit(event, isStatus = true)
  }

  private fun emit(map: WritableMap, isStatus: Boolean) {
    /*
     * Route to the LIVE instance, not `this`. The GATT callback that raised
     * this event may belong to an instance whose bridge is long gone - the
     * server outlives the module on purpose - and the JS that needs to hear
     * about the request is attached to the newest one.
     */
    val sink = Held.live ?: this
    // Events raised before JS subscribes (or after teardown) have no listener;
    // dropping them is correct.
    try {
      if (isStatus) sink.emitOnGattStatus(map) else sink.emitOnCtapRequest(map)
    } catch (_: Exception) {
      // No JS listener attached.
    }
  }

  companion object {
    /*
     * THE AUTHENTICATOR IS OWNED BY THE PROCESS.
     *
     * One holder, for the life of the process, no matter how many module
     * instances React builds and discards over it. FidoGattService keeps the
     * process alive as a CONNECTED_DEVICE foreground service so this can be
     * true; the instance-level accessors above make the rest of the file
     * unaware of it. See the comment on invalidate() for what it cost when
     * the server was torn down with every bridge instead.
     */
    private object Held {
      @Volatile var live: NativeFidoGattModule? = null
      /** True from a successful start until stopAdvertising: what SHOULD be true. */
      @Volatile var wantAdvertising = false
      /** What IS true: set by onStartSuccess, cleared when the controller stops it. */
      @Volatile var advertisingOn = false
      /*
       * The callback belongs to the PROCESS, not the instance: stopAdvertising()
       * only stops the set that was started with the same callback object, so
       * a per-instance callback let every new module instance start a second
       * set it could not stop. Measured: two ongoing advertisements from
       * com.okrn after one reload.
       */
      val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
          advertisingOn = true
        }
        override fun onStartFailure(errorCode: Int) {
          advertisingOn = false
          live?.setState(STATE_ERROR, "advertising failed with code $errorCode")
        }
      }
      /** Armed once per process; see armWatchdog(). */
      @Volatile var watchdogArmed = false
      val main = Handler(Looper.getMainLooper())
      var gattServer: BluetoothGattServer? = null
      var advertiser: BluetoothLeAdvertiser? = null
      var statusCharacteristic: BluetoothGattCharacteristic? = null
      var connectedDevice: BluetoothDevice? = null
      val assembler = CtapBleAssembler()
      val pendingRequests = ConcurrentHashMap<String, Int>()
      val requestCounter = AtomicInteger(0)
      val notifyQueue = ArrayDeque<ByteArray>()
      var notifyInFlight = false
      var pendingRespond: Promise? = null
      val notifyLock = Any()
      @Volatile var notificationsEnabled = false
      @Volatile var serviceAdded = false
      @Volatile var state: String = STATE_IDLE
      @Volatile var mtu: Int = DEFAULT_MTU
      @Volatile var config = AuthenticatorConfig()
    }

    /** FIDO Bluetooth Service, 16-bit UUID 0xFFFD in the Bluetooth base range. */
    private val FIDO_SERVICE_UUID: UUID = UUID.fromString("0000fffd-0000-1000-8000-00805f9b34fb")
    private val FIDO_CONTROL_POINT_UUID: UUID = UUID.fromString("f1d0fff1-deaa-ecee-b42f-c9ba7ed623bb")
    private val FIDO_STATUS_UUID: UUID = UUID.fromString("f1d0fff2-deaa-ecee-b42f-c9ba7ed623bb")
    private val FIDO_CONTROL_POINT_LENGTH_UUID: UUID = UUID.fromString("f1d0fff3-deaa-ecee-b42f-c9ba7ed623bb")
    private val FIDO_SERVICE_REVISION_UUID: UUID = UUID.fromString("f1d0fff4-deaa-ecee-b42f-c9ba7ed623bb")
    private val CLIENT_CHARACTERISTIC_CONFIG_UUID: UUID =
      UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    /** How often the watchdog re-asks the radio. Short enough that a host retrying sees us. */
    /*
     * ON, and earned it. Switched off once on the theory that untestable code
     * restarting the advertisement was the regression; the phone then proved
     * why it exists. At 21:20 on 2026-09-17 the Bluetooth stack restarted,
     * Android dropped this app's GATT service registration with it, and the
     * authenticator stayed down - 0xFFFD served nowhere, nothing advertising -
     * while the screen still read "advertising" and Windows' WebAuthn dialog
     * sat waiting for a key that was no longer on the air.
     *
     * The blinking that made it look harmful was the FIRST version, which
     * re-issued the advertisement every tick; this one only acts when the
     * advertisement is not on the air or the service is gone.
     */
    private const val WATCHDOG_ENABLED = true
    private const val WATCHDOG_MS = 6_000L

    const val STATE_IDLE = "idle"
    const val STATE_ADVERTISING = "advertising"
    const val STATE_CONNECTED = "connected"
    const val STATE_STOPPED = "stopped"
    const val STATE_ERROR = "error"

    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val DEFAULT_MTU = 23
    private const val ATT_HEADER_BYTES = 3
    private const val MIN_FRAGMENT = 20

    /** CTAP 2.1 11.2.5.2: fidoControlPointLength shall be 20..512. */
    private const val MAX_FRAGMENT = 512
    private const val USER_AUTH_VALIDITY_SECONDS = 30
    private const val TAG = "FidoGatt"
    private const val SERVICE_ADD_TIMEOUT_MS = 2000
    private const val SERVICE_ADD_POLL_MS = 10
    private const val PERMISSION_REQUEST_CODE = 0
    private const val NOTIFICATION_REQUEST_CODE = 0xF1D1

    private const val ERR_UNSUPPORTED = "ERR_BLE_UNSUPPORTED"
    private const val ERR_PERMISSION = "ERR_BLE_PERMISSION"
    private const val ERR_ADVERTISE = "ERR_BLE_ADVERTISE"
    private const val ERR_RESPOND = "ERR_CTAP_RESPOND"
    private const val ERR_KEYSTORE = "ERR_KEYSTORE"
  }
}

private val HEX = "0123456789abcdef".toCharArray()

internal fun ByteArray.toHexString(): String {
  val out = CharArray(size * 2)
  for (i in indices) {
    val v = this[i].toInt() and 0xff
    out[i * 2] = HEX[v ushr 4]
    out[i * 2 + 1] = HEX[v and 0x0f]
  }
  return String(out)
}

internal fun String.hexToByteArray(): ByteArray {
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
