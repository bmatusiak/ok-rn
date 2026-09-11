# FINDING: the door's keypad lost digits at 2.4 s spacing and lost none at 450 ms

**Measured:** 2026-09-11, bench phone, soft key (Classic build) locked on
boot, This Key tab, `tools/tap.js` sending 1 2 3 4 5 6 1 through the door's
keypad.

## First measurement: 2.4 s between taps

`tap.js` took a fresh UI dump before every tap (about two seconds each).
The app showed seven filled dots and stayed locked. The Console view showed

    12:55:22 password appended with 1
    12:55:22 Number of keys entered for this passcode = 1
    12:55:25 password appended with 2
    12:55:25 Number of keys entered for this passcode = 2

and nothing for the remaining five. The key never saw a seventh digit.

## Second measurement: 450 ms between taps

`tap.js --gap 450` taps every label from one dump. Locked → seven taps →
**unlocked**, on the first try. Same keypad, same press path
(`emu.press` → `OkEmu.holdTicks(button, TAP)`), same PIN.

## Why (as far as it is known)

The press path is fine; the spacing is what the firmware objected to. A
finger enters a PIN at a few hundred milliseconds per digit, and every
suite's `pressDigits` runs at about 400 ms; two-plus seconds between digits
is not something a person does, and the firmware's PIN entry does not carry
on across it. The exact rule was not found in the time spent - OnlyKey.ino
around line 495 resets the guess on a condition worth reading - so this is
a measured boundary, not an explained one: presses 450 ms apart are
counted, presses 2.4 s apart stop being counted after the second.

## What it means for the app

Nothing to fix in the door for a person. For the TOOLS: any script that
enters a PIN must use `--gap`, and the runner's per-tap dump is the wrong
shape for a PIN. `tap.js` says so in its `--gap` comment.

## The hard key, separately

The same walk on the hard key failed at both spacings, but for a different
reason that this session caused: earlier long-press attempts had left stray
digits in its PIN buffer, "Start over" pads to rollover from the APP's
count (zero after a relaunch) and so could not clear a firmware buffer it
did not know the length of, and each try then counted as a wrong attempt.
Stopped at that point rather than approach the wipe threshold, and the key
was reset through the named-only provisioning suite, which clears the
attempt counter. Not a door bug: a bench-procedure hazard, now recorded.
