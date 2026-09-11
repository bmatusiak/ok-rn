# FINDING: every tap on the hard key's on-screen keypad was a 71-tick hold

**Measured:** 2026-09-10, bench key (developer build, console answers),
This Key tab keypad, then the new capture pane on the Keyboard tab.

## What happened

Tapping "1" on the This Key keypad with the hard key selected produced, in
the Hard Key log:

    [fw] 1#71
    [fw] ... Slot Number 1 Displaying Full Keybuffer

and the capture pane read **0 reports**. Reading slot 1a from the slot
editor a minute later produced 24 reports and the password, through the
same pipe and the same pane.

## Why

The keypad is "holdable": press-in calls `beginHold`, press-out calls
`endHold`. The soft key's handle arms a counter on press-in and reads it
back while the finger is down, so a quick tap is a few ticks (the a slot)
and a long press is more (the b slot).

The hard key's handle could not do that - the console takes the whole
duration up front as `N#<ticks>` - so its first version sent the maximum
(GESTURE - 1 = 71) on press-in and made `endHold` a no-op. Every tap was
therefore a 71-tick hold, which is the b band: it typed slot 1b, and 1b was
empty. The pane was right to show nothing; nothing was typed.

## Why nobody saw it

The e2e hardKey test reads a slot through `readSlot`, which computes its own
tick count and calls `press("1#10")` directly - it never goes through the
keypad's hold path. And the log line `1#71` looks like a deliberate hold
unless you know 71 is the b band.

## What is fixed

`useHardKey.beginHold` only notes the time; `endHold` converts the elapsed
time to iterations at the firmware's ~36 ms each (press.js), clamps to the
tap floor and the gesture ceiling, and sends `N#<ticks>` once. A tap now
lands in the a band and a held finger in the b band, as on the soft key.
Verified: a tap on "1" typed slot 1a and the capture pane read
"Hw&3e2e", 24 reports.

## What is not fixed

The hard key has no live tick counter to display while the finger is down
(`pressTicks` stays null): the console replays the press after the fact, so
there is nothing to read back. The KeyScreen's "hold to count ticks" hint is
therefore true of the outcome but not of the display on a hard key.
