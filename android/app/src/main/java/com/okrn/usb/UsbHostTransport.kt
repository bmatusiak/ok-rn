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
 * charge-only cables fail silently. Permission is handled by
 * [UsbPermissionBroker] before this class is ever opened.
 *
 * ## IT CLAIMS EVERY INTERFACE, not one
 *
 * An OnlyKey exposes four HID interfaces and they carry different protocols.
 * This class used to claim exactly one, chosen by scoring interface class,
 * subclass, protocol and endpoint width - attributes on which three of the four
 * are IDENTICAL. The score tied three ways and `maxByOrNull` returned the
 * first, so the winner was whichever the device enumerated first. It happened
 * to be the security-key interface, which is why the app could speak that
 * protocol to a real key and nothing else: the vendor interface, which carries
 * the PIN bracket, slots, labels, preferences and restore, was never claimed.
 *
 * Interfaces are identified by their HID USAGE PAGE, read from the report
 * descriptor with a control transfer. That is the only thing that separates
 * them. See `Iface.kt`, and `node-onlykey-lib/src/transport/usbDescriptors.js`
 * for the reasoning and the table.
 *
 * ## It refuses rather than guessing
 *
 * A failed descriptor read, two interfaces claiming to be the same one, or a
 * required interface missing all throw with a message naming what happened.
 * There is no fallback to enumeration order: a silent guess here routes the
 * vendor protocol to the security-key interface, where every request times out
 * and the error blames the device. That failure mode is exactly what this
 * rewrite exists to remove, and reintroducing it as a safety net would be the
 * same bug wearing a hat.
 */
class UsbHostTransport(
  private val context: Context,
  private val usbManager: UsbManager,
) : HidTransport {

  override val name: String = "usb"

  private var connection: UsbDeviceConnection? = null

  /** Everything claimed, so close() can release all of it. */
  private val claimed = mutableListOf<UsbInterface>()

  /** Per-interface endpoints and facts, keyed by [Iface]. */
  private val open = LinkedHashMap<Int, Claimed>()

  private val reading = AtomicBoolean(false)
  private val readers = mutableListOf<Thread>()

  override var packetSize: Int = 64
    private set

  override val interfaces: List<OpenInterface>
    get() = open.values.map { it.described }

  override var onData: ((iface: Int, bytes: ByteArray) -> Unit)? = null
  override var onStatus: ((state: String, message: String) -> Unit)? = null

  override fun isOpen(): Boolean = connection != null

  private class Claimed(
    val spec: IfaceSpec,
    val usbInterface: UsbInterface,
    val inEndpoint: UsbEndpoint?,
    val outEndpoint: UsbEndpoint?,
    val described: OpenInterface,
  )

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

    val conn = usbManager.openDevice(device)
      ?: throw IllegalStateException("openDevice returned null for ${device.deviceName}")
    connection = conn

    try {
      claimAll(device, conn)
      verify(device)
    } catch (e: Exception) {
      // A half-open device is worse than none: it answers some things and times
      // out on others, which reads as a flaky key.
      close()
      throw e
    }

    packetSize = open[Iface.VENDOR]?.spec?.endpointIn ?: 64

    onStatus?.invoke(
      "connected",
      "vid=0x%04x pid=0x%04x, %s".format(
        device.vendorId, device.productId,
        open.values.joinToString(", ") {
          "${Iface.name(it.spec.iface)}=${it.described.interfaceNumber}"
        },
      ),
    )
    startReadLoops()
  }

  /**
   * Claim every HID interface, then ask each one what it is.
   *
   * CLAIM BEFORE READING THE DESCRIPTOR. `claimInterface(force = true)` detaches
   * the kernel's `usbhid` driver, which is bound to the keyboard interface and
   * may be bound to the others; the control transfer is refused while the kernel
   * still owns the interface.
   *
   * Detaching the keyboard is deliberate and is a goal rather than a side
   * effect - it is what stops the key typing into whatever Android window has
   * focus and lets the app capture the keystrokes instead.
   */
  private fun claimAll(device: UsbDevice, conn: UsbDeviceConnection) {
    val buffer = ByteArray(Descriptor.REPORT_DESCRIPTOR_MAX)

    for (i in 0 until device.interfaceCount) {
      val ui = device.getInterface(i)
      if (ui.interfaceClass != UsbConstants.USB_CLASS_HID) continue

      if (!conn.claimInterface(ui, true)) {
        // Named, because the usual cause is an OEM policy refusing the detach
        // and the symptom otherwise is "the key types nothing".
        throw IllegalStateException(
          "could not claim interface ${ui.id} - the kernel HID driver would not " +
            "release it, which some devices refuse by policy",
        )
      }
      claimed.add(ui)

      val read = conn.controlTransfer(
        Descriptor.REQUEST_TYPE_GET_DESCRIPTOR_INTERFACE,
        Descriptor.REQUEST_GET_DESCRIPTOR,
        (Descriptor.DESCRIPTOR_TYPE_REPORT shl 8) or 0x00,
        ui.id,
        buffer,
        buffer.size,
        CONTROL_TIMEOUT_MS,
      )
      if (read <= 0) {
        throw IllegalStateException(
          "interface ${ui.id} did not answer a report-descriptor request " +
            "($read), so it cannot be identified and will not be guessed at",
        )
      }

      val (usagePage, usage) = Descriptor.parseUsage(buffer, read)
      val spec = Descriptor.identify(usagePage, usage)
      if (spec == null) {
        // Not ours. Release it rather than holding a device's interface for no
        // reason - a composite device could carry anything alongside.
        conn.releaseInterface(ui)
        claimed.remove(ui)
        continue
      }
      if (open.containsKey(spec.iface)) {
        throw IllegalStateException(
          "interfaces ${open[spec.iface]?.described?.interfaceNumber} and ${ui.id} " +
            "both identify as ${Iface.name(spec.iface)} - one of them is " +
            "something else, and writing to it would time out with no error",
        )
      }

      var inEp: UsbEndpoint? = null
      var outEp: UsbEndpoint? = null
      for (e in 0 until ui.endpointCount) {
        val ep = ui.getEndpoint(e)
        if (ep.direction == UsbConstants.USB_DIR_IN) {
          if (inEp == null) inEp = ep
        } else if (outEp == null) {
          outEp = ep
        }
      }

      open[spec.iface] = Claimed(
        spec = spec,
        usbInterface = ui,
        inEndpoint = inEp,
        outEndpoint = outEp,
        described = OpenInterface(
          iface = spec.iface,
          interfaceNumber = ui.id,
          usagePage = usagePage ?: 0,
          usage = usage ?: 0,
          packetSizeIn = inEp?.maxPacketSize ?: 0,
          packetSizeOut = outEp?.maxPacketSize ?: 0,
          identifiedBy = OpenInterface.BY_USAGE_PAGE,
        ),
      )
    }
  }

  /** Everything required present, or say which is not. */
  private fun verify(device: UsbDevice) {
    val missing = Descriptor.ALL
      .filter { it.required && !open.containsKey(it.iface) }
      .map { Iface.name(it.iface) }

    if (missing.isNotEmpty()) {
      throw IllegalStateException(
        "${device.deviceName} is missing ${missing.joinToString(", ")} - it " +
          "enumerated ${device.interfaceCount} interfaces and " +
          "${open.size} were identified. Not an OnlyKey, or a firmware that " +
          "does not expose them",
      )
    }
  }

  /**
   * ONE READER THREAD PER INBOUND ENDPOINT.
   *
   * `bulkTransfer` blocks, so four interfaces cannot share one loop - a read
   * waiting on the idle debug console would hold up a vendor reply behind it.
   *
   * `UsbRequest` with `requestWait` would reap every endpoint on one thread and
   * is the tidier shape, but `requestWait(long)` is API 26 and this app's
   * minSdk is 24. Below that it blocks forever and can only be woken by closing
   * the connection underneath it, so taking that route means maintaining two
   * implementations that differ exactly where this work is trying to remove
   * differences. Four daemon threads cost nothing.
   */
  private fun startReadLoops() {
    reading.set(true)
    for (claimedIface in open.values) {
      val endpoint = claimedIface.inEndpoint ?: continue
      val iface = claimedIface.spec.iface

      readers.add(
        thread(name = "ok-usb-rx-${Iface.name(iface)}", isDaemon = true) {
          val buffer = ByteArray(endpoint.maxPacketSize)
          var consecutiveFailures = 0

          while (reading.get()) {
            val conn = connection ?: break
            val started = System.currentTimeMillis()

            val read = try {
              conn.bulkTransfer(endpoint, buffer, buffer.size, READ_TIMEOUT_MS)
            } catch (e: Exception) {
              if (reading.get()) {
                onStatus?.invoke(
                  "error",
                  "${Iface.name(iface)} read failed: ${e.message ?: "unknown"}",
                )
              }
              break
            }

            if (read > 0) {
              consecutiveFailures = 0
              onData?.invoke(iface, buffer.copyOf(read))
              continue
            }

            /*
             * A NEGATIVE RETURN IS ONLY NORMAL IF IT TOOK THE WHOLE TIMEOUT.
             *
             * An idle endpoint times out, which is expected - three of the four
             * are idle almost all the time. An UNPLUGGED one fails instantly,
             * and the old single loop treated both as idle, so it spun at full
             * speed on a dead endpoint while the app still looked connected.
             */
            val elapsed = System.currentTimeMillis() - started
            if (elapsed >= READ_TIMEOUT_MS - TIMEOUT_SLACK_MS) {
              consecutiveFailures = 0
              continue
            }
            if (++consecutiveFailures >= FAILURES_BEFORE_GIVING_UP) {
              if (reading.get()) {
                onStatus?.invoke(
                  "error",
                  "${Iface.name(iface)} endpoint stopped answering - the device " +
                    "was probably unplugged",
                )
              }
              break
            }
          }
        },
      )
    }
  }

  override fun write(iface: Int, bytes: ByteArray): Int {
    val conn = connection ?: return -1
    val target = open[iface]
    if (target == null) {
      onStatus?.invoke(
        "error",
        "this device does not carry ${Iface.name(iface)}, so the write went nowhere",
      )
      return -1
    }
    val endpoint = target.outEndpoint
    if (endpoint == null) {
      // The keyboard is the case: device to host only. The emulator rejects a
      // write to it natively for the same reason.
      onStatus?.invoke(
        "error",
        "${Iface.name(iface)} has no outbound endpoint - it is device to host only",
      )
      return -1
    }
    if (bytes.size > endpoint.maxPacketSize) {
      // The debug console is 32 bytes out while everything else is 64, and its
      // writes are not padded. Truncating silently would deliver half a line.
      onStatus?.invoke(
        "error",
        "${bytes.size} bytes will not fit ${Iface.name(iface)}'s " +
          "${endpoint.maxPacketSize}-byte endpoint",
      )
      return -1
    }

    return try {
      conn.bulkTransfer(endpoint, bytes, bytes.size, WRITE_TIMEOUT_MS)
    } catch (e: Exception) {
      onStatus?.invoke("error", e.message ?: "usb write failed")
      -1
    }
  }

  /**
   * ORDER MATTERS HERE, and getting it wrong is a deadlock rather than a mess.
   *
   * `UsbDeviceConnection.close()` takes an internal write lock, and every
   * in-flight `bulkTransfer` holds the read lock. Readers that re-enter the
   * transfer immediately after each timeout can starve the writer indefinitely.
   * So: stop them, WAIT for them to notice, then release, then close.
   *
   * The previous implementation joined nothing.
   */
  override fun close() {
    reading.set(false)

    for (reader in readers) {
      try {
        reader.join((READ_TIMEOUT_MS + JOIN_SLACK_MS).toLong())
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
    readers.clear()

    val conn = connection
    if (conn != null) {
      for (ui in claimed) {
        try {
          conn.releaseInterface(ui)
        } catch (_: Exception) {
          // Device may already be gone on a hot unplug; nothing to release.
        }
      }
      try {
        conn.close()
      } catch (_: Exception) {
        // Same.
      }
    }

    claimed.clear()
    open.clear()
    connection = null
  }

  companion object {
    private const val READ_TIMEOUT_MS = 1000
    private const val WRITE_TIMEOUT_MS = 1000
    private const val CONTROL_TIMEOUT_MS = 2000

    /** A read that came back this close to the timeout was idle, not failing. */
    private const val TIMEOUT_SLACK_MS = 50

    /** Fast failures in a row before a reader calls its endpoint dead. */
    private const val FAILURES_BEFORE_GIVING_UP = 5

    private const val JOIN_SLACK_MS = 500
  }
}
