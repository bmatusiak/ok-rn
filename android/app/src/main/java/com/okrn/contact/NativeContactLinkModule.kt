package com.okrn.contact

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertisingSet
import android.bluetooth.le.AdvertisingSetCallback
import android.bluetooth.le.AdvertisingSetParameters
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import com.okrn.specs.NativeContactLinkSpec
import java.util.UUID

/**
 * The Bluetooth link for Guest Book's in-person key swap (specs/NativeContactLink.ts says what
 * each call does). Its own GATT server and its own advertising set, apart from the soft key's
 * (fido/NativeFidoGattModule.kt): the soft key's characteristics need an encrypted, bonded
 * link, which would put an OS pairing prompt in front of a one-off swap, and its advertisement
 * is already full. Here encryption is off on purpose - the swap above it authenticates both
 * OnlyKeys with X-Wing and seals everything that crosses - and the link exists only while the
 * invite QR is open.
 *
 * One link at a time, either role. Every Bluetooth call is made from the main thread.
 */
@ReactModule(name = NativeContactLinkSpec.NAME)
class NativeContactLinkModule(private val reactContext: ReactApplicationContext) :
  NativeContactLinkSpec(reactContext) {

  private val main = Handler(Looper.getMainLooper())
  private val manager get() = reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager

  /* host */
  private var server: BluetoothGattServer? = null
  private var advertising: AdvertisingSetCallback? = null
  private var peer: BluetoothDevice? = null
  private var peerMtu = 23
  private var tx: BluetoothGattCharacteristic? = null

  /* join */
  private var scanning: ScanCallback? = null
  private var gatt: BluetoothGatt? = null
  private var rx: BluetoothGattCharacteristic? = null
  private var joinPromise: Promise? = null
  private var joinTimeout: Runnable? = null
  private var joinMtu = 23

  /* the one send in flight: completed by onNotificationSent (host) or onCharacteristicWrite (join) */
  private var sending: Promise? = null
  /* and its deadline: a stack that drops a write never calls back, and the swap must not hang on it */
  private var sendTimeout: Runnable? = null

  // -------------------------------------------------------------- permissions

  private fun required(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      arrayOf(
        Manifest.permission.BLUETOOTH_SCAN,
        Manifest.permission.BLUETOOTH_CONNECT,
        Manifest.permission.BLUETOOTH_ADVERTISE,
      )
    } else {
      arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

  private fun granted(): Boolean = required().all {
    ContextCompat.checkSelfPermission(reactContext, it) == PackageManager.PERMISSION_GRANTED
  }

  override fun requestPermissions(promise: Promise) {
    if (granted()) return promise.resolve(true)
    val activity = reactContext.currentActivity as? PermissionAwareActivity
      ?: return promise.reject("PERMISSION", "No activity to ask for Bluetooth permission")
    activity.requestPermissions(required(), REQUEST_CODE, PermissionListener { code, _, results ->
      if (code == REQUEST_CODE) promise.resolve(results.isNotEmpty() && results.all { it == PackageManager.PERMISSION_GRANTED })
      true
    })
  }

  // -------------------------------------------------------------- host (shows the QR)

  @SuppressLint("MissingPermission")
  override fun host(linkHex: String, promise: Promise) {
    main.post {
      try {
        closeAll(null)
        val uuid = serviceUuid(linkHex)
        val adapter = manager.adapter
        if (adapter == null || !adapter.isEnabled) return@post promise.reject("BLUETOOTH_OFF", "Bluetooth is off")
        val advertiser = adapter.bluetoothLeAdvertiser
          ?: return@post promise.reject("UNSUPPORTED", "this phone cannot advertise over Bluetooth LE")

        val service = BluetoothGattService(uuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        val rxChar = BluetoothGattCharacteristic(
          RX_UUID,
          BluetoothGattCharacteristic.PROPERTY_WRITE,
          BluetoothGattCharacteristic.PERMISSION_WRITE,
        )
        val txChar = BluetoothGattCharacteristic(
          TX_UUID,
          BluetoothGattCharacteristic.PROPERTY_NOTIFY,
          BluetoothGattCharacteristic.PERMISSION_READ,
        )
        txChar.addDescriptor(
          BluetoothGattDescriptor(
            CCCD_UUID,
            BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
          ),
        )
        service.addCharacteristic(rxChar)
        service.addCharacteristic(txChar)
        tx = txChar

        var answered = false
        val srv = manager.openGattServer(reactContext, object : BluetoothGattServerCallback() {
          override fun onServiceAdded(status: Int, added: BluetoothGattService) {
            main.post {
              if (answered) return@post
              answered = true
              if (status != BluetoothGatt.GATT_SUCCESS) {
                closeAll(null)
                return@post promise.reject("GATT", "the swap service was not added ($status)")
              }
              startAdvertising(advertiser, uuid, promise)
            }
          }

          override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            main.post {
              if (newState == BluetoothProfile.STATE_DISCONNECTED && device == peer) {
                peer = null
                failSend("the other phone left")
                emit("closed", message = "the other phone disconnected")
              }
            }
          }

          override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            main.post { if (peer == null || device == peer) peerMtu = mtu }
          }

          override fun onCharacteristicWriteRequest(
            device: BluetoothDevice, requestId: Int, characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray?,
          ) {
            main.post {
              val ok = characteristic.uuid == RX_UUID && device == peer && !preparedWrite && offset == 0
              if (responseNeeded) {
                server?.sendResponse(device, requestId, if (ok) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_WRITE_NOT_PERMITTED, 0, null)
              }
              if (ok && value != null) emit("data", hex = toHex(value))
            }
          }

          override fun onDescriptorWriteRequest(
            device: BluetoothDevice, requestId: Int, descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray?,
          ) {
            main.post {
              /* the first phone to subscribe is the peer; any other is turned away */
              val first = peer == null || device == peer
              if (responseNeeded) {
                server?.sendResponse(device, requestId, if (first) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_WRITE_NOT_PERMITTED, 0, null)
              }
              if (!first) {
                server?.cancelConnection(device)
                return@post
              }
              if (descriptor.uuid == CCCD_UUID && value != null && value.isNotEmpty() && value[0].toInt() != 0) {
                peer = device
                emit("connected", mtu = peerMtu)
              }
            }
          }

          override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            main.post { sent(status, "a notification") }
          }
        }) ?: return@post promise.reject("GATT", "could not open a GATT server")
        server = srv
        if (!srv.addService(service)) {
          closeAll(null)
          promise.reject("GATT", "the swap service could not be added")
        }
      } catch (e: Exception) {
        closeAll(null)
        promise.reject("HOST", e.message ?: "host failed", e)
      }
    }
  }

  @SuppressLint("MissingPermission")
  private fun startAdvertising(advertiser: android.bluetooth.le.BluetoothLeAdvertiser, uuid: UUID, promise: Promise) {
    val params = AdvertisingSetParameters.Builder()
      .setLegacyMode(true)
      .setConnectable(true)
      .setScannable(true)
      .setInterval(AdvertisingSetParameters.INTERVAL_LOW)
      .setTxPowerLevel(AdvertisingSetParameters.TX_POWER_MEDIUM)
      .build()
    /* flags (3) + one 128-bit service UUID (18) = 21 of the 31 bytes; no name, it would not fit */
    val data = AdvertiseData.Builder().addServiceUuid(ParcelUuid(uuid)).setIncludeDeviceName(false).build()
    var answered = false
    val cb = object : AdvertisingSetCallback() {
      override fun onAdvertisingSetStarted(set: AdvertisingSet?, txPower: Int, status: Int) {
        main.post {
          if (answered) return@post
          answered = true
          if (status == ADVERTISE_SUCCESS) {
            promise.resolve(null)
          } else {
            closeAll(null)
            promise.reject("ADVERTISE", "this phone could not advertise the swap ($status) - too many Bluetooth advertisers at once?")
          }
        }
      }
    }
    advertising = cb
    advertiser.startAdvertisingSet(params, data, null, null, null, cb)
  }

  // -------------------------------------------------------------- join (scanned the QR)

  @SuppressLint("MissingPermission")
  override fun join(linkHex: String, timeoutMs: Double, promise: Promise) {
    main.post {
      try {
        closeAll(null)
        val uuid = serviceUuid(linkHex)
        val adapter = manager.adapter
        if (adapter == null || !adapter.isEnabled) return@post promise.reject("BLUETOOTH_OFF", "Bluetooth is off")
        val scanner = adapter.bluetoothLeScanner
          ?: return@post promise.reject("UNSUPPORTED", "this phone cannot scan over Bluetooth LE")
        joinPromise = promise
        val timeout = Runnable { failJoin("NOT_FOUND", "the other phone was not found - is its QR still open, and Bluetooth on?") }
        joinTimeout = timeout
        main.postDelayed(timeout, timeoutMs.toLong())

        val cb = object : ScanCallback() {
          override fun onScanResult(callbackType: Int, result: ScanResult) {
            main.post {
              if (scanning !== this) return@post
              stopScan()
              connect(result.device, uuid)
            }
          }

          override fun onScanFailed(errorCode: Int) {
            main.post { failJoin("SCAN", "the Bluetooth scan failed ($errorCode)") }
          }
        }
        scanning = cb
        val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(uuid)).build()
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        scanner.startScan(listOf(filter), settings, cb)
      } catch (e: Exception) {
        failJoin("JOIN", e.message ?: "join failed")
      }
    }
  }

  @SuppressLint("MissingPermission")
  private fun connect(device: BluetoothDevice, uuid: UUID, attempt: Int = 1) {
    gatt = device.connectGatt(reactContext, false, object : BluetoothGattCallback() {
      override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
        main.post {
          if (newState == BluetoothProfile.STATE_CONNECTED) {
            if (!g.requestMtu(REQUESTED_MTU)) g.discoverServices()
          } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
            if (joinPromise != null && attempt < CONNECT_ATTEMPTS) {
              /*
               * A FIRST CONNECT THAT TIMES OUT (status 147, GATT_CONNECTION_TIMEOUT) is common
               * between two phones and the second one goes through: measured Pixel -> A13,
               * 2026-10-12. Once more, in code - never "try again" left to the person.
               */
              Log.i(TAG, "join: connection dropped ($status) before the link was up; connecting again")
              try { g.close() } catch (_: Exception) {}
              connect(device, uuid, attempt + 1)
            } else if (joinPromise != null) {
              failJoin("CONNECT", "the connection to the other phone dropped ($status)")
            } else {
              failSend("the other phone left")
              emit("closed", message = "the other phone disconnected")
            }
          }
        }
      }

      override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
        main.post {
          joinMtu = if (status == BluetoothGatt.GATT_SUCCESS) mtu else 23
          g.discoverServices()
        }
      }

      override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
        main.post {
          val service = g.getService(uuid)
          val txChar = service?.getCharacteristic(TX_UUID)
          val rxChar = service?.getCharacteristic(RX_UUID)
          val cccd = txChar?.getDescriptor(CCCD_UUID)
          if (rxChar == null || txChar == null || cccd == null) return@post failJoin("SERVICE", "the other phone is not offering a key swap")
          rx = rxChar
          g.setCharacteristicNotification(txChar, true)
          val wrote = if (Build.VERSION.SDK_INT >= 33) {
            g.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == android.bluetooth.BluetoothStatusCodes.SUCCESS
          } else {
            @Suppress("DEPRECATION")
            cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            @Suppress("DEPRECATION")
            g.writeDescriptor(cccd)
          }
          if (!wrote) failJoin("SUBSCRIBE", "could not subscribe to the other phone")
        }
      }

      override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
        main.post {
          val p = joinPromise ?: return@post
          if (status != BluetoothGatt.GATT_SUCCESS) return@post failJoin("SUBSCRIBE", "the other phone refused the link ($status)")
          joinPromise = null
          joinTimeout?.let { main.removeCallbacks(it) }
          joinTimeout = null
          /* one attribute value is at most 512 bytes, whatever the MTU */
          p.resolve(minOf(joinMtu - 3, 512))
        }
      }

      override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
        main.post { if (c.uuid == TX_UUID) emit("data", hex = toHex(value)) }
      }

      @Deprecated("API < 33")
      @Suppress("DEPRECATION")
      override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
        if (Build.VERSION.SDK_INT >= 33) return
        val value = c.value ?: return
        main.post { if (c.uuid == TX_UUID) emit("data", hex = toHex(value)) }
      }

      override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
        main.post { sent(status, "a write") }
      }
    }, BluetoothDevice.TRANSPORT_LE)
  }

  // -------------------------------------------------------------- both

  @SuppressLint("MissingPermission")
  override fun send(hex: String, promise: Promise) {
    main.post {
      if (sending != null) return@post promise.reject("BUSY", "a send is already in flight")
      val bytes = fromHex(hex)
      val srv = server
      val dev = peer
      val txChar = tx
      val g = gatt
      val rxChar = rx
      sending = promise
      val deadline = Runnable { if (sending === promise) failSend("the other phone stopped answering") }
      sendTimeout = deadline
      main.postDelayed(deadline, SEND_TIMEOUT_MS)
      val started: Boolean = when {
        srv != null && dev != null && txChar != null ->
          if (Build.VERSION.SDK_INT >= 33) {
            srv.notifyCharacteristicChanged(dev, txChar, false, bytes) == android.bluetooth.BluetoothStatusCodes.SUCCESS
          } else {
            @Suppress("DEPRECATION")
            txChar.value = bytes
            @Suppress("DEPRECATION")
            srv.notifyCharacteristicChanged(dev, txChar, false)
          }
        g != null && rxChar != null ->
          if (Build.VERSION.SDK_INT >= 33) {
            g.writeCharacteristic(rxChar, bytes, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == android.bluetooth.BluetoothStatusCodes.SUCCESS
          } else {
            @Suppress("DEPRECATION")
            rxChar.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            @Suppress("DEPRECATION")
            rxChar.value = bytes
            @Suppress("DEPRECATION")
            g.writeCharacteristic(rxChar)
          }
        else -> false
      }
      if (!started && sending === promise) failSend("no link to the other phone")
    }
  }

  override fun close(promise: Promise) {
    main.post {
      closeAll("closed")
      promise.resolve(null)
    }
  }

  override fun invalidate() {
    main.post { closeAll(null) }
    super.invalidate()
  }

  @SuppressLint("MissingPermission")
  private fun stopScan() {
    val cb = scanning ?: return
    scanning = null
    try { manager.adapter?.bluetoothLeScanner?.stopScan(cb) } catch (_: Exception) {}
  }

  @SuppressLint("MissingPermission")
  private fun closeAll(why: String?) {
    stopScan()
    advertising?.let { cb -> try { manager.adapter?.bluetoothLeAdvertiser?.stopAdvertisingSet(cb) } catch (_: Exception) {} }
    advertising = null
    try { peer?.let { server?.cancelConnection(it) } } catch (_: Exception) {}
    try { server?.close() } catch (_: Exception) {}
    server = null
    peer = null
    peerMtu = 23
    tx = null
    try { gatt?.disconnect(); gatt?.close() } catch (_: Exception) {}
    gatt = null
    rx = null
    joinTimeout?.let { main.removeCallbacks(it) }
    joinTimeout = null
    joinPromise?.reject("CLOSED", why ?: "the link was closed")
    joinPromise = null
    failSend(why ?: "the link was closed")
  }

  private fun failJoin(code: String, message: String) {
    val p = joinPromise
    joinPromise = null
    closeAll(null)
    Log.i(TAG, "join: $message")
    p?.reject(code, message)
  }

  private fun failSend(message: String) {
    val p = sending ?: return
    sending = null
    sendTimeout?.let { main.removeCallbacks(it) }
    sendTimeout = null
    p.reject("SEND", message)
  }

  /* a send's callback arrived: the promise answered, its deadline dropped */
  private fun sent(status: Int, what: String) {
    val p = sending ?: return
    sending = null
    sendTimeout?.let { main.removeCallbacks(it) }
    sendTimeout = null
    if (status == BluetoothGatt.GATT_SUCCESS) p.resolve(null) else p.reject("SEND", "$what failed ($status)")
  }

  private fun emit(type: String, hex: String = "", mtu: Int = 0, message: String = "") {
    val map = Arguments.createMap()
    map.putString("type", type)
    map.putString("hex", hex)
    map.putInt("mtu", mtu)
    map.putString("message", message)
    try { emitOnContactLink(map) } catch (_: Exception) { /* no listener */ }
  }

  companion object {
    private const val TAG = "ContactLink"
    private const val REQUEST_CODE = 0x6f6b
    private const val REQUESTED_MTU = 247
    private const val SEND_TIMEOUT_MS = 10_000L
    private const val CONNECT_ATTEMPTS = 2
    /* "okrncont" + the invite's 8-byte link id: a UUID that names this one swap */
    private const val PREFIX = "6f6b726e-636f-6e74-"
    private val RX_UUID: UUID = UUID.fromString("6f6b726e-636f-6e74-7278-000000000000")
    private val TX_UUID: UUID = UUID.fromString("6f6b726e-636f-6e74-7478-000000000000")
    private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    fun serviceUuid(linkHex: String): UUID {
      require(Regex("^[0-9a-f]{16}$").matches(linkHex)) { "a link id is 8 bytes of hex" }
      return UUID.fromString(PREFIX + linkHex.substring(0, 4) + "-" + linkHex.substring(4))
    }

    fun toHex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }
    fun fromHex(h: String): ByteArray = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
  }
}
