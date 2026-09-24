package com.okrn.fido

import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattService
import java.util.UUID

/**
 * The OnlyKey VENDOR interface, offered over GATT.
 *
 * ## Why a second service rather than more of the FIDO one
 *
 * The FIDO service carries CTAP, and the firmware serves only four OnlyKey
 * operations on that path - OKPING, OKCONNECT, OKSIGN, OKDECRYPT
 * (fido2/solo.cpp). Everything else the device can do - slots, labels,
 * preferences, key loading, backup, restore, config mode - is `recvmsg` on the
 * VENDOR interface and is unreachable from FIDO. A host driving a key the way
 * `python-onlykey` does needs that interface, so it needs its own service.
 *
 * ## Why it lives in this file
 *
 * `NativeFidoGattModule` is 1491 lines of bus plumbing that took a long time to
 * get right: the advertiser and its watchdog, the notify pacing, the descriptor
 * handler Windows discovery depends on, the process-scoped `Held` state. None
 * of that is FIDO-specific and none of it should be duplicated - so the vendor
 * service SHARES that server and contributes only its own shape, here. The
 * module gained a registration seam and nothing that knows what a vendor
 * service is.
 *
 * Deleting this file and its one `registerExtraService` call removes the
 * feature.
 *
 * ## Not advertised, deliberately
 *
 * The advertisement is the device name plus the FIDO UUID, and it is 31 bytes
 * in total. A 128-bit UUID costs 18 of them and would overflow it
 * (`DATA_TOO_LARGE`), and Windows keeps a PnP device node PER SERVICE - a node
 * that comes and goes is one it stops trusting, which once cost the phone its
 * ability to be enumerated as a security key at all.
 *
 * A service does not need advertising to be usable: a central connects and
 * discovers the GATT table. A host looking for this scans for the FIDO UUID or
 * the device name, connects, and finds this service in the table.
 * ## Measured, 2026-09-24
 *
 * After a PURGE and a single fresh pairing with a Windows host - the only way
 * to test this, because Windows reads a device's service list once at bond
 * time and serves that cache forever afterwards:
 *
 * ```
 * Pixel 6a  24293486EAAF  - 25 cached nodes
 *   BR  0x1124   HID keyboard         cached
 *   LE  0xFFFD   FIDO authenticator   cached
 *   LE  0c0ffab0 OnlyKey vendor       cached
 * ```
 *
 * Three things at once: the vendor service is DISCOVERABLE without being
 * advertised - a central walked the GATT table on connect and kept it - and
 * neither the FIDO service nor the Classic keyboard was displaced by adding
 * it. Before the re-pair the same tool reported the vendor service MISSING,
 * which is the correct answer for a bond that predates it.
 *
 */
object VendorGatt {

  /**
   * Custom 128-bit UUIDs, NOT in the Bluetooth base range.
   *
   * `0000xxxx-0000-1000-8000-00805f9b34fb` is for UUIDs the SIG assigned -
   * FIDO's `0xFFFD` is one. Squatting a 16-bit value we were not given would
   * collide with whatever the SIG allocates next, so these are ordinary random
   * 128-bit UUIDs. `0c0ffab` is a mnemonic only: 0c-coder, and `ffab`, the
   * vendor HID usage page this carries.
   */
  val SERVICE_UUID: UUID = UUID.fromString("0c0ffab0-9f1e-4b1d-9c6a-0f0e1d2c3b4a")

  /** Host -> device. One OnlyKey report per message, fragmented if it must be. */
  val REQUEST_UUID: UUID = UUID.fromString("0c0ffab1-9f1e-4b1d-9c6a-0f0e1d2c3b4a")

  /** Device -> host, by notification. */
  val RESPONSE_UUID: UUID = UUID.fromString("0c0ffab2-9f1e-4b1d-9c6a-0f0e1d2c3b4a")

  /**
   * The command byte every vendor fragment is framed with.
   *
   * `CtapBleFramer` is transport-agnostic - `[CMD|0x80][HLEN][LLEN][data]` then
   * `[SEQ][data]` - and only its command CONSTANTS are FIDO's. The vendor
   * service reuses the framing and needs a byte to put in that slot, but it
   * carries one kind of thing and never varies: an OnlyKey report. So this is a
   * constant rather than a table, and the host checks it the way it would a
   * magic number.
   *
   * 0x83 is CTAP's MSG, deliberately - not because this is CTAP, but because
   * the two services never share a characteristic, so there is nothing for the
   * value to collide with and a familiar one is easier to read on a sniffer.
   * The assembler strips the 0x80 flag before handing a message up, so a host
   * sees 0x03.
   */
  const val CMD_REPORT: Int = 0x83

  /** The standard Client Characteristic Configuration descriptor. */
  private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

  /**
   * Two characteristics and nothing else.
   *
   * One direction each, and NOT a request/response pair - that reading was
   * written here first and it is wrong. `OKSETSLOT` answers nothing at all,
   * `OKGETLABELS` answers with a report per slot, and a host may read without
   * having written. Reports simply go up and down, the way they do over USB
   * HID.
   *
   * The HOST correlates, and already does: `pipeTransport.request()` subscribes
   * before writing and filters replies with a predicate, and python's
   * `read_bytes()` polls until its own timeout and returns an empty list when
   * nothing came. So the radio needs no channel ids, no keepalives and no
   * sequence numbers of its own - only to carry 64-byte reports faithfully.
   * That makes this simpler than the FIDO service, which has CTAPHID channels
   * to maintain.
   *
   * WRITE_ENCRYPTED on the request characteristic for the same reason the FIDO
   * control point uses it: it forces Android to demand a bond before the first
   * write, so this cannot be driven over a plaintext link.
   */
  fun build(): BluetoothGattService {
    val service = BluetoothGattService(
      SERVICE_UUID,
      BluetoothGattService.SERVICE_TYPE_PRIMARY,
    )

    service.addCharacteristic(
      BluetoothGattCharacteristic(
        REQUEST_UUID,
        BluetoothGattCharacteristic.PROPERTY_WRITE,
        BluetoothGattCharacteristic.PERMISSION_WRITE_ENCRYPTED,
      ),
    )

    val response = BluetoothGattCharacteristic(
      RESPONSE_UUID,
      BluetoothGattCharacteristic.PROPERTY_NOTIFY,
      BluetoothGattCharacteristic.PERMISSION_READ_ENCRYPTED,
    )
    /*
     * A notify characteristic without a CCCD cannot be subscribed to. The
     * module's onDescriptorRead/WriteRequest answer this one as they answer
     * FIDO's - per characteristic, since that state stopped being a single
     * boolean when this service was made possible.
     */
    response.addDescriptor(
      BluetoothGattDescriptor(
        CCCD,
        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
      ),
    )
    service.addCharacteristic(response)

    return service
  }
}
