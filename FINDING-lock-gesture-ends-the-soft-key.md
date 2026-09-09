# Holding button 3 ends the soft key permanently

**Severity:** high for the soft-key goal — a documented user gesture disables
the device until the app process is restarted
**Status:** open. Mitigated in the UI (the state is surfaced and Start is
disabled rather than failing); not fixed, because fixing it means implementing
in-process restart
**Applies to:** ours — `android/okemu/`, the hosting, not the firmware

## What happens

Holding button 3 for roughly two seconds is the device's **lock** gesture. On
hardware it locks and reboots, which takes about a second and is completely
routine (`OnlyKey.ino:886-913`):

```c
} else if (duration >= 72 && button_selected=='3' && !isfade) {
    // Lock and/or switch profiles <4 sec
    ...
    unlocked = false;
    ...
    CPU_RESTART();
    return;
```

In this build `CPU_RESTART()` is a write to a read-only page at the AIRCR
address, caught by a SIGSEGV handler that `siglongjmp`s to the top of
`okemu_firmware_run()` (`src/okemu_restart.cpp:83-105`). That landing pad does
not restart anything:

```c
  if (sigsetjmp(g_park, 1) != 0) {
    g_armed = 0;
    mprotect(...);
    okemu_hal_shutdown();
    if (g_restart_fn) g_restart_fn(g_restart_ctx);
    return;                     /* <- the thread exits here */
  }
```

The thread returns, and `nativeStart` refuses to spawn another — that guard
exists for a good reason (two firmware threads sharing one input queue was
[its own finding](FINDING-stop-start-leaks-a-firmware-thread.md)), and
`okemu_hal_shutdown()` has already dropped the flash mapping it cannot take
back ([finding #5](FINDING-emu-shutdown-leaks-mapping.md)).

So the soft key is gone until the app process restarts. Device state survives —
flash and EEPROM are files — so nothing is lost but the session.

## Why it matters more than it looks

`CPU_RESTART()` is not an error path here. The firmware reaches it from about
ten places, several of them normal operation: the lock gesture above, the idle
lockout timer, a failed integrity check, wipes, and bootloader entry. On
hardware every one of them is "it rebooted". On a phone every one of them is
"the security key stopped existing".

The lock gesture is the sharpest case because a **user does it on purpose**, and
because it is two seconds on button 3 — a plausible slip while entering a PIN.

## How it presented

It did not, and that was the problem. `useOkEmu` subscribed to
`restartRequested` and logged it as `info`, leaving `state` at `'running'`:

```ts
const offRestart = OkEmu.on('restartRequested', () => {
  log('info', 'firmware requested CPU_RESTART()');
});
```

So the screen kept its green pill and its enabled buttons over a dead device,
and everything after simply timed out with no reply — the same signature as a
locked device, a wedged one, or a bad flash mapping.

Found while deciding whether a button keypad should offer a press-and-hold. It
should not, and this is the reason.

## What was done

- `restartRequested` now sets a distinct `'halted'` state, logs an error saying
  the thread has exited and the app must be restarted, and mirrors it to
  logcat. Start is disabled, because `nativeStart` would refuse it anyway.
- The keypad offers **taps only**. Press length is banded in main-loop
  iterations rather than milliseconds, and the long bands are where the
  irreversible gestures live: `>=72` on button 1 is `backup()`, on button 3 is
  this, on button 6 is config mode.
- The halted state now offers **a one-tap way out**: KeyScreen shows a "Restart
  the app" action wired to `OkEmu.restartApp()` (RestartActivity.kt). That is
  the PROCESS restart, not the in-process one below - flash.bin and eeprom.bin
  persist, so the device comes back as it was. It does not fix the finding; it
  stops the dead end being a dead end.

## What would actually fix it

In-process restart, which needs `okemu_hal_shutdown()` to release the flash
mapping so `okemu_hal_init()` can take it again. That is finding #5, and it is
the same blocker behind `restart()` being unsupported. Until then the honest
behaviour is to say the device is gone rather than to pretend otherwise.
