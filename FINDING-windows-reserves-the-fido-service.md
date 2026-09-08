# Windows reserves GATT service 0xFFFD for its own WebAuthn stack

**Severity:** none — this is Windows working as intended
**Status:** understood; it bounds how the BLE path can be tested
**Applies to:** the test harness, not the app

## What happens

A desktop process cannot enumerate the characteristics of the FIDO service on a
paired BLE device. Not because of pairing, connection state, or permissions —
those were all checked and all fine:

```
device:   Galaxy A13 5G
access:   1            (DeviceAccessStatus.Allowed)
paired:   True
conn:     1            (Connected, session active, MTU 517)
```

With the link up and the service object in hand, the same code applied to each
of the three services the phone offers:

```
00001801-0000-1000-8000-00805f9b34fb  status=0 (Success), 4 chars
00001800-0000-1000-8000-00805f9b34fb  status=0 (Success), 3 chars
0000fffd-0000-1000-8000-00805f9b34fb  status=3 (AccessDenied), 0 chars
```

Two services answer, the FIDO one refuses. Every route was tried while
connected — `GetCharacteristicsAsync`, `GetCharacteristicsForUuidAsync`, after
`RequestAccessAsync` (which returns Allowed), reopening the service by id in all
three `GattSharingMode`s, and with `GattSession.MaintainConnection` set. All
`AccessDenied` or `None`.

This is deliberate. Windows' WebAuthn implementation owns FIDO authenticators,
and letting an arbitrary application talk to `0xFFFD` would let it drive
somebody's security key. The OS claims the service and hands it to nothing else.

## Why it took a while to see

Because it presents as several different problems in turn, and the earlier ones
were real:

1. **A genuinely stalled connection.** `onDescriptorReadRequest` was not
   answered, so discovery hung. That was ours, and it is fixed —
   [see the finding](FINDING-descriptor-read-stalls-every-connection.md).
2. **A poisoned host cache.** The stall left Windows holding a service table
   containing only `0x1800`/`0x1801`, which it kept serving afterwards.
   Re-pairing cleared it.
3. **"Not connected."** `GattDeviceService.FromIdAsync` returns `None` whenever
   the device is not currently connected, and Windows does not connect on its
   own. Asking the *device* for its services is what brings the link up;
   opening the service id directly never will.

Only with all three out of the way does the actual answer appear, and it is not
a fault at all.

## What it means for testing

**The BLE path cannot be exercised by a script on Windows.** The scripted
central was the right instinct — a browser reports one opaque failure for a
dozen causes, and it found the descriptor stall that a browser never would —
but it can go no further than the service boundary.

What it did establish, and this is worth keeping:

- the phone advertises `0xFFFD` and Windows finds it,
- pairing succeeds and the service appears in the GATT table at handle 134,
- a connection completes and negotiates a 517-byte MTU,
- discovery finishes rather than hanging.

Everything up to the point Windows takes over is verified. The remaining
untested piece is the fragment pacing, and the only client that can reach it is
the platform WebAuthn API — that is, a browser doing a real registration.

That is not a workaround. It is the thing the bridge exists for.
