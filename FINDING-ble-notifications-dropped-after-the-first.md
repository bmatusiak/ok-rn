# Every BLE fragment after the first was dropped

**Severity:** blocking — no CTAP2 response has ever reached a host intact
**Status:** fixed — `respondToRequest` now paces on `onNotificationSent`
**Applies to:** ours — `android/app/src/main/java/com/okrn/fido/NativeFidoGattModule.kt`

## What happened

`respondToRequest` fragmented the response and fired every fragment in a loop:

```kotlin
val fragments = CtapBle.fragment(command, payload, maxFragmentSize())

for (fragment in fragments) {
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    server.notifyCharacteristicChanged(device, status, false, fragment)
  } else {
    status.value = fragment
    server.notifyCharacteristicChanged(device, status, false)
  }
}
promise.resolve(null)
```

**Android permits one outstanding notification per connection.**
`notifyCharacteristicChanged()` hands a fragment to the stack and returns; the
next may only go out once `onNotificationSent()` reports the previous one
delivered. `BluetoothGattServerCallback.onNotificationSent` was not overridden,
so nothing paced the loop and everything after the first fragment was discarded
by the stack.

`promise.resolve(null)` then told JS the response had been sent.

## Why it is blocking rather than a limitation

Measured on the device, through the bridge, against the real firmware:

| response | bytes | fragments at a 23-byte MTU |
|---|---:|---:|
| `authenticatorGetInfo` | 127 | **7** |
| `authenticatorMakeCredential` | 1031 | **~55** |

A default ATT MTU is 23 bytes: 20 of payload, 17 after the three-byte CTAP BLE
initialisation header, 19 per continuation. So a host received the first 17
bytes of `getInfo` and nothing further — on the very first thing any browser
asks. Nothing longer than one fragment had ever worked, which is to say nothing
had ever worked.

MTU negotiation does not rescue it. Even at a negotiated 512 the
`makeCredential` response above still needs three fragments.

## How it presented

As the host timing out, which reads as an authenticator that never answered.
Every layer on the phone reported success: the loop completed, the promise
resolved, the log said the response was sent. The only place the truth existed
was in the stack, which discards a notification with no error to anyone.

It was never observed at all, because until this chunk nothing on the phone
could produce a real CTAP2 response — the screen replied `00a0` (status OK and
an empty CBOR map) to every command, which is two bytes and fits in one
fragment. The bug was invisible for exactly as long as the code was a stub.

## The fix

A queue paced by the callback. `respondToRequest` enqueues the fragments and
sends the first; `onNotificationSent` sends the next; the promise resolves when
the queue drains, so JS learns the response actually went out rather than that
it was handed to a loop.

Three things fall out of doing it that way and are worth stating, because each
is a failure mode the loop did not have:

- **One response at a time.** Two overlapping ones would interleave their
  fragments, and the host reassembles by position — it would decode a message
  made of halves of two. A second `respondToRequest` is rejected while one is
  in flight.
- **A dropped link must reject.** The promise resolves only on the last
  acknowledgement, so a queue abandoned without a rejection leaves JS awaiting
  a response it will never finish sending. `clearNotifications()` rejects.
- **The notify call happens outside the lock.** On some builds it can complete —
  and call `onNotificationSent` — before it returns, which would deadlock
  against the callback meant to release it.

## Also corrected, found in the same read

Two pieces of documentation in `specs/NativeFidoGatt.ts` that described code
which does not exist. Neither is a defect in behaviour; both misdirect whoever
is debugging, which is the expensive kind of wrong.

- The module comment said the CTAP2 handlers "are stubs that reject with
  `CTAP2_ERR_NOT_ALLOWED`". There is no such constant in the Kotlin and no path
  that auto-rejects — the native side never answers a command itself. Someone
  chasing an unanswered request would have gone looking in Kotlin for a
  rejection that was never there; the answer is that JS did not reply.
- `CtapRequestEvent.command` was documented as `0x84 CANCEL`. `0x84` is not a
  CTAP BLE command at all. The Kotlin has always had `0xbe`, per CTAP 2.1
  §11.2.9, and is right.

## Still unverified

The Kotlin half cannot be exercised without a central, so the pacing itself is
proven only by construction. What is proven on device is everything up to it:
the bridge carries a whole CTAP2 message to the firmware and brings back a real
127- and 1031-byte response (`__e2e_tests__/6-bridge.e2e.js`). The remaining
test is a desktop browser doing a WebAuthn registration against the phone.
