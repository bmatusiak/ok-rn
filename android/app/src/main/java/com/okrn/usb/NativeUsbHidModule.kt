package com.okrn.usb

import android.content.Context
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbManager
import android.os.Build
import com.okrn.specs.NativeUsbHidSpec
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.okrn.BuildConfig
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

/**
 * USB HID bridge with a dual transport: real hardware over OTG, or a TCP socket
 * to tools/hardware-emulator.js when running on an emulator.
 *
 * All blocking work (socket connect, bulkTransfer) runs on [executor]; the JS
 * thread only ever hands off and gets a Promise back.
 */
@ReactModule(name = NativeUsbHidSpec.NAME)
class NativeUsbHidModule(
  private val reactContext: ReactApplicationContext,
) : NativeUsbHidSpec(reactContext) {

  private val usbManager: UsbManager =
    reactContext.getSystemService(Context.USB_SERVICE) as UsbManager

  private val broker = UsbPermissionBroker(reactContext, usbManager)
  private val executor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "ok-usbhid").apply { isDaemon = true }
  }

  private val transportMode = AtomicReference(MODE_AUTO)
  private var tcpHost = DEFAULT_TCP_HOST
  private var tcpPort = DEFAULT_TCP_PORT
  private var active: HidTransport? = null

  init {
    broker.register()
    broker.onAttached = { device ->
      emitStatus("disconnected", "usb", "device attached: ${device.deviceName}")
    }
    broker.onDetached = { device ->
      // Hot-unplug: tear the transport down so the read loop stops cleanly
      // instead of spinning on a dead endpoint.
      if (active is UsbHostTransport) {
        active?.close()
        active = null
      }
      emitStatus("disconnected", "usb", "device detached: ${device.deviceName}")
    }
  }

  override fun invalidate() {
    executor.execute {
      active?.close()
      active = null
    }
    broker.unregister()
    executor.shutdown()
    super.invalidate()
  }

  // ---------------------------------------------------------------- transport

  override fun setTransport(transport: String) {
    transportMode.set(
      when (transport) {
        MODE_USB, MODE_TCP -> transport
        else -> MODE_AUTO
      },
    )
  }

  override fun getTransport(): String = transportMode.get()

  override fun configureTcp(host: String, port: Double) {
    tcpHost = host
    tcpPort = port.toInt()
  }

  /**
   * 'auto' resolves to the TCP mock only on a debug build running on an
   * emulator. A debug build on a real phone still talks to real hardware,
   * which is what you want when testing with a device plugged in.
   */
  private fun resolveMode(): String = when (val mode = transportMode.get()) {
    MODE_AUTO -> if (BuildConfig.DEBUG && isEmulator()) MODE_TCP else MODE_USB
    else -> mode
  }

  private fun isEmulator(): Boolean =
    Build.FINGERPRINT.startsWith("generic") ||
      Build.FINGERPRINT.startsWith("unknown") ||
      Build.FINGERPRINT.contains("emulator", ignoreCase = true) ||
      Build.MODEL.contains("google_sdk", ignoreCase = true) ||
      Build.MODEL.contains("Emulator", ignoreCase = true) ||
      Build.MODEL.contains("Android SDK built for", ignoreCase = true) ||
      Build.PRODUCT.contains("sdk", ignoreCase = true) ||
      Build.HARDWARE.contains("goldfish", ignoreCase = true) ||
      Build.HARDWARE.contains("ranchu", ignoreCase = true)

  private fun buildTransport(mode: String): HidTransport = when (mode) {
    MODE_TCP -> TcpTransport(tcpHost, tcpPort)
    else -> UsbHostTransport(reactContext, usbManager)
  }

  // ------------------------------------------------------------------ queries

  override fun listDevices(promise: Promise) {
    executor.execute {
      try {
        val devices = Arguments.createArray()
        if (resolveMode() != MODE_TCP) {
          for (device in usbManager.deviceList.values) {
            val map = Arguments.createMap()
            map.putString("deviceName", device.deviceName)
            map.putInt("vendorId", device.vendorId)
            map.putInt("productId", device.productId)
            map.putString("productName", device.productName ?: "")
            map.putString("manufacturerName", device.manufacturerName ?: "")
            map.putInt("interfaceCount", device.interfaceCount)
            map.putBoolean("hasPermission", usbManager.hasPermission(device))
            // Widest IN endpoint across all interfaces. A multi-interface HID
            // device exposes an 8-byte boot keyboard alongside the 64-byte raw
            // interface, and only the latter carries CTAPHID.
            var widest = 0
            for (i in 0 until device.interfaceCount) {
              val iface = device.getInterface(i)
              for (e in 0 until iface.endpointCount) {
                val ep = iface.getEndpoint(e)
                if (ep.direction == UsbConstants.USB_DIR_IN && ep.maxPacketSize > widest) {
                  widest = ep.maxPacketSize
                }
              }
            }
            map.putInt("maxReportSize", widest)
            devices.pushMap(map)
          }
        }
        promise.resolve(devices)
      } catch (e: Exception) {
        promise.reject(ERR_LIST, e.message ?: "listDevices failed", e)
      }
    }
  }

  override fun isConnected(): Boolean = active?.isOpen() == true

  // -------------------------------------------------------------- permissions

  override fun requestPermission(vendorId: Double, productId: Double, promise: Promise) {
    if (resolveMode() == MODE_TCP) {
      promise.resolve(true)
      return
    }
    val vid = vendorId.toInt()
    val pid = productId.toInt()
    val device = usbManager.deviceList.values.firstOrNull {
      (vid < 0 || it.vendorId == vid) && (pid < 0 || it.productId == pid)
    }
    if (device == null) {
      promise.reject(ERR_NOT_FOUND, "No USB device matching vid=$vid pid=$pid")
      return
    }
    // The OS answers via broadcast, not a return value, so the Promise is
    // settled from the broker callback (EXPLAINER/!.md section 1).
    broker.request(device) { granted -> promise.resolve(granted) }
  }

  // --------------------------------------------------------------- connection

  override fun connect(vendorId: Double, productId: Double, promise: Promise) {
    executor.execute {
      try {
        active?.close()
        val mode = resolveMode()
        val transport = buildTransport(mode)

        transport.onData = { bytes ->
          val map = Arguments.createMap()
          map.putString("hex", bytes.toHex())
          map.putInt("length", bytes.size)
          emitData(map)
        }
        transport.onStatus = { state, message ->
          emitStatus(state, transport.name, message)
        }

        transport.open(vendorId.toInt(), productId.toInt())
        active = transport

        val result = Arguments.createMap()
        result.putString("transport", transport.name)
        result.putInt("vendorId", vendorId.toInt())
        result.putInt("productId", productId.toInt())
        result.putInt("packetSize", transport.packetSize)
        promise.resolve(result)
      } catch (e: Exception) {
        active = null
        emitStatus("error", resolveMode(), e.message ?: "connect failed")
        promise.reject(ERR_CONNECT, e.message ?: "connect failed", e)
      }
    }
  }

  override fun disconnect(promise: Promise) {
    executor.execute {
      try {
        val name = active?.name ?: resolveMode()
        active?.close()
        active = null
        emitStatus("disconnected", name, "closed by app")
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject(ERR_DISCONNECT, e.message ?: "disconnect failed", e)
      }
    }
  }

  // -------------------------------------------------------------------- write

  override fun write(hex: String, promise: Promise) {
    executor.execute {
      try {
        val transport = active
        if (transport == null || !transport.isOpen()) {
          promise.reject(ERR_NOT_CONNECTED, "No open transport")
          return@execute
        }
        val bytes = hex.hexToBytes()
        val written = transport.write(bytes)
        if (written < 0) {
          promise.reject(ERR_WRITE, "Transfer failed on ${transport.name}")
        } else {
          promise.resolve(written.toDouble())
        }
      } catch (e: Exception) {
        promise.reject(ERR_WRITE, e.message ?: "write failed", e)
      }
    }
  }

  // ------------------------------------------------------------------- events

  private fun emitStatus(state: String, transport: String, message: String) {
    val map = Arguments.createMap()
    map.putString("state", state)
    map.putString("transport", transport)
    map.putString("message", message)
    emitData(map, isStatus = true)
  }

  private fun emitData(map: WritableMap, isStatus: Boolean = false) {
    // The emitter callback is wired up by the TurboModule manager. If a native
    // event races ahead of that (or arrives after teardown) there is no JS
    // listener to receive it, so dropping it is the correct behaviour.
    try {
      if (isStatus) emitOnStatus(map) else emitOnData(map)
    } catch (_: Exception) {
      // No JS listener attached yet.
    }
  }

  companion object {
    const val MODE_AUTO = "auto"
    const val MODE_USB = "usb"
    const val MODE_TCP = "tcp"

    /** Android emulators reach the host machine's loopback at 10.0.2.2. */
    const val DEFAULT_TCP_HOST = "10.0.2.2"
    const val DEFAULT_TCP_PORT = 9000

    private const val ERR_LIST = "ERR_LIST_DEVICES"
    private const val ERR_NOT_FOUND = "ERR_DEVICE_NOT_FOUND"
    private const val ERR_CONNECT = "ERR_CONNECT"
    private const val ERR_DISCONNECT = "ERR_DISCONNECT"
    private const val ERR_NOT_CONNECTED = "ERR_NOT_CONNECTED"
    private const val ERR_WRITE = "ERR_WRITE_FAILED"
  }
}

private val HEX_CHARS = "0123456789abcdef".toCharArray()

internal fun ByteArray.toHex(): String {
  val out = CharArray(size * 2)
  for (i in indices) {
    val v = this[i].toInt() and 0xff
    out[i * 2] = HEX_CHARS[v ushr 4]
    out[i * 2 + 1] = HEX_CHARS[v and 0x0f]
  }
  return String(out)
}

internal fun String.hexToBytes(): ByteArray {
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
