# Unlocking in config mode is never announced

**Severity:** medium — a client waiting for the unlock waits forever over a
device that is ready
**Status:** open upstream; the LIBRARY now probes rather than waiting, and
the app has always done so on its own screen
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

## What it cost: the library waited on the console without knowing it

`device.unlock()` resolves on one of two witnesses - a vendor status report
that parses as unlocked, or a SEREMU line matching /UNLOCKED/. In config mode
the first never comes, by the line above. **The second is the debug console**,
and on a debug build it arrives, so `unlock()` appeared to work in config mode
for as long as anyone had tested it.

Built as it ships there is no console, and both witnesses go quiet. Unlocking
inside config mode became impossible through the library - which takes loading
a key, setting a preference and requesting a firmware update with it, because
all three need config mode.

It surfaced the moment the matrix started building releases as they ship:
v3.0.2's `cryptoSign` could not provision its signing key, failing with "the
device did not unlock within 20000ms" against a device that had unlocked
perfectly well.

Fixed in `plugins/device/index.js`: when this session put the key into config
mode, `unlock()` probes with the label read below alongside the two listeners,
and resolves on a successful read. Only in config mode - outside it the
announcement arrives and probing would be traffic during PIN entry for nothing.

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
