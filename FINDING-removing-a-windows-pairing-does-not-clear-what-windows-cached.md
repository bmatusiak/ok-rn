# Removing a Windows pairing does not clear what Windows cached

**Severity:** high — it produces a bug that appears to fix and break itself,
crediting and blaming unrelated changes. Two days went into the resulting loop.
**Status:** handled — the phone's record is now durable, and both halves are
measurable from the host (`tools/btcache.js`, `tools/btpurge.ps1`).
**Applies to:** Windows 11 host / Bluetooth Classic HID. Not a firmware defect
and not, in the end, an Android one either — a host caching rule that makes an
app-side bug invisible and intermittent.

## The symptom

The phone publishes a Bluetooth keyboard and a BLE FIDO authenticator. Fixing
one appeared to break the other, repeatedly, in both directions. Every session
ended with one working and one not, and the next day's first test disagreed
with the last one of the night before.

The framing was wrong, and that is why it never closed.

## The two roles share nothing

- **Authenticator:** BLE. A GATT server advertising FIDO `0xFFFD`
  (`NativeFidoGattModule.kt`).
- **Keyboard:** Bluetooth **Classic**. `BluetoothHidDevice.registerApp()` with
  an SDP record (`NativeBtKeyboardModule.kt`). Not HOGP, not LE, and it never
  touches a `BluetoothGattServer`.

Different transports, different databases, no shared object. Neither can break
the other, so every hypothesis of the form "the GATT server is clobbering the
HID profile" was chasing something that does not exist.

## What was actually happening

**1. Windows reads a Classic SDP record once, at bond time.**

Not on connect, not on reconnect — at bond. Whatever the record said then is
what that bond is, permanently. If the phone's HID record was absent at that
moment, the host has a phone with no keyboard and nothing the app does
afterwards can add one.

**2. The phone was deleting its own record constantly.**

`NativeBtKeyboardModule.invalidate()` called `unregisterApp()`, which removes
the SDP record from the adapter. `invalidate()` runs on **every JS bridge
teardown** — a Metro reload, a rotation, an activity restart. In development
the record was therefore absent more often than it was present.

The authenticator never suffered this: `NativeFidoGattModule` already holds its
GATT server in a process singleton that outlives the bridge, and says so at
`:208-216`. **One role durable, one not.** That asymmetry, not a conflict, is
the whole bug — and it is what made the two look coupled, because whichever one
you had just touched was the one whose bond you had most recently re-made.

**3. "Remove device" does not undo a bond.**

This is the part that keeps the loop closed, and it is why the fix already
written down in
`FINDING-a-published-keyboard-is-neither-visible-nor-reusable.md` — *"remove the
old pairing, then add the phone again"* — kept appearing not to work.

Settings → Bluetooth → Remove device drops the bond and **leaves the cached
service nodes behind**. Measured on the bench PC for one Pixel 6a:

| Store | Holding |
|---|---|
| `Enum\BTHENUM` | 32 nodes |
| `Enum\BTHLEDEVICE` | 12 nodes |
| `Enum\BTHLE` | 3 nodes |
| `Services\BTHPORT\Parameters\Devices\<mac>` | the link key — **owned by SYSTEM**, so an elevated Administrator is still refused |

The bond and the cache are cleared by different means and on different
schedules. Re-pair, and Windows re-attaches the old cached service list rather
than re-reading SDP. So a "clean" re-pair is not clean, and the state that
comes back depends on when each store last happened to be emptied — which is
what produced results that changed overnight with no code change at all.

## The evidence, from both machines

Windows, before any fix — `0xFFFD` cached, **`0x1124` absent**:

```
Pixel 6a  24293486EAAF  — 20 cached nodes
  BR  0x1124  HID keyboard         MISSING
  LE  0xFFFD  FIDO authenticator   cached
```

The phone at the same moment, every three seconds:

```
btkbd: connecting: asking NITRO16 to connect
btkbd: disconnected: NITRO16 is not connected
```

The keyboard was registered and offering itself. Windows had nowhere to attach
it and dropped the connection each time. Neither side reported an error: the
phone said "registered", the host said nothing at all.

## Why it was so hard to see

Every signal available in the app was honest and useless. `registerApp()`
returned true, `onAppStatusChanged` said `isRegistered`, the Bluetooth screen
read "registered" — all true statements about the phone, none of them a
statement about the host. The one fact that mattered lived on the other machine
and had no API on this one.

That is the general shape worth remembering: **when a feature depends on what a
peer cached, the local state is not evidence.** It cannot distinguish "working"
from "the peer is ignoring us", and it will report success in both cases.

## What was changed

- `NativeBtKeyboardModule` now keeps the proxy, the registered flag, the host,
  the state, the worker and the profile callback in a `Held` process singleton,
  exactly as the FIDO module does. `invalidate()` drops the JS pointer and
  nothing else; `unregisterApp()` is reachable only from `unregister()`, which
  the master switch calls.
- `tools/btcache.js` — read-only, reports what the **host** has cached per
  service. The verdict on whether this works comes from here, never from the
  app.
- `tools/btpurge.ps1` — clears all three stores for one device: the PnP nodes
  via `pnputil` including ghosts, the SYSTEM-owned bond key via a
  scheduled-task hop, then `bthserv` and the radio so the cleared state is
  re-enumerated.

## The order that matters

A one-sided purge re-bonds from the other side's copy and caches whatever
happens to be up at that moment, which is how the original problem was created.

1. Purge on the host.
2. Forget the host on the phone.
3. Confirm **both** roles are live on the phone before bonding.
4. Pair once — both get cached together.
5. `node tools/btcache.js <mac>` — expect `0x1124` **and** `0xFFFD`.

Step 5 is the only step that cannot be fooled.

## A note on the two days

Three separate things had to be true at once for this to make sense: that the
roles are on different transports, that the phone was deleting its own record
on reload, and that the host's cache survives the removal that is supposed to
clear it. Any two of them without the third still produces contradictory
results, which is exactly what a fix-and-break loop looks like from inside.
