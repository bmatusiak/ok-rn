# The Bluetooth keyboard bridge died with its screen

Measured on the bench phone, 2026-09-13.

## What happened

Connect a host on the Bluetooth tab, arm typing, then go to This Key and press
a button. Nothing reaches the host - and nothing reports a problem, because
from the Bluetooth screen's point of view everything was still connected.

## Why

`useBtKeyboard` holds the forwarder: a subscription to the active key's
`IFACE.KEYBOARD` frames that turns each report into `sendReport` over
Bluetooth. It was called from `BtKeyboardScreen` and nowhere else, so that
subscription lived exactly as long as that screen was mounted.

Which made the obvious use impossible. Registering, connecting and arming all
happen on the Bluetooth tab - and then you LEAVE, because the buttons are on
This Key and the slots are on Slots. Leaving took the forwarder with it.

Nothing else about the feature was screen-scoped. `register()` and
`unregister()` are explicit actions on the native module and survive
navigation; so does the connection. The listener was the one piece whose
lifetime was wrong, and it was the piece carrying the characters.

## Fixed

`src/hooks/BtKeyboardContext.tsx` holds one `useBtKeyboard()` for the app, and
`BtKeyboardScreen` reads that instance. Mounted INSIDE `KeyBackendProvider`,
because the forwarder reads `useBackend()` to pick which key's stream to listen
on - outside it, the bridge would forward the wrong key's typing.

The provider throws rather than falling back to its own hook instance: a second
instance would forward every report twice and show a `sent` count that is not
the one doing the work.

## Also added

`src/btTestText.ts` and a "Send this text" field, because the only way to test
the link was to press a slot and type its real contents into whatever window
had focus. That is a bad way to debug a link and a worse way to do it on
someone's own computer. The encoder is US-layout ASCII and explicitly NOT how
the key types - the key's own reports are still forwarded byte for byte.

## Not the whole story

The link to the Windows host still does not connect at all, for a different
reason - see FINDING-the-bluetooth-keyboard-advertises-as-a-phone.md. This fix
was necessary and is not sufficient.
