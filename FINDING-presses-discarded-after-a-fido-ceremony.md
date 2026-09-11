# Every button press is silently discarded for 20 seconds after a FIDO2 ceremony

**Severity:** medium — no data loss, but the key looks broken and says nothing
**Status:** open upstream — firmware behaviour, not patched (read-only). Worked
around in the e2e suite, and since 2026-09-11 surfaced in the app: the soft
key reports the window from its LED (yellow = pending, the same pixels
`waitForLedClear` reads) and a hard key, which has no LED signal, gets a 20 s
timer from the ceremony the app relayed; both keypads show the note
(`useOkEmu.settling`, `useKey`, `PinScreen`, `KeyScreen`)
**Applies to:** upstream — `OnlyKey.ino:521-525`, `okcore.cpp:5973-6031`

## What happens

The main loop reads the press and then throws it away:

```c
int press_duration = touch_sense_loop();
if (pending_operation==0xF6 || pending_operation==0xF7) {  // USER_ACTION_PENDING / DATA_READY
  setcolor(45);            // yellow
} else {
  if (press_duration) payload(press_duration);
}
```

`touch_sense_loop()` counted the iterations correctly and returned a perfectly
good duration. It is discarded one line later. `payload()` never runs, so there
is no `Button selected` line, no slot lookup, nothing typed and nothing on any
interface — the press leaves no trace anywhere.

`wipebuffersafter5sec()` re-arms the state five seconds in
(`okcore.cpp:5975-5980`, setting `pending_operation = CTAP2_ERR_DATA_WIPE`) and
only `fadeoffafter20sec()` clears it (`okcore.cpp:6027`). So the window runs for
up to **twenty seconds** after a ceremony, whether or not the ceremony
completed.

## How it presented

As a test that failed for a reason nowhere near where it looked.

`7-pressBands.e2e.js` runs after the presence and bridge suites, and its first
counted press — a 10-tick tap on button 1 — produced nothing at all. Everything
else in the same file passed, including a 40-tick hold on the same button
moments later, and a sweep that pressed 10 ticks twice more and got the right
slot both times.

That shape is what made it findable: not "short presses are broken" but "the
first press after a FIDO2 ceremony is broken". Two wrong explanations were tried
and measured away first — that `RNG2()`'s entropy spin was eating the ticks
(settling on serial silence changed nothing), and that the counter itself was
short (the sweep showed the band edge landing exactly on 21, as specified).

The only outward sign is the yellow the loop paints every iteration while the
state is set. There is no message on SEREMU, none on the vendor interface, and
nothing in any status broadcast.

## Why it matters beyond the test

This is the app's own main loop now, not a USB peripheral's. A user who
completes a WebAuthn ceremony in a browser and then taps a slot to fetch a
password gets nothing back, twice, for up to twenty seconds, with no feedback
beyond a colour they may not be looking at. On hardware the yellow LED is right
in front of them; on a phone the button pad and the LED are the same screen and
the LED is a small dot.

The e2e suite works around it by waiting for the strip to leave yellow before
measuring, which takes about a second when nothing is pending:

```js
const isPending = px => px.r > 64 && px.g > 64 && px.b < 64;   // hue 45
```

An `led` event carries one **packed 24-bit colour per pixel**, not three
channels — destructuring `pixels` as `[r, g, b]` reads three separate pixels,
leaves `b` undefined, makes every comparison false, and ends the wait
immediately while the strip is still sitting at `0x525200`. That cost a run.

## What the app should do

Not fixed here because the fix belongs in the UI rather than in the emulator,
and the firmware stays unmodified (staging exists to make it run, not to change
what it does):

- **Surface the state.** The pending window is already visible through the
  `led` sink. A press pad that greys out while the key is busy, rather than
  accepting taps and dropping them, is the whole fix from the user's side.
- **Do not queue presses into it.** `holdTicks()` will report a clean countdown
  to zero for a press that was discarded, because the counter and the discard
  are in different places. Anything that needs a press to have *landed* has to
  confirm it by its effect, not by the timer.
