# An unlocked key has no button press that means only "yes"

**Severity:** design constraint — it removes an option the plan had chosen
**Status:** open — upstream behaviour; the reveal gate is built differently
**Applies to:** upstream — `OnlyKey.ino:936-941`

## What was planned

Revealing a stored password on screen was to require a press on the key, "as on
hardware" — the idea being that the device never shows anything without a
touch, so neither should the app.

## Why it does not work

On an unlocked OnlyKey there is no press that does nothing. `payload()` ends at
the band dispatch, and every band types something:

```c
if (duration <= 20 && !configmode)               gen_press();   // types slot N
else if (duration >= 21 && duration < 90 ...)    gen_hold();    // types slot N+6
else if (duration >= 90 && !configmode)          blink(2);      // rejected
```

So asking for a confirmation press would type a slot's contents every time
somebody wanted to look at a different one. In this app the keystrokes arrive
in-process rather than in a text editor, so it is not a leak to a third party —
but it is a password being emitted as a side effect of asking to see an
unrelated one, and the capture buffer of whatever is listening fills with it.

This is not theoretical. It was observed during the composite-signing work: the
challenge is satisfied by the FIRST press, and the two extra presses sent after
it ran `gen_press()` and typed slots. See
`FINDING-the-signing-challenge-is-one-press.md`.

## The exceptions, and why they do not help

A press IS consumed without typing when the firmware has something pending:

- `pending_operation` set — the press is discarded entirely
  (`OnlyKey.ino:521-525`, and see
  `FINDING-presses-discarded-after-a-fido-ceremony.md`);
- `CRYPTO_AUTH` set — the press answers a signing or decryption challenge;
- `u2f_button` set — the press answers a FIDO2 ceremony.

All three require having first asked the device to do something that needs
confirming. Arming a signature nobody wants, so that a press exists to consume,
is not a confirmation mechanism; it is a trick with a real crypto operation
behind it.

## What the reveal does instead

Three things that do not need the device's cooperation:

- **Masked by default.** A captured value is dots until asked for.
- **A bounded reveal.** Fifteen seconds, then it hides itself again. Bounded
  rather than a toggle, because the failure mode of a toggle is walking away
  from a phone that is showing a password.
- **`FLAG_SECURE` while the editor is open**, so the screen does not appear in
  screenshots or the recents thumbnail. Verified rather than assumed: with it
  on, `adb shell screencap` returns a black frame while `uiautomator` still
  reports the editor's contents on screen.

Biometric confirmation — the other half of what was chosen, "optional if
enabled" — is **not implemented**. It needs `androidx.biometric` and a native
module, and it is the right place to put a real presence check now that the
device cannot provide one. That is a gap, not a decision.

## Worth reporting upstream

A "confirm" gesture that types nothing would be useful to more than this app:
any host that wants a user-presence signal from an unlocked key currently has to
either start a crypto operation or accept a typed slot. The firmware already
distinguishes bands; a fourth band, or a press while a host-set "awaiting
confirmation" flag is up, would cost very little.
