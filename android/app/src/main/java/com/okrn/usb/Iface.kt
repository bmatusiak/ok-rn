package com.okrn.usb

/**
 * Which OnlyKey interface a report belongs to, and how to tell them apart.
 *
 * TRANSCRIBED FROM `node-onlykey-lib/src/transport/usbDescriptors.js`, which is
 * the canonical statement and cites the firmware it came from
 * (`usb_desc.h` / `usb_desc.c`, the `USB_ONLYKEY` block). Anyone porting this
 * to another platform should read that file rather than this one: it carries
 * the reasoning, and it is testable without a device.
 *
 * ## Why identification is by USAGE PAGE and nothing else
 *
 * The device exposes four HID interfaces. Three of them are IDENTICAL in
 * interface class (3, HID), subclass (0), protocol (0) and endpoint width (64
 * bytes in). Nothing in the interface descriptor separates them.
 *
 * The previous implementation scored those attributes and picked the highest.
 * FIDO, VENDOR and SEREMU all scored the same, and Kotlin's `maxByOrNull`
 * returns the first maximum - so the winner was decided by the order the device
 * happened to enumerate in. It picked the right one, by luck, and nothing
 * anywhere said that was what had happened.
 *
 * The usage page lives in the REPORT descriptor, which is a separate control
 * transfer. Fetching it is the only way to be sure, and a failure to fetch it
 * must be a refusal rather than a fallback - see `Descriptor.identify`.
 *
 * ## Why these numbers match the library's
 *
 * `IFACE` in the library is 0 keyboard, 1 FIDO, 2 vendor, 3 SEREMU -
 * deliberately the same numbers the firmware assigns its interfaces, so a
 * transport passes them through unchanged. That is a convenience, not a law:
 * the mapping below is still done by usage page, because a device enumerating
 * in a different order would still be that device.
 */
object Iface {
  const val KEYBOARD = 0
  const val FIDO = 1
  const val VENDOR = 2
  const val SEREMU = 3

  /** For logs and status messages. Unknown stays a number rather than a guess. */
  fun name(iface: Int): String = when (iface) {
    KEYBOARD -> "keyboard"
    FIDO -> "fido"
    VENDOR -> "vendor"
    SEREMU -> "seremu"
    else -> "iface$iface"
  }
}

/**
 * One interface as the firmware declares it.
 *
 * `endpointOut == 0` means device-to-host only, which is true of the keyboard.
 * SEREMU is ASYMMETRIC - 64 in, 32 out - and that is a real constraint on
 * writes rather than a transcription slip.
 */
data class IfaceSpec(
  val iface: Int,
  val usagePage: Int,
  val usage: Int,
  val endpointIn: Int,
  val endpointOut: Int,
  /**
   * Whether a session can be built without it.
   *
   * KEYBOARD is required because CAPTURING it is a goal in its own right: a
   * host that leaves it alone lets the key type into whatever Android window
   * has focus instead of into the app.
   *
   * SEREMU is the only optional one, and its absence is meaningful rather than
   * a fault - it is compiled out of a production build, so a production key
   * enumerates three interfaces and a developer key four.
   */
  val required: Boolean,
)

object Descriptor {
  /** The firmware's own table. See the class header for where it came from. */
  val ALL = listOf(
    IfaceSpec(Iface.KEYBOARD, 0x0001, 0x06, endpointIn = 8, endpointOut = 0, required = true),
    IfaceSpec(Iface.FIDO, 0xF1D0, 0x01, endpointIn = 64, endpointOut = 64, required = true),
    IfaceSpec(Iface.VENDOR, 0xFFAB, 0x02, endpointIn = 64, endpointOut = 64, required = true),
    IfaceSpec(Iface.SEREMU, 0xFFC9, 0x04, endpointIn = 64, endpointOut = 32, required = false),
  )

  /** VID and PID the firmware declares. Matches `res/xml/device_filter.xml`. */
  const val VENDOR_ID = 0x1D50
  const val PRODUCT_ID = 0x60FC

  /**
   * The control transfer that fetches a report descriptor.
   *
   * Standard GET_DESCRIPTOR, aimed at an INTERFACE:
   *
   *   requestType 0x81    IN | standard | recipient interface
   *   request     0x06    GET_DESCRIPTOR
   *   value       0x2200  descriptor type 0x22 (REPORT), index 0
   *   index       the bInterfaceNumber being asked about
   *
   * The device answers exactly this - `usb_dev.c` handles the request type and
   * `usb_desc.c` keys its lookup on `{value: 0x2200, index: bInterfaceNumber}`.
   * Asking for more bytes than the descriptor holds is safe: the firmware
   * clamps its reply to the true length rather than stalling.
   *
   * Android has no constant for the interface recipient, so 0x01 is a literal
   * here; `UsbConstants.USB_DIR_IN` is 0x80 and `USB_TYPE_STANDARD` is 0x00.
   */
  const val REQUEST_TYPE_GET_DESCRIPTOR_INTERFACE = 0x81
  const val REQUEST_GET_DESCRIPTOR = 0x06
  const val DESCRIPTOR_TYPE_REPORT = 0x22
  const val REPORT_DESCRIPTOR_MAX = 256

  /**
   * The usage page and usage at the head of a HID report descriptor.
   *
   * Walks HID SHORT ITEMS rather than matching a byte prefix. A prefix match
   * works on today's descriptors and breaks the first time an item is inserted
   * ahead of the usage - a Report ID would do it - and that kind of change
   * arrives in a firmware update rather than in a code review.
   *
   * A short item's first byte is `bTag shl 4 or bType shl 2 or bSize`, where
   * bSize is a LENGTH INDEX: 0, 1 and 2 mean that many data bytes and 3 means
   * FOUR. The two items wanted are the global Usage Page (prefixes 0x05, 0x06,
   * 0x07) and the local Usage (0x09, 0x0A, 0x0B). Long items (prefix 0xFE)
   * carry their own length byte.
   *
   * Returns null for whatever was not found, so a caller can tell "no usage
   * page" from "usage page zero".
   */
  fun parseUsage(bytes: ByteArray, length: Int = bytes.size): Pair<Int?, Int?> {
    var usagePage: Int? = null
    var usage: Int? = null
    var i = 0
    val end = minOf(length, bytes.size)

    while (i < end) {
      val prefix = bytes[i].toInt() and 0xFF

      if (prefix == 0xFE) {                       // long item
        val size = if (i + 1 < end) bytes[i + 1].toInt() and 0xFF else 0
        i += 3 + size
        continue
      }

      val sizeIndex = prefix and 0x03
      val size = if (sizeIndex == 3) 4 else sizeIndex

      var value = 0
      for (b in 0 until size) {
        val at = i + 1 + b
        if (at < end) value = value or ((bytes[at].toInt() and 0xFF) shl (8 * b))
      }

      when (prefix and 0xFC) {
        0x04 -> if (usagePage == null) usagePage = value   // global usage page
        0x08 -> if (usage == null) usage = value           // local usage
      }

      if (usagePage != null && usage != null) break
      i += 1 + size
    }

    return Pair(usagePage, usage)
  }

  /**
   * Which interface a report descriptor belongs to, or null when nothing
   * matches.
   *
   * NULL IS NOT A PROBLEM TO PAPER OVER. A caller that cannot identify an
   * interface must leave it alone and say so. Sending the vendor protocol to
   * the security-key interface produces a timeout on every request and an error
   * that blames the device.
   */
  fun identify(usagePage: Int?, usage: Int?): IfaceSpec? =
    ALL.firstOrNull { it.usagePage == usagePage && it.usage == usage }

  fun spec(iface: Int): IfaceSpec? = ALL.firstOrNull { it.iface == iface }
}
