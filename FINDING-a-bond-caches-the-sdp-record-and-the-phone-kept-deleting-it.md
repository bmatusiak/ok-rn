# A bond caches the SDP record, and the phone kept deleting it

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

**3. Only a new bond can fix it, and that is easy to get wrong.**

Because (1) and (2) together mean the cure is always *pair again*, and the cure
only works if the record happens to be published at that moment. Re-pair while
the app is reloading and the new bond is as empty as the old one — so the fix
looks like it failed, and whatever was changed next got the blame.

The stores Windows keeps, for one device, measured on the bench PC:

| Store | Holds |
|---|---|
| `Enum\BTHENUM`, `Enum\BTHLEDEVICE`, `Enum\BTHLE` | the cached service list — **cleared** by Remove device |
| `Services\BTHPORT\Parameters\Devices\<mac>` | the link key — **survives** Remove device, and is owned by SYSTEM, so an elevated Administrator is still refused |

The service cache does clear. What lingers is the link key, which is the lesser
half — an orphaned key does not stop a fresh bond from re-reading SDP. See the
correction at the foot of this file: an earlier draft had this backwards.

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

Two things had to be true at once for this to make sense: that the roles are on
different transports, so neither could be breaking the other; and that the
phone was deleting its own SDP record on reload, so the cure — pair again — only
worked when it happened to be applied at a lucky moment. Either one alone
produces a coherent-looking wrong theory, which is what a fix-and-break loop
looks like from inside.

A third claim was in the first draft and was wrong; the correction below says
so. It is left visible rather than deleted, because a finding that quietly
edits its own evidence is worth less than one that shows where it went.

---

## Correction, same day — claim 3 was overstated

The heading above originally read *"Remove device does not undo a bond"*, and
the text asserted that removing the device leaves the cached service nodes
behind. **That was not measured. It was inferred, and it is wrong.**

What was actually measured was 47 Enum nodes for a device that was **still
paired** — which is simply a live cache, not a stale one. The inference filled
in the rest.

When the pairing was then removed for real:

| Store | After "Remove device" |
|---|---|
| `Enum\BTHENUM` / `BTHLEDEVICE` / `BTHLE` | **0 nodes** — cleared |
| `BTHPORT\...\Devices\<mac>` | still present — the link key outlives the removal |

So Windows does clear the service cache. What it keeps is the **link key**,
which is the lesser half: an orphaned key does not stop a fresh bond from
re-reading SDP.

**The finding's conclusion is unchanged, because it never needed claim 3.** The
two measured facts are sufficient on their own:

- the host reads the SDP record once, at bond time, and
- the phone was deleting that record on every JS bridge teardown.

A bond formed in one of those windows has no keyboard, permanently, and the
only way out is to pair again. That fully explains the fix-and-break loop
without any claim about what removal leaves behind.

`tools/btpurge.ps1` is still worth having — it clears the link key, which
nothing in the UI does, and it makes "start from nothing" a single command
rather than a hope. It is just not the thing that was breaking this.

## Resolved

After the durability fix, a single pairing captured both roles:

```
Pixel 6a  24293486EAAF  — 22 cached nodes
  BR  0x1124  HID keyboard         cached
  LE  0xFFFD  FIDO authenticator   cached
```

First time the bond has ever held both.

## And one more thing the recovery found

Unpairing bounced the Bluetooth stack, and the keyboard did not come back:

```
btkbd: unregistered: the Bluetooth service went away
```

`onServiceDisconnected` nulled the proxy and stopped. The authenticator rode
the same bounce out because it has a watchdog; the keyboard had nothing, so a
stack bounce silently ended it until someone restarted the app — and that is
precisely the window in which the next bond caches a phone with no keyboard.

`Held` now records the INTENT (`wantRegistered`) separately from the state, and
re-acquires the profile on both `onServiceDisconnected` and an adapter that
comes back on. Measured across a Bluetooth off/on:

```
23:21:43  unregistered: the Bluetooth service went away
23:21:43  unregistered: Bluetooth is off
23:21:50  adapter is back; republishing if it should be
23:21:50  registered: the keyboard is published
```

Seven seconds, no user action.

That same test exposed a smaller bug worth naming: `register()` answered
`unsupported — this device does not offer the HID Device profile` when the
radio was merely **off**. `unsupported` is terminal in the app, which stops
retrying, so four seconds of Bluetooth being off could latch a permanent lie
about the hardware. "Off" and "absent" are now different answers.
