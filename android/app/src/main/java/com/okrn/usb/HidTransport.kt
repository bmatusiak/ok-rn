package com.okrn.usb

/**
 * A byte pipe to the hardware.
 *
 * Two implementations back this: [UsbHostTransport] talks to real hardware over
 * OTG via UsbManager, and [TcpTransport] talks to tools/hardware-emulator.js so
 * the app can be developed on an emulator, which cannot pass through USB
 * endpoints. See EXPLAINER/emulator-testing(android).md.
 */
interface HidTransport {
  /** 'usb' or 'tcp'; surfaced to JS on every status event. */
  val name: String

  /** Endpoint max packet size once open; the fixed report width to expect. */
  val packetSize: Int

  fun isOpen(): Boolean

  /**
   * Opens the pipe and starts the read loop. Blocking - callers run it off the
   * JS thread. Throws on failure.
   */
  fun open(vendorId: Int, productId: Int)

  fun close()

  /** Writes one report. Returns bytes written, or -1 on failure. */
  fun write(bytes: ByteArray): Int

  /** Called for every inbound report. Set before [open]. */
  var onData: ((ByteArray) -> Unit)?

  /** state is one of: connecting, connected, disconnected, error. */
  var onStatus: ((state: String, message: String) -> Unit)?
}
