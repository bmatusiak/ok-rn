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
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.core.content.ContextCompat
import com.facebook.fbreact.specs.NativeFidoGattSpec
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
    val activity = currentActivity as? PermissionAwareActivity
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
      stopEverything()

      val server = manager.openGattServer(reactContext, gattCallback)
        ?: throw IllegalStateException("openGattServer returned null")
      gattServer = server
      server.addService(buildFidoService())

      val leAdvertiser = adapter.bluetoothLeAdvertiser
        ?: throw IllegalStateException("This device cannot act as a BLE peripheral")
      advertiser = leAdvertiser

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
      setState(STATE_ADVERTISING, "service 0xFFFD")
      promise.resolve(null)
    } catch (e: Exception) {
      stopEverything()
      setState(STATE_ERROR, e.message ?: "startAdvertising failed")
      promise.reject(ERR_ADVERTISE, e.message ?: "startAdvertising failed", e)
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
    mtu = DEFAULT_MTU
  }

  private fun buildFidoService(): BluetoothGattService {
    val service = BluetoothGattService(FIDO_SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)

    // Control Point: the host writes CTAP commands here.
    service.addCharacteristic(
      BluetoothGattCharacteristic(
        FIDO_CONTROL_POINT_UUID,
        BluetoothGattCharacteristic.PROPERTY_WRITE,
        BluetoothGattCharacteristic.PERMISSION_WRITE,
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

    // Service Revision Bitfield: 0x20 advertises FIDO2 / CTAP2 support.
    val revision = BluetoothGattCharacteristic(
      FIDO_SERVICE_REVISION_UUID,
      BluetoothGattCharacteristic.PROPERTY_READ,
      BluetoothGattCharacteristic.PERMISSION_READ,
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

    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      if (newState == BluetoothGatt.STATE_CONNECTED) {
        connectedDevice = device
        setState(STATE_CONNECTED, "central connected")
      } else {
        connectedDevice = null
        assembler.reset()
        // Advertising stops on connect; go back to advertising so the next
        // desktop can find us after the current one drops.
        setState(if (gattServer != null) STATE_ADVERTISING else STATE_STOPPED, "central disconnected")
      }
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

    override fun onDescriptorWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray,
    ) {
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
      if (responseNeeded) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
      }
      if (characteristic.uuid != FIDO_CONTROL_POINT_UUID) {
        return
      }

      val message = assembler.push(value) ?: return
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

  private fun maxFragmentSize(): Int = (mtu - ATT_HEADER_BYTES).coerceAtLeast(MIN_FRAGMENT)

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

      for (fragment in fragments) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          server.notifyCharacteristicChanged(device, status, false, fragment)
        } else {
          @Suppress("DEPRECATION")
          status.value = fragment
          @Suppress("DEPRECATION")
          server.notifyCharacteristicChanged(device, status, false)
        }
      }
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject(ERR_RESPOND, e.message ?: "respondToRequest failed", e)
    }
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
    private const val USER_AUTH_VALIDITY_SECONDS = 30
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
