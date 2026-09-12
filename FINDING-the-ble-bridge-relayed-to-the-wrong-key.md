# The Bluetooth bridge relayed every ceremony to the soft key

Found 2026-09-11 by the user, trying a WebAuthn registration from a desktop
browser against the phone. The browser sat on "talking to key" and gave up.
Their first guess was the phone - "to be fair its the first time i tested on
pixel, i tested last on galaxy a13" - and it was never the phone.

## What was actually wrong

`useFidoGatt` asked for the ACTIVE key and always got the soft key, for the
life of the app, whatever was selected.

```ts
/* The ACTIVE key answers the browser, not whichever this file assumed. */
const getKey = useActiveKey();
const backend = useBackend();
```

The comment states the intent exactly. The code could not honour it. Both
calls read `KeyBackendContext`, and this hook is created at `App.tsx:108`
while `KeyBackendProvider` only wraps the tree from line 191 - so the reads
returned the context DEFAULT, `'embedded'`, always.

That ordering is not an accident and cannot simply be swapped:

```
useFidoGatt(...)      needs nothing
useKey({fidoPending}) needs fido.pending
<KeyBackendProvider backend={keys.backend}>   needs keys
```

The hook must exist before `useKey`, and the provider is fed from `useKey`.
A hook above a provider cannot read it.

## Why it took a user to find it

Nothing failed. Every layer reported success:

- the GATT server advertised, the desktop connected, MTU negotiated to 517
- the control point reassembled the request correctly
- the Pending panel said "Forwarding to the firmware"
- the bridge forwarded it - to the soft key
- the soft key, being locked (and on an earlier attempt in config mode),
  dropped the packets silently, because FIDO dispatch is gated on
  `unlocked == true` (okcore.cpp:639,651) and config mode answers only
  eleven message types (okcore.cpp:347)

The browser waited, retried four times, and gave up. The app showed a
ceremony in progress the whole time.

The e2e suite did not catch it either, and would not have: `6-bridge` tests
`createCtapBridge` directly against a transport it chooses itself. The
defect was in WHICH transport the app hands it, which no test looked at.

## The evidence that settled it

The app's own traffic panels, which show each key separately. With the header
reading "Hard Key / unlocked":

```
Hard Key   only kbd traffic - not one fido line
Soft Key   fido ff ff ff ff 86 00 08 11 22 33 44 55 66 77 88   ×4
```

CTAPHID_INIT going to the key that was not selected. On the earlier attempt
the soft key's reply was visible too: `ERROR NOT SUPPORTED IN CONFIG MODE`.

## The same bug, twice

`confirm()` had it as well. It branched on `backend === 'usb'` to decide
whether to press through the key's console or natively - and `backend` was
the same stale default, so confirming a HARD key ceremony pressed the SOFT
key's button. Nobody had noticed, because nobody had got far enough into a
ceremony to press confirm.

## The fix

The hook takes `getKey` and `getBackend` as parameters instead of reading
context. App passes stable callbacks that read a ref updated from
`keys.backend` each render - stable identity so nothing re-subscribes, current
value at the moment a browser actually asks.

`fidoBridge` also cached its bridge as `if (bridge) return bridge`, binding
the relay to whichever key was active at the FIRST request and keeping it
there. It now compares the transport object and rebinds when it differs,
logging that it did.

## Verified

A registration from a desktop browser, on the hard key, immediately after:
a 239-byte makeCredential reassembled from fragments carrying the relying
party, the algorithm list, `rk` and `credProtect`. Before the fix the same
ceremony never got past a one-byte getInfo sent to the wrong key.

## The rule this is an instance of

A hook that reads context is making a claim about where it sits in the tree.
Nothing checks that claim, and when it is wrong the value is not an error -
it is the default, which is a plausible answer. Both failures here were a
plausible wrong answer, which is why they survived a comment that described
the right one.
