# An unanswered descriptor read stalls the whole connection

**Severity:** blocking — no central could ever finish discovering the service
**Status:** fixed — `onDescriptorReadRequest` now responds
**Applies to:** ours — `android/app/src/main/java/com/okrn/fido/NativeFidoGattModule.kt`

## What happened

`BluetoothGattServerCallback.onDescriptorReadRequest` was not overridden. Its
default implementation **does nothing** — in particular it does not call
`sendResponse()`.

ATT permits exactly one outstanding request per connection. So the moment a
central reads a descriptor, it waits for a response that is never sent, and
every request behind it queues behind that one. The link stays up, the
connection parameters keep updating, and nothing else ever completes.

Windows reads the Status characteristic's Client Characteristic Configuration
descriptor while enumerating the service, so this fired on **every**
connection, during discovery, before a single CTAP byte could be exchanged.

## How it was measured

The phone's own Bluetooth stack, with a `bleak` central on a desktop driving it:

```
07:27:07.257  bta_gatts_conn_cback  connected=1
07:27:07.282  MTU request PDU with MTU size 517
07:27:07.282  bta_gatts_send_request_cback: trans_id=0, req_type=6   <- MTU
07:27:07.691  bta_gatts_send_request_cback: trans_id=1, req_type=1   <- read char
07:27:07.751  bta_gatts_send_request_cback: trans_id=2, req_type=1   <- read char
07:27:07.811  bta_gatts_send_request_cback: trans_id=3, req_type=2   <- read DESCRIPTOR
   ... thirty seconds of nothing ...
07:27:37.841  bta_gatts_conn_cback  connected=0
```

`req_type` values are BTA's: 6 is MTU, 1 is read-characteristic, 2 is
read-descriptor. The two characteristic reads were answered. The descriptor
read was not, and that is the last thing that ever happens on the connection.

On the host, `get_gatt_services_async()` simply never returns.

## How it presented

As a device that connects and dies. Everything that normally indicates health
was present and correct: the advertisement was found, the connection completed,
the MTU was negotiated up to 517, connection parameters were updated. Only
discovery hung.

A browser would report "no security key found", which covers this and a dozen
unrelated causes. That is why the test harness is a scripted BLE central rather
than a browser — it says which ATT transaction stopped.

## It poisons the host, which outlives the fix

Hosts cache what they discover. Windows materialises the cached table as PnP
device nodes:

```
BTHLE\DEV_7DE88BCF47C6
  BTHLEDEVICE\{00001801-...}_7DE88BCF47C6    Generic Attribute
  BTHLEDEVICE\{00001800-...}_7DE88BCF47C6    Generic Access
                                             <- no {0000FFFD-...}
```

The stall happened mid-discovery, so Windows kept the two mandatory services it
had already read and nothing else — and it serves that table on every
subsequent connection, including after the bug is fixed. `use_cached_services=
False` does not dislodge it, and neither does cycling Bluetooth on the phone:
the address is a resolvable private address that Windows maps back to the same
record.

Clearing it needs the device record removed, which is an elevated operation:

```
pnputil /remove-device "BTHLE\DEV_<address>\<instance>"
```

The classic pairing is a **separate** record under `BTHENUM\DEV_...` with a
different address, so removing the LE one does not unpair the phone for audio
or file transfer.

**This is the part worth remembering.** A protocol bug on a peripheral is not
confined to the peripheral: it can leave durable state on every host that met
it, and the fix will appear not to work until that state is cleared. Any future
BLE change wants testing against a host that has never seen the device.

## Fixed alongside

Two more, both found while chasing this.

**The Service Revision Bitfield was read-only.** CTAP 2.1 §11.2.5.4 has the
client *write back* the single version bit it selected, so a read-only
characteristic answers that with `WRITE_NOT_PERMITTED`. There is nothing to act
on with one version on offer, but the write has to be accepted.

**Advertising could start before the service was registered.**
`addService()` is asynchronous — it completes at `onServiceAdded()` — and
advertising was started immediately after the call. Measured at 29ms apart on
this handset: small, and not zero. A central connecting inside that window
discovers a table with only `0x1800`/`0x1801` and caches it, which is precisely
the poisoning above arriving by a second route. Advertising now waits for the
callback.
