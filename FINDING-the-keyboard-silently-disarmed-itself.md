# The Bluetooth keyboard silently disarmed itself

Found 2026-09-13, immediately after the HID descriptor fix made the link work
for the first time. Typing a literal string with "Send this text" worked;
pressing a slot on the key typed nothing, with every indicator saying it should.

## What it looked like

- banner: `connected`, `typing to NITRO16`
- Typing section: on screen, which only happens when `state === 'connected'`
- "Stop typing to the host": showing, so `typing` was true
- press a slot on This Key: nothing reaches the host, `sent` does not move

Nothing anywhere said the forwarder had stopped, because nothing on screen was
derived from the thing that had changed.

## Why

Forwarding is gated on two refs (`src/hooks/useBtKeyboard.ts`):

    if (!typingRef.current || !connectedRef.current) return;

`connectedRef` had two writers.

The first is the native connection callback, through `onStatus`. It is
coherent: it sets the ref, sets `state`, and on disconnect also disarms typing,
so the ref, the banner and the switch can never disagree.

The second was `refreshHosts`, on a three-second poll:

    const live = list.find(h => h.connected);
    connectedRef.current = Boolean(live);      // <- demotes
    if (live) { setState('connected'); ... }   // <- but only ever promotes state

That asymmetry is the bug. On a poll that found no live host it cleared the ref
and touched nothing else - not `state`, not `typing`, not `host`. So the
forwarder died while every visible sign of it stayed exactly as it was.

And the two sides do not mean the same thing. `hosts()` builds its `connected`
flag from the profile's `connectedDevices`
(`android/app/src/main/java/com/okrn/btkbd/NativeBtKeyboardModule.kt:337-343`).
What actually sends is `currentHost()` - the device the connection callback
handed us, kept in `host` (`:307-308`). Measured here: `connectedDevices` came
back empty while `currentHost()` was live and `sendReport` still succeeded. One
of them was wrong about the world, and it was not the one doing the sending.

## Fixed

`refreshHosts` may now only PROMOTE. It still exists, and it still earns its
keep - a connection made while the app is re-registering, or before the screen
mounts, arrives with no callback at all, and this is what notices. It just no
longer claims to know about disconnection, which it was never in a position to
know about.

Disconnection keeps its single authority: the callback, which moves the ref,
the banner and the switch together.

Separately, `setTyping(true)` against no host used to be a silent no-op - the
switch flipped itself back off and said nothing. It now sets `error`.

## The shape, again

Third time this week that a control was contradicted by state nothing on screen
was derived from - see
`FINDING-a-locked-key-showed-a-green-led.md` and
`FINDING-a-hard-key-override-outlives-the-hard-key.md`. The pattern worth
naming: when two writers disagree about one fact, the one that can act on it is
the one that is right, and the other should not be allowed to overrule it.
