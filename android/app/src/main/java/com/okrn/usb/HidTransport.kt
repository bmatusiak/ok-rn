package com.okrn.usb

/**
 * A byte pipe to the hardware, CARRYING AN INTERFACE NUMBER.
 *
 * Two implementations back this: [UsbHostTransport] talks to real hardware over
 * OTG via UsbManager, and [TcpTransport] talks to tools/hardware-emulator.js so
 * the app can be developed on an Android emulator, which cannot pass through USB
 * endpoints.
 *
 * ## Why every byte is tagged
 *
 * An OnlyKey is not one pipe. It exposes four HID interfaces and they carry
 * different protocols: the keyboard types, one RawHID interface speaks the
 * security-key protocol, the other carries almost everything the app does - the
 * PIN bracket, slots, labels, preferences, key loading, restore - and the last
 * is the debug console.
 *
 * This interface used to be `write(bytes)` / `onData(bytes)` with no way to say
 * which. That is why the app could speak the security-key protocol to a real
 * key and nothing else: only one interface was ever claimed, and there was
 * nowhere to put the others even if it had been.
 *
 * The numbers are [Iface]'s, which are the library's `IFACE` values and the
 * firmware's own interface numbers. See `Iface.kt` for why they must still be
 * MAPPED by usage page rather than assumed from enumeration order.
 */
interface HidTransport {
  /** 'usb' or 'tcp'; surfaced to JS on every status event. */
  val name: String

  /**
   * The report width to expect from the RawHID interfaces, once open.
   *
   * Kept as one number because it is what `ConnectResult.packetSize` has always
   * meant and what the byte-level debug panel displays. It is NOT the width of
   * every interface - the keyboard is 8 and the debug console writes 32 - so
   * anything routing by interface must use [interfaces] instead.
   */
  val packetSize: Int

  /**
   * What this transport actually carries, after [open].
   *
   * Empty before open. A caller checks this rather than assuming: a production
   * key has no debug interface, and a transport that could not identify one
   * refuses rather than guessing, so what is here is what was proven.
   */
  val interfaces: List<OpenInterface>

  fun isOpen(): Boolean

  /**
   * Opens the pipe and starts reading. Blocking - callers run it off the JS
   * thread. Throws, with a message naming what was missing, rather than opening
   * half a device.
   */
  fun open(vendorId: Int, productId: Int)

  fun close()

  /**
   * Writes one report to one interface. Returns bytes written, or -1.
   *
   * -1 rather than an exception for a routing mistake - an interface this
   * transport does not carry, or one with no outbound endpoint such as the
   * keyboard - because that is a caller error to report, not a bus failure.
   */
  fun write(iface: Int, bytes: ByteArray): Int

  /** Called for every inbound report, tagged with the interface. Set before [open]. */
  var onData: ((iface: Int, bytes: ByteArray) -> Unit)?

  /** state is one of: connecting, connected, disconnected, error. */
  var onStatus: ((state: String, message: String) -> Unit)?
}

/**
 * One interface a transport has actually opened.
 *
 * `identifiedBy` is the part that matters and the reason this is reported to JS
 * rather than kept private. Anything other than `usagePage` is a GUESS, and a
 * guess here routes the vendor protocol to the security-key interface, where
 * every request times out and the error blames the device. A host is expected
 * to refuse a session built on one.
 */
data class OpenInterface(
  val iface: Int,
  /** The device's own bInterfaceNumber, which need not equal [iface]. */
  val interfaceNumber: Int,
  val usagePage: Int,
  val usage: Int,
  val packetSizeIn: Int,
  /** 0 when the interface is device-to-host only, as the keyboard is. */
  val packetSizeOut: Int,
  val identifiedBy: String,
) {
  companion object {
    /** Identified from its report descriptor. The only trustworthy answer. */
    const val BY_USAGE_PAGE = "usagePage"
  }
}
