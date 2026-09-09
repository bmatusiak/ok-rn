# Button holds were timed in milliseconds against bands counted in loop iterations

**Severity:** high — the failure mode is an irreversible action, not an error
**Status:** fixed — `okemu_set_button_ticks()` counts the firmware's own samples
**Applies to:** ours — `android/okemu/src/ok_hal.cpp`, `src/transport/OkEmu.ts`

## What the firmware actually measures

`touch_sense_loop()` does `key_on += 1` once per iteration while a pad reads
high (`okcore.cpp:2574-2628`) and hands that count to `payload()` as `duration`
(`OnlyKey.ino:522`). Nothing anywhere in that path reads a clock. The bands are:

| duration | what happens |
|---|---|
| `<= 20` | `gen_press()` — types slot N |
| `21 .. 89` | `gen_hold()` — types slot N+6, the b profile |
| `>= 90` | rejected, blink only |

and above them, reached **first** because each of these branches `return`s
before the band dispatch (`OnlyKey.ino:873-914`):

| duration | button | what happens |
|---|---|---|
| `>= 72` | 1 | `backup()` — types the entire key out |
| `>= 72` | 2 | `get_key_labels()` |
| `>= 72` | 3 | lock, then `CPU_RESTART()` |
| `>= 72` | 6 | config mode |

So the only window that reads a b-profile slot is **21..71**, and it is walled
on the high side by actions that cannot be undone.

## What we were doing

`pressButton(button, holdMs)` held for a wall time:

```ts
await this.setButton(button, true);
await new Promise(r => setTimeout(r, holdMs));
await this.setButton(button, false);
```

That converts milliseconds into iterations at whatever rate the handset happens
to be running the firmware's main loop — a number that had never been measured,
that differs per device and per build, and that the phone's own scheduler moves
around under load. Every caller was picking a millisecond value and hoping it
landed between two walls it could not see.

The comment on `pressButton` even documented the bands in ticks ("a tap under 20
ticks, a hold past 72") while the parameter it took was milliseconds. The two
units were never connected by anything.

## Why it is worse than an ordinary race

Losing this race does not produce an error. It produces a **different, correct,
irreversible action**:

- overshoot on button 1 and the key types its entire backup at the keyboard;
- overshoot on button 3 and it locks and calls `CPU_RESTART()`, which on a phone
  takes the app's process with it (see
  `FINDING-lock-gesture-ends-the-soft-key.md`);
- overshoot on button 6 and it silently enters config mode, where the band
  dispatch stops working at all and every later press appears to do nothing.

Undershoot is merely wrong — the a slot instead of the b slot — but that is a
password manager handing back the wrong password.

## The fix

The HAL counts the samples itself and releases at exactly N:

```c
void okemu_set_button_ticks(int n, int ticks);   /* hold, then auto-release */
int  okemu_button_ticks_left(int n);             /* the press timer */
```

`okemu_touch_for_pin()` is called once per pad per round of `rngloop()`, and
`touch_sense_loop()` opens with exactly one `rngloop()` before doing its
`key_on += 1` (`okcore.cpp:2536`) — so one round is one tick of the firmware's
own counter. Pin 16 is the last pad read in a round (`okcore.cpp:2762-2775`),
which is where the counters are aged.

Two details that are wrong if done the obvious way:

- **Report first, age after.** The last tick of a hold must still read as held
  for the round it retires in. Ageing before reporting makes a one-tick hold
  invisible.
- **`okemu_set_button()` cancels a counted hold**, so a manual press from the UI
  cannot be silently overridden by a counter still running underneath it.

`PRESS_TICKS` names the two safe points (`TAP: 10`, `HOLD: 40`) and
`setButtonTicks()` refuses anything `>= GESTURE (72)` unless the caller passes
`{allowGesture: true}` — so the destructive band is unreachable by construction
rather than merely unlikely.

## Measured, on device

`__e2e_tests__/7-pressBands.e2e.js` provisions slot 1a with a 5-character
password and 1b with a 13-character one, presses button 1, and reads back which
slot the firmware processed from its own `Password Length =` line. The sweep:

| ticks | `Password Length` | slot | band |
|---:|---:|---:|---|
| 10 | 5 | 1 | `gen_press` |
| 10 | 5 | 1 | `gen_press` |
| 16 | 5 | 1 | `gen_press` |
| 21 | 13 | 7 | `gen_hold` |
| 30 | 13 | 7 | `gen_hold` |

The edge sits exactly at 21, which is where `OnlyKey.ino:939` says it should be.
N ticks is N iterations with no off-by-one and no calibration.

The press timer also gives the number that was previously being guessed at: on a
Pixel 6a the main loop runs **about one iteration per 35 ms**, so the gesture
threshold is roughly 2.5 seconds — but that figure is now a curiosity rather
than something anything depends on.

## Known limitation

`rngloop()` is also called from calibration (`okcore.cpp:6156`) and from
`RNG2()`'s entropy spin (`okcore.cpp:7637`), and a round from either ages the
counters without `touch_sense_loop()` counting an iteration. Neither overlaps a
deliberate hold in practice — both run synchronously on the firmware thread,
calibration at startup and `RNG2()` during payload processing, which is after
the release — and a hold that did span one would come out **short** rather than
long. It errs downward, away from the gestures, which is the direction that
costs nothing.
