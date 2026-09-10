# The USB stack claims ONE interface, and almost everything the app does is on a different one

**Where:** `android/app/src/main/java/com/okrn/usb/UsbHostTransport.kt:47-127`,
`android/app/src/main/java/com/okrn/usb/HidTransport.kt`,
`src/transport/UsbHid.ts`
**Status:** NOT FIXED. This is what §4 of the plan is for; written down first
because the shape of the problem is not what the plan assumed.

## What the device actually exposes

From the firmware's own descriptors, `OnlyKey-Firmware/.../usb_desc.h:319-350`
and `usb_desc.c:720-895`:

| USB interface | what | class / sub / proto | endpoints | IN size |
|---|---|---|---|---|
| 0 | Keyboard | 03 / 01 / 01 (boot) | 1, IN only | 8 |
| 1 | RawHID, usage page `0xF1D0` | 03 / 00 / 00 | 2 | 64 |
| 2 | RawHID2, usage page `0xFFAB` | 03 / 00 / 00 | 2 | 64 |
| 3 | SEREMU | 03 / 00 / 00 | 2 | 64 TX / 32 RX |

Interface 1 is FIDO. **Interface 2 is the vendor interface** - `OKSETPIN`,
`OKSETSLOT`, `OKGETLABELS`, `OKSETPRIV`, `OKRESTORE`, every preference, and the
whole PIN bracket. Interface 0 is where a slot's password and a backup file
arrive. Interface 3 is the debug console.

SEREMU is compiled out of a production build, so a production key enumerates
three interfaces rather than four. Vendor is still 2.

The library's `IFACE` constants are these exact numbers, deliberately - see
`ok-rn/android/okemu/src/ok_hal.h:170-185`, which says so.

## The problem

`HidTransport` is a single byte pipe:

```kotlin
fun write(bytes: ByteArray): Int
var onData: ((ByteArray) -> Unit)?
```

No interface, in either direction. `UsbHostTransport.open()` claims exactly one
interface and runs one read loop over its IN endpoint.

**So over real USB the app can speak CTAPHID and nothing else.** It cannot set a
PIN, read a label, write a slot, load a key, restore a backup, or read the
console. Every one of those is interface 2.

`src/transport/UsbHid.ts` sits on top and is CTAPHID-framed end to end -
`Assembler`, `frame()`, `sendMessage({cid, cmd, payload})`. There is nowhere for
a vendor report to enter or leave.

That is why it satisfies one of the six methods in
`node-onlykey-lib/src/transport/contract.js`: `open`, `close`, `isOpen` and
`write` exist under other names, and `request` has no counterpart. The plan
counted the missing methods; the missing INTERFACES are the reason.

## And the one it does claim is chosen by a tie-break

`selectInterface()` scores each candidate:

```kotlin
if (iface.interfaceClass == UsbConstants.USB_CLASS_HID) score += 100
if (iface.interfaceSubclass == 0 && iface.interfaceProtocol == 0) score += 50
if (maxIn >= PREFERRED_REPORT_SIZE) score += 200   // 64
if (hasOut) score += 25
score += maxIn
```

Against the table above:

| interface | score |
|---|---|
| 0 keyboard | 100 + 0 + 0 + 0 + 8 = **108** |
| 1 FIDO | 100 + 50 + 200 + 25 + 64 = **439** |
| 2 vendor | 100 + 50 + 200 + 25 + 64 = **439** |
| 3 SEREMU | 100 + 50 + 200 + 25 + 64 = **439** |

**A three-way tie.** Kotlin's `maxByOrNull` returns the FIRST element holding
the maximum, so the winner is interface 1 - decided by the order the descriptors
happen to be in, not by anything the scoring measures. It is the right answer
today for a CTAPHID-only client, and nothing in the code says why. Reorder the
descriptors and it silently claims SEREMU.

The comment above it says it is scoring to avoid landing on the keyboard, and it
does achieve that. What it cannot do is tell the two 64-byte RawHID interfaces
apart, because **class, subclass, protocol and endpoint sizes are identical on
both**. The only thing that distinguishes them is the HID usage page in the
REPORT descriptor - `0xF1D0`/`0x01` for FIDO against `0xFFAB`/`0x02` for vendor -
which this code never fetches.

## What §4 has to do differently

Not "add `request` to UsbHid.ts". The native layer has to:

1. **Claim every interface it needs**, not one. `UsbDeviceConnection` can hold
   several claimed interfaces at once.
2. **Carry the interface number in both directions** - `write(iface, bytes)` and
   `onData(iface, bytes)` - so the numbers the library already uses survive the
   crossing.
3. **Identify the two RawHID interfaces by USAGE PAGE**, by fetching each
   report descriptor over control transfer (`GET_DESCRIPTOR`, type `0x22`)
   rather than by scoring endpoints that are identical. Falling back to
   descriptor order is a guess and should say so if it is used.
4. **Run one read loop per IN endpoint.** Four interfaces, four threads, or one
   with a poll across them.

Then `plugins/transport/usb.js` is the same shape as
`plugins/transport/embedded.js`: the host supplies a pipe
(`start`/`stop`/`isRunning`/`write`/`on('stream')`) and the plugin does the
demultiplexing and normalisation, so the next host does not reimplement half the
contract subtly differently.

## How this was found

By reading, not by measuring - there is no physical key on this bench, so
nothing here has been observed on a wire. The descriptor table and the scoring
arithmetic are both determinate, and the tie is arithmetic rather than an
observation. **The claim that a real OnlyKey enumerates in this order is NOT
verified**; it is what the firmware asks the USB stack to build.
