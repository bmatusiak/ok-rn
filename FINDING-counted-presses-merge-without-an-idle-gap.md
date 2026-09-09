# Two counted presses with no gap between them are one longer press

**Severity:** high — the merged duration is a SUM, and past 72 it is a gesture:
`backup()` on button 1, lock and `CPU_RESTART()` on button 3
**Status:** fixed — `holdTicks` waits for the release to be observed, counted
in the firmware's own sense rounds
**Applies to:** ours — `ok-rn/android/okemu/src/ok_hal.cpp`,
`ok-rn/src/transport/OkEmu.ts`. The firmware behaviour it describes is correct
and unmodified.

## How it surfaced

Queuing PIN taps instead of dropping them
(`FINDING-pin-taps-are-dropped-not-queued.md`) removed the incidental delay
that the dropped-tap guard had been providing. All seven digits then registered
in the UI — and the key stayed locked.

| taps | dots shown | unlocked |
|---:|---:|---|
| 7, back to back | 7 | **no** |
| 7, 800 ms apart | 7 | yes |

Seven accepted presses that do not unlock is not a lost press. It is seven
presses that did not arrive as seven.

## What the firmware does

`touch_sense_loop()` (`okcore.cpp:2574-2630`) is one if/else-if chain over the
six pads. Exactly one is credited per round, and every branch does the same
three things:

```c
key_off = 0;
key_press = 0;
key_on += 1;
button_selected = '<n>';
```

The else — no pad touched — is the only place a press can end:

```c
} else {
    if (key_on > THRESHOLD) key_press = key_on;
    key_off += 1;
```

and the duration only reaches `payload()` once **three** idle rounds have gone
by (`okcore.cpp:2723`):

```c
if ((key_press > 0) && (key_off > 2)) {
    key_on = 0;
    int duration = key_press;
```

So `key_on` is not per-button. It counts rounds in which *anything* was held.
Two holds separated by fewer than three idle rounds are one press: the
durations add, and `button_selected` is whichever pad was seen last.

Seven ten-tick taps become **one seventy-tick hold of button 1**. 70 is in the
`gen_hold` band, so instead of unlocking, the key typed slot 7's b profile.

## Why this is worse than a wrong slot

The sum keeps going. Eight taps is 80, and the gesture branches are tested
first and return before the band dispatch (`OnlyKey.ino:873-914`):

| sum | button | what runs |
|---:|---|---|
| ≥ 72 | 1 | `backup()` — types the entire key at the keyboard |
| ≥ 72 | 2 | `get_key_labels()` |
| ≥ 72 | 3 | lock + `CPU_RESTART()` |
| ≥ 72 | 6 | config mode, which only a boot clears |

A PIN is 7 to 10 digits. Anyone typing a 8-digit PIN at speed was one merge
away from a backup or a restart — and the `working` guard that stood in the way
was only doing so by accident, because it happened to be slow.

## Why `buttonTicksLeft` reaching zero is not enough

It says we stopped asserting the pad, not that the firmware saw it let go. The
counter is aged inside `okemu_touch_for_pin` on the last pin of the round, and
that round still reported the pad as HELD — deliberately, so a one-tick hold is
not invisible. The idle rounds start after it.

Waiting some number of milliseconds instead would reintroduce exactly the bet
that `FINDING-holds-were-timed-against-a-counted-band.md` removed: the firmware
never reads a clock, and a round costs whatever this handset makes it cost.

## The fix

The HAL counts rounds — it already knows where one ends, since that is where it
ages the tick counters — and exposes the count:

```c
if (pin == kLastPinInRound) {
  for (int n = 1; n <= OKEMU_NUM_BUTTONS; n++) { ... }
  g.rounds++;
}
```

`holdTicks` then waits for four rounds after the counter drains: three for
`key_off > 2`, plus the one the hold retired in, which still read as held.

Measured after the fix, on a Pixel 6a: seven taps sent back to back with no
delay at all unlock the key.

## The edge the first fix got wrong

Waiting for the rounds is right; treating a timeout as an error was not. The
rounds stop advancing whenever the firmware is busy doing what the press ASKED
FOR - `backup()` types the entire key at the keyboard, and a slot press types a
password - and neither returns to `touch_sense_loop()` while it does.

So the longest presses in the app are precisely the ones whose settle cannot
finish, and the backup gesture came back as:

    the firmware ran fewer than 4 sense rounds in 4993ms -
    the main loop is not running

at the end of a gesture that had worked perfectly.

Nothing is lost by returning instead. The settle exists to stop a FOLLOWING
press merging into this one, and while the loop is not sampling it cannot:
`okemu_touch_for_pin` already reports the pad released - the counter hit zero
and cleared it - and a next press's ticks cannot age until the loop returns
either. A genuinely wedged loop is still caught, by the tick timeout on the next
hold, which is a liveness check; this is not.

## What it costs

About 145 ms per press on this handset — four rounds at ~36 ms. A seven-digit
PIN goes from ~2.5 s to ~3.5 s of queue. That is the price of the presses being
real, and it is paid in the background while the user keeps typing.

## Measured, both ways

Three taps on button 1, back to back, with slot 1a holding a 5-character
password and slot 1b a 13-character one — so the band the press lands in is
readable straight off the wire:

| `RELEASE_ROUNDS` | `Password Length` lines |
|---:|---|
| 0 (the bug) | `[13]` — one press of 30 ticks, read as `gen_hold`, slot **7** |
| 4 (the fix) | `[5, 5, 5]` — three presses of 10 ticks, slot **1**, three times |

The merged press is not approximately right. It reads a different slot, and at
seven or eight taps it would not read a slot at all.

## Guarded by

`__e2e_tests__/7-pressBands.e2e.js` — "back-to-back taps stay separate
presses". Three taps is 30 ticks, which is `gen_hold`, so a regression does not
show up as an off-by-one: it reads the wrong slot, and the b password's
different length says so.
