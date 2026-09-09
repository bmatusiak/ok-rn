# Unlocking in config mode is never announced

**Severity:** medium — a client waiting for the unlock waits forever over a
device that is ready
**Status:** open — upstream behaviour; the app probes instead of waiting
**Applies to:** upstream — `OnlyKey.ino:707`

## The line

```c
password.reset();
session_attempts = 0;
if (!configmode) hidprint(HW_MODEL(UNLOCKED));   // OnlyKey.ino:707
SoftTimer.remove(&taskInitialized);
...
unlocked = true;
if (configmode) {
  NEO_Color = 1;   // Red
  fadeon(1);
}
```

Outside config mode an unlock announces itself once — `UNLOCKEDv3.0.4-…` on the
vendor interface — which is how every client learns the PIN was accepted. **In
config mode that announcement is suppressed.** The device unlocks, stops the
`INITIALIZED` broadcast, turns its LED red, and says nothing.

So from the host's side, entering the correct PIN in config mode is
indistinguishable from entering the wrong one, except that the once-a-second
`INITIALIZED` stops. The only evidence is an absence.

## Why it bites this app in particular

The desktop app tells you to put the key into config mode yourself, then to
unplug and replug it when you are done — so it re-enumerates and re-announces,
and nobody notices the missing message. This app IS the key. It performs the
hold, so it is sitting there waiting to be told the PIN worked, and it never is.

Observed exactly that: the Keys screen offered a PIN pad, seven digits were
entered correctly, and the screen stayed on the pad. The device had been
unlocked the whole time.

## What the app does instead

Asks, rather than waiting to be told. `OKGETLABELS` is on the config-mode
allowlist (`okcore.cpp:347`) and answers `Error device locked` unless the device
is unlocked, so a successful label read is positive proof:

```js
try {
  await device.readLabels({ timeoutMs: 2500 });
  setConfigUnlocked(true);          // it answered, so it is unlocked
} catch {
  /* still locked, or busy - ask again */
}
```

Polled every 2.5 s while the screen is waiting, and stopped as soon as it
answers. A positive probe rather than inferring from the silence, because
silence is also what a wedged device produces.

## Reporting it

The suppression looks deliberate — config mode drives the LED red rather than
green, and the status text would contradict that. But a client cannot see an
LED. Sending `UNLOCKED` with a config-mode marker, or any distinct message,
would cost one line and remove a state that no host can currently observe.

Related: `FINDING-loading-a-key-requires-config-mode.md` for why an app has to
enter config mode at all, and `FINDING-relock-was-invisible-to-the-app.md` for
the bug on our side that this one was found underneath.
