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
 * SCAFFOLD STATUS
 *   Implemented: GATT server, service/characteristic layout, advertising, MTU
 *   negotiation, BLE fragmentation/reassembly, and hardware-backed P-256 key
 *   generation and signing via the Android KeyStore.
 *
 *   Not implemented: the CTAP2 command handlers themselves. Reassembled
 *   commands are forwarded to JS as onCtapRequest events and JS supplies the
 *   response bytes, so the CBOR encoding of makeCredential / getAssertion and
 *   the BiometricPrompt gate are still to be built.
 */
@ReactModule(name = NativeFidoGattSpec.NAME)
class NativeFidoGattModule(
  private val reactContext: ReactApplicationContext,
) : NativeFidoGattSpec(reactContext) {

  private val bluetoothManager: BluetoothManager? =
    reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

  private var gattServer: BluetoothGattServer? = null
  private var advertiser: BluetoothLeAdvertiser? = null
  private var statusCharacteristic: BluetoothGattCharacteristic? = null
  private var connectedDevice: BluetoothDevice? = null

  private val assembler = CtapBleAssembler()
  private val pendingRequests = ConcurrentHashMap<String, Int>()
  private val requestCounter = AtomicInteger(0)

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
  private val notifyQueue = ArrayDeque<ByteArray>()
  private var notifyInFlight = false
  private var pendingRespond: Promise? = null
  private val notifyLock = Any()

  /*
   * What the central last wrote to the Status CCCD. Read back by
   * onDescriptorReadRequest - a host that subscribes and then reads is
   * entitled to see what it wrote, and some check.
   */
  @Volatile private var notificationsEnabled = false

  /** Latched by onServiceAdded; advertising waits for it. */
  @Volatile private var serviceAdded = false

  @Volatile private var state: String = STATE_IDLE
  @Volatile private var mtu: Int = DEFAULT_MTU
  @Volatile private var config = AuthenticatorConfig()

  private data class AuthenticatorConfig(
    val displayName: String = "OnlyKey Mobile",
    val aaguid: String = "00000000000000000000000000000000",
    val requireUserVerification: Boolean = true,
    val preferStrongBox: Boolean = true,
  )

  // ---------------------------------------------------------------- lifecycle

  override fun invalidate() {
    stopEverything()
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

  override fun requestPermissions(promise: Promise) {
    if (hasPermissions()) {
      promise.resolve(true)
      return
    }
    val activity = reactApplicationContext.currentActivity as? PermissionAwareActivity
    if (activity == null) {
      promise.reject(ERR_PERMISSION, "No activity available to request permissions")
      return
    }
    activity.requestPermissions(
      requiredPermissions(),
      PERMISSION_REQUEST_CODE,
      PermissionListener { requestCode, _, grantResults ->
        if (requestCode == PERMISSION_REQUEST_CODE) {
          val granted = grantResults.isNotEmpty() &&
            grantResults.all { it == PackageManager.PERMISSION_GRANTED }
          promise.resolve(granted)
        }
        true
      },
    )
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
      if (gattServer != null && serviceAdded) {
        if (!beginAdvertising()) {
          throw IllegalStateException("startAdvertising was refused by the adapter")
        }
        setState(STATE_ADVERTISING, "service 0xFFFD")
        promise.resolve(null)
        return
      }

      stopEverything()

      val server = manager.openGattServer(reactContext, gattCallback)
        ?: throw IllegalStateException("openGattServer returned null")
      gattServer = server

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
      true
    } catch (e: Exception) {
      false
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

  private val advertiseCallback = object : AdvertiseCallback() {
    override fun onStartFailure(errorCode: Int) {
      setState(STATE_ERROR, "advertising failed with code $errorCode")
    }
  }

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

  /**
   * Generates a P-256 credential key inside the TEE (or StrongBox when the
   * device has a dedicated secure element). The private key never enters app
   * memory - only a KeyStore handle to it does.
   */
  override fun createCredential(rpId: String, userHandleHex: String, promise: Promise) {
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

  override fun signWithCredential(credentialIdHex: String, payloadHex: String, promise: Promise) {
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
    // Events raised before JS subscribes (or after teardown) have no listener;
    // dropping them is correct.
    try {
      if (isStatus) emitOnGattStatus(map) else emitOnCtapRequest(map)
    } catch (_: Exception) {
      // No JS listener attached.
    }
  }

  companion object {
    /** FIDO Bluetooth Service, 16-bit UUID 0xFFFD in the Bluetooth base range. */
    private val FIDO_SERVICE_UUID: UUID = UUID.fromString("0000fffd-0000-1000-8000-00805f9b34fb")
    private val FIDO_CONTROL_POINT_UUID: UUID = UUID.fromString("f1d0fff1-deaa-ecee-b42f-c9ba7ed623bb")
    private val FIDO_STATUS_UUID: UUID = UUID.fromString("f1d0fff2-deaa-ecee-b42f-c9ba7ed623bb")
    private val FIDO_CONTROL_POINT_LENGTH_UUID: UUID = UUID.fromString("f1d0fff3-deaa-ecee-b42f-c9ba7ed623bb")
    private val FIDO_SERVICE_REVISION_UUID: UUID = UUID.fromString("f1d0fff4-deaa-ecee-b42f-c9ba7ed623bb")
    private val CLIENT_CHARACTERISTIC_CONFIG_UUID: UUID =
      UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

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
    private const val PERMISSION_REQUEST_CODE = 0xF1D0

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
