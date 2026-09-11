# The LED is an output for a person, not a state report

Found 2026-09-11, by the user, looking at code that had been in the app for a
while: "you cant use LED to detect firmware state."

## What the app was doing

`useOkEmu` derived a `settling` banner from the emulated key's LED pixels:

```js
const pending = led.some(packed =>
  ((packed >> 16) & 0xff) > 64 && ((packed >> 8) & 0xff) > 64 && (packed & 0xff) <= 64);
```

Yellow, roughly. When it matched, every keypad in the app said:

> The key is busy — its LED is yellow while it finishes an operation, and it
> drops every press until the LED clears (up to 20 seconds).

## Why it is wrong

The premise is true and the inference is not. The firmware DOES set yellow
while it is throwing presses away - `OnlyKey.ino:522-525`, when
`pending_operation` is `CTAP2_ERR_DATA_READY` or `CTAP2_ERR_DATA_WIPE`, it
sets colour 45 and skips `payload(press_duration)` entirely.

But `setcolor(45)` is not that state. Grepping the firmware for it:

| where | what is actually happening |
|---|---|
| `OnlyKey.ino:524` | dropping presses - the one the app meant |
| `OnlyKey.ino:639` | **an ordinary button press**, every time |
| `okcore.cpp:7180` | typing a slot at the keyboard |
| `okcore.cpp:6318` | starting a backup |
| `OnlyKey.ino:759` | a PIN digit appended, in config mode |
| `OnlyKey.ino:771,787` | the same for the second and SD profiles |

Yellow does not imply dropping. So the banner appeared during entirely normal
use - most reliably while somebody was pressing buttons, which is exactly when
a keypad is on screen. The app told people their presses were being discarded
while the key was doing precisely what they had asked it to do.

A colour is a summary the firmware paints for a human standing in front of the
device. Six states share one colour because a person has the context to tell
them apart and three bytes do not. Reading the state machine back out of the
summary is reading the wrong direction.

## What it was replaced with

The signal the hard key already used, now applied to both backends: **the app
knows when it relayed a ceremony**, and the firmware's window is a fixed
twenty seconds from the end of one (`FINDING-presses-discarded-after-a-fido-ceremony`).
`useKey` owns that timer. It is narrower - it says nothing about a window the
app did not cause - but everything it says is true.

`led` is still reported and This Key still displays it. Showing the colour is
fine. Deciding from it is not.

## The general rule this is an instance of

Twice this session the app has been wrong by reading a signal meant for
something else: the CTAP2 status table transcribed from a shifted source, and
this. Both looked authoritative and both were checked against nothing. The
question worth asking of any derived state is not "does this correlate" but
"is this signal ALLOWED to mean anything else" - and for a user-facing
indicator the answer is almost always yes.

## Related, and NOT changed

`__e2e_tests__/helpers/ledSettled.js` (`waitForLedClear`) polls the same
pixels, used once by `8-keystrokes`. That is a test waiting for a device to go
quiet before it does something, not a claim made to a user - a heuristic that
waits too long is harmless where a banner that lies is not. Left alone, and
named here so the next person does not read its survival as endorsement.
