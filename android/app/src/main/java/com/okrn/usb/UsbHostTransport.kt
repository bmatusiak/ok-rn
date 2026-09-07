package com.okrn.usb

import android.content.Context
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Production transport: USB host mode over OTG using android.hardware.usb.
 *
 * Requires the phone to support USB Host mode and a real OTG adapter -
 * charge-only cables fail silently (EXPLAINER/!.md section 1). Permission is
 * handled by [UsbPermissionBroker] before this class is ever opened.
 */
class UsbHostTransport(
  private val context: Context,
  private val usbManager: UsbManager,
) : HidTransport {

  override val name: String = "usb"

  private var connection: UsbDeviceConnection? = null
  private var claimedInterface: UsbInterface? = null
  private var inEndpoint: UsbEndpoint? = null
  private var outEndpoint: UsbEndpoint? = null
  private val reading = AtomicBoolean(false)

  override var packetSize: Int = 64
    private set

  override var onData: ((ByteArray) -> Unit)? = null
  override var onStatus: ((state: String, message: String) -> Unit)? = null

  override fun isOpen(): Boolean = connection != null

  fun findDevice(vendorId: Int, productId: Int): UsbDevice? =
    usbManager.deviceList.values.firstOrNull { device ->
      (vendorId < 0 || device.vendorId == vendorId) &&
        (productId < 0 || device.productId == productId)
    }

  override fun open(vendorId: Int, productId: Int) {
    close()
    onStatus?.invoke("connecting", "opening usb device")

    val device = findDevice(vendorId, productId)
      ?: throw IllegalStateException("No USB device matching vid=$vendorId pid=$productId")

    if (!usbManager.hasPermission(device)) {
      throw SecurityException("USB permission not granted for ${device.deviceName}")
    }

    // Prefer a real HID interface (class 3); fall back to interface 0 for
    // vendor-specific devices that expose HID-shaped endpoints without the class.
    val iface = (0 until device.interfaceCount)
      .map { device.getInterface(it) }
      .firstOrNull { it.interfaceClass == UsbConstants.USB_CLASS_HID }
      ?: device.getInterface(0)

    val conn = usbManager.openDevice(device)
      ?: throw IllegalStateException("openDevice returned null for ${device.deviceName}")

    if (!conn.claimInterface(iface, true)) {
      conn.close()
      throw IllegalStateException("Failed to claim interface ${iface.id}")
    }

    connection = conn
    claimedInterface = iface

    for (i in 0 until iface.endpointCount) {
      val endpoint = iface.getEndpoint(i)
      if (endpoint.direction == UsbConstants.USB_DIR_IN) {
        inEndpoint = endpoint
      } else {
        outEndpoint = endpoint
      }
    }

    // Match the read buffer to the endpoint, not a hardcoded 64
    // (EXPLAINER/!.md section 2).
    packetSize = inEndpoint?.maxPacketSize ?: outEndpoint?.maxPacketSize ?: 64

    onStatus?.invoke(
      "connected",
      "vid=0x%04x pid=0x%04x packet=%d".format(device.vendorId, device.productId, packetSize),
    )
    startReadLoop()
  }

  private fun startReadLoop() {
    val endpoint = inEndpoint ?: return
    reading.set(true)
    thread(name = "ok-usb-reader", isDaemon = true) {
      val buffer = ByteArray(endpoint.maxPacketSize)
      while (reading.get()) {
        val conn = connection ?: break
        // Interrupt endpoints are read with bulkTransfer on Android; a timeout
        // return of <= 0 is normal idle, not an error.
        val read = try {
          conn.bulkTransfer(endpoint, buffer, buffer.size, READ_TIMEOUT_MS)
        } catch (e: Exception) {
          if (reading.get()) {
            onStatus?.invoke("error", e.message ?: "usb read failed")
          }
          break
        }
        if (read > 0) {
          onData?.invoke(buffer.copyOf(read))
        }
      }
      reading.set(false)
    }
  }

  override fun write(bytes: ByteArray): Int {
    val conn = connection ?: return -1
    val endpoint = outEndpoint ?: return -1
    return try {
      conn.bulkTransfer(endpoint, bytes, bytes.size, WRITE_TIMEOUT_MS)
    } catch (e: Exception) {
      onStatus?.invoke("error", e.message ?: "usb write failed")
      -1
    }
  }

  override fun close() {
    reading.set(false)
    val conn = connection
    val iface = claimedInterface
    if (conn != null && iface != null) {
      try {
        conn.releaseInterface(iface)
      } catch (_: Exception) {
        // Device may already be gone (hot-unplug); nothing to release.
      }
    }
    try {
      conn?.close()
    } catch (_: Exception) {
      // Same.
    }
    connection = null
    claimedInterface = null
    inEndpoint = null
    outEndpoint = null
  }

  companion object {
    private const val READ_TIMEOUT_MS = 1000
    private const val WRITE_TIMEOUT_MS = 1000
  }
}
