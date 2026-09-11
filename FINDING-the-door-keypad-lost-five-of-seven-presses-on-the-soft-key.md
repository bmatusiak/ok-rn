# FINDING: the door's keypad registered two of seven presses on the soft key (not fixed)

**Measured:** 2026-09-11 00:55, bench phone, soft key (Classic build) locked,
This Key tab, seven taps sent through the door's keypad by `tools/tap.js`
about 2.4 s apart: 1 2 3 4 5 6 1.

## What the app showed

Seven filled dots and "locked". The app's press queue accepted all seven.

## What the firmware said (Log tab, Console view)

    12:55:22 password appended with 1
    12:55:22 Number of keys entered for this passcode = 1
    12:55:25 password appended with 2
    12:55:25 Number of keys entered for this passcode = 2

and nothing for the remaining five. The key never saw a seventh digit, so it
never evaluated the PIN, so it stayed locked - correctly.

## What is known and not known

- The e2e suites unlock the same soft key on every run with the same PIN,
  through `helpers/pressDigits.js` → `OkEmu.pressButton()` (native, no
  tick counter), about 400 ms apart. That path works.
- The door's keypad goes through `emu.press` → `OkEmu.holdTicks(button,
  TAP)`, which arms a tick counter, polls it down, then waits for the
  firmware to see the release. Two presses landed; the third and later did
  not, with 2-3 s between them.
- A press is ignored while the LED is fading (see `helpers/ledSettled.js`,
  measured on the DUO keystroke test) and while `pending_operation` is set
  after a FIDO ceremony. Neither obviously applies between PIN digits.
- The same sequence was tried earlier in the session with a stray digit
  already in the buffer, which is a separate cause; this measurement is
  after "Start over" ran the buffer to rollover.

Unexplained. It could be the hold path's release wait, the LED fade after
each accepted digit on a debug build that prints per digit, or the 2.4 s
spacing itself. It is NOT the hard key: the hard key's door goes through
the console and its own buffer had a stray digit from an earlier hold.

## What to do next

Reproduce with `tools/tap.js` at 400 ms spacing (add `--gap`), then with
the native press path swapped in behind the door, and read the console
between presses. Until then, the door's keypad on the SOFT key is not
trusted for a PIN; the suites and the DUO's typed form are.
