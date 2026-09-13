# A locked key showed a green LED, which is the one thing it must not say

Found 2026-09-13, by the user, within minutes of the LED indicator existing at
all. The indicator was added so the soft key would give the same feedback a
hardware key gives — and the first thing it surfaced was a state where the app
was saying something untrue.

## What was on the screen

- the status pill read **`running`**, not `locked` or `unlocked`
- the panel below read **`Locked`** and offered the keypad
- the LED circle was **bright green**

On a security device green reads as *unlocked*. The device was not unlocked.

## What was underneath it

```
[softkey] OKCONNECT failed: Error: no reply on interface 2 within 3000ms
[softkey] OKCONNECT got no reply - the flash mapping is suspect
```

The soft key was in a state this project has a name for but no handling of:
**running, but not answering the vendor interface.** The firmware thread was
alive and driving its NeoPixel — `#00af00` is the colour it holds when its main
loop is running, which `README.md` already treats as the sign of life — while
OKCONNECT got nothing back.

Because OKCONNECT never completed, the app could not read a lock state at all,
so `emu.device` stayed `'unknown'` and the pill fell back to showing the
firmware state (`running`). The LED, meanwhile, was perfectly live: the app
process had restarted at 01:26 and `led` starts empty, so the green arrived
from a real event after that.

**So the green was not stale. It was accurate about the firmware and wrong
about the device**, which is worse, because nothing about it looked broken.

## The likely cause, and it is the user's reading

**A hot reload cleared the encrypted state on the app's side while the firmware
kept the old one.**

Metro rebuilds the JS half on every save — the Rectify app, the `session`
plugin, and with it the transit keypair that OKCONNECT establishes. The
firmware is a NATIVE thread: it survives the reload untouched, still holding
the session it agreed with the previous JS half. The two halves then disagree
about the encrypted channel, so the vendor interface stops answering while the
firmware carries on running and driving its LED.

This fits every observation, which the "firmware is just unhealthy" reading did
not:

- the thread is alive and painting green — it never restarted
- OKCONNECT gets no reply — the session it is answering is not the one being
  asked
- **only a full app restart fixed it**, because that is the single action that
  resets both halves together

It also means this is most likely a DEVELOPMENT artefact. An afternoon of UI
iteration is dozens of hot reloads against one long-lived firmware thread; a
release build hot-reloads nothing. That does not make it harmless — it makes it
something to confirm rather than assume, because the soft key is a shipped
feature and any reload-like event would land the same way.

## Why nobody saw it before

There was no LED indicator until today. The colour existed as a hex string in
one row of a diagnostics table (`KeyScreen`'s `LED  #00af00 #00af00`), where
nobody reads it as a claim about lock state. Rendering it as a coloured circle
next to the word "Locked" is what made the contradiction visible.

## What fixed it

**Restarting the app**, from the new `Restart app` button on the login panel.
That takes the firmware thread down with the process; flash and EEPROM are
file-backed and survive, so the key comes back in a good state and locked.

That button exists because "Start over" was removed the same afternoon: it ran
the PIN buffer to its rollover, which needed to know how many digits had been
entered, and a PIN is 7 to 10 digits so the screen never did.

## What is fixed, and what is NOT

**Fixed:** `useOkEmu` now clears the pixel when the device locks and when the
firmware calls `CPU_RESTART()`. Before, `led` was only ever written by an
event, so after the thread exited the last colour sat there for ever.

**NOT fixed, and this is the case that actually occurred:** neither of those
paths covers `device === 'unknown'`. When the soft key is running but not
answering, the app keeps showing whatever the firmware last painted. The
indicator will read green on a key whose lock state is unknown.

Two ways to close it, and the choice is a product one rather than a technical
one:

1. **Show the LED only when the lock state is known.** Faithful to the device
   when it can be, silent when it cannot — an indicator that says nothing is
   better than one that says "unlocked".
2. **Show it always, and make "unknown" visually distinct** from both locked
   and unlocked, so the circle is never the only thing a reader goes on.

## The larger thing worth keeping

The soft key can reach a state where it is running and unreachable, and the
only recovery is restarting the app. `FINDING-emu-degraded-mode-is-silent.md`
covers the silence; this is what that silence looks like once something on
screen is derived from the firmware rather than from the session.

## Seen again, with a trigger this time

2026-09-13 01:44. A Metro hot reload - an edit to `useOkEmu.ts`, nothing
touching transport - put the app back on the login screen while the firmware
carried on unlocked. The pill read `running` rather than `locked` or
`unlocked`, so lock state was UNKNOWN, not merely wrong; the LED stayed
`#00af00`. Seven PIN presses went in and nothing happened: the digits reach a
firmware that is already past its login.

So the trigger is not mysterious. A hot reload rebuilds the JS session while
the emulator thread keeps running - the app forgets it unlocked, the key does
not. `restartApp()` restarts both and the two agree again.

Worth noting the readout was honest here: the pill said `running`, which is
exactly what was true. What was misleading was the login screen underneath it,
which is drawn whenever the session says "not unlocked" and does not
distinguish "locked" from "we do not know".
