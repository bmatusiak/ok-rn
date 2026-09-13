# Reconnecting the Bluetooth keyboard was a chore

Not a defect - a missing decision. Written up because the workaround it forced
was being mistaken for the design.

## What it was like

Every time the app restarted - and it restarts on every Fast Refresh, every
`force-stop`, every Extreme Battery Saver pause - the HID registration went
with it, and the link came back `disconnected`. Getting it back meant:

1. publish the keyboard again, then
2. find the right row in Pairing and press Connect, or
3. go to the HOST and make it reconnect.

During this session (3) is mostly what happened, via
`pnputil /restart-device` on the Windows HID node, which needs administrator
and pops UAC. That is not a thing a user does, and it was never meant to be the
answer - it was a measuring instrument that got promoted to a procedure.

## Why the app could not just do it

Because it did not know where to type. A phone is bonded to a car, a headset
and three computers; exactly one of them is the thing a password should be
typed into, and nothing in `hosts()` distinguishes them. A keyboard that
auto-connects to whatever it finds first is a keyboard that types a slot into
the wrong machine, so auto-connect was correctly absent.

The missing piece was never the connecting. It was being told which host.

## Fixed

The Pairing list is now a radio selection - one chosen host, stored under
`ok-rn/bt-keyboard/host`. Choosing connects immediately, and while the keyboard
is published the existing three-second host poll retries that host, and only
that host, whenever the link is down.

It is deliberately narrow:

- no choice, no attempt - the app never guesses,
- only while published, so a withdrawn keyboard dials nothing,
- only while disconnected, because `connect()` on a live link is at best a
  no-op,
- it reads `busy` from a ref so the timer is not torn down and rebuilt on every
  attempt.

## Measured

Chose NITRO16, then `am force-stop com.okrn`, relaunched, published - and did
nothing whatever on the host:

    t+5s:  STATE_CONNECTED
    t+10s: STATE_CONNECTED
    ...
    t+30s: STATE_CONNECTED

Connected inside one poll interval and stayed. The choice survived the cold
restart, which is the whole point of storing it.

## The shape

Twice now the honest reason the app could not act was that nobody had told it
which thing to act on - here, and the hard-key override in
`FINDING-a-hard-key-override-outlives-the-hard-key.md`. Both looked like
missing automation and were actually a missing choice.
