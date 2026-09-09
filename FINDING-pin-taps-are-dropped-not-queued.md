# Typing a PIN at finger speed loses digits

**Severity:** high — it is the first thing anyone does with the app, the loss
is near-silent, and the buffer it feeds cannot be cleared
**Status:** fixed — presses are queued instead of dropped
**Applies to:** ours — `ok-rn/src/screens/PinScreen.tsx`

## The measurement

Driving the PIN pad over adb while verifying the file picker, on a Pixel 6a:

| gap between taps | taps sent | digits registered |
|---|---:|---:|
| none (`input tap` back to back, ~120 ms apart) | 7 | **3** |
| 800 ms | 7 | 7 |

Ten dots for fourteen taps, and the key stayed locked. Nothing reported an
error; the entry simply did not contain what was typed.

## What is actually happening

A press is not instantaneous. `pressButton` is `holdTicks(button, 10)`, and a
tick is one firmware main-loop iteration — measured at ~35–37 ms — so ten of
them is ~360 ms, plus the 25 ms polling interval that notices the release.
Call it 400 ms per digit.

`PinScreen.press` held a `working` flag for that whole time and returned early
on any tap that arrived while it was set:

```js
if (working || count >= MAX_PIN) {
  return;
}
```

`Keypad` was also `disabled={busy || working}`, so the tap never even reached
the handler. A finger moving between two keys takes 150–250 ms. Every second
digit was landing inside another digit's press and being thrown away.

## Why the guard was there, and why it was the wrong one

Serialising is genuinely required. `okemu_set_button_ticks` writes one counter
per button, so a second press starting before the first has been released
overwrites the count that is being aged — the first press either truncates or
disappears. The guard was protecting a real invariant.

But it protected it by discarding the *newest* input, which is the one the user
just made. The invariant only asks that presses not OVERLAP; it says nothing
about them having to be abandoned.

## Why losing one digit costs the whole entry

`clearPinEntry()` appends before it resets, so there is no way back to an empty
buffer except the firmware's own rollover — `pass_keypress` starts at 1 and the
tenth press takes the else branch that calls `password.reset()`
(`OnlyKey.ino:964-989`). That is what the screen's "Start over" does, and it is
three to seven more presses at 400 ms each.

So a dropped digit is not a keystroke to repeat. It is the entry, plus a
rollover, plus the entry again.

## The fix

A promise chain rather than a flag. Every tap is appended and sent in order, at
whatever rate the firmware can take them:

```js
queue.current = queue.current.then(() => onPress(button)).then(...)
```

The cap is counted at ACCEPT time, not at send time, so ten fast taps queue ten
presses rather than however many happen to fit. A press that rejects gives its
slot back, because it never reached the key.

The keypad is no longer disabled while a press is in flight — being unable to
type ahead is the bug — and the dots now advance as each press lands, which
makes the queue draining visible rather than making the UI look stalled.

## The half of it this did not fix

Queuing exposed a second, worse bug. The dropped-tap guard had been supplying
an accidental gap between presses, and the firmware NEEDS one: two counted
holds with no idle round between them arrive as a single press whose duration
is the sum. With the guard gone, seven taps became one seventy-tick hold and
the key still did not unlock — and an eight-digit PIN would have crossed 72,
which on button 1 is `backup()`.

So this fix is only correct alongside
`FINDING-counted-presses-merge-without-an-idle-gap.md`, which makes
`holdTicks` wait for the release to be observed. Neither is complete on its own.

## What it does not fix

The queue is per-screen. Nothing stops another part of the app pressing a
button at the same time; `OkEmu` still has no lock of its own, and two callers
racing would still overwrite one another's tick counter. No screen does this
today — PIN entry, config mode and backup are all modal — so this is recorded
rather than solved.
