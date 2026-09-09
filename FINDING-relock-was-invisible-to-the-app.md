# Once unlocked, the app could never see the key lock again

**Severity:** high — the app showed an unlocked interface over a locked device,
and the PIN door never came back
**Status:** fixed — a grace window replaces an absorbing state
**Applies to:** ours — `src/hooks/useOkEmu.ts`

## What it was

Lock state is read from the firmware's own once-a-second broadcast. The handler
had one line that made `unlocked` absorbing:

```js
} else if (parsed.state === 'locked') {
  /*
   * INITIALIZED means provisioned AND locked, and it must never overwrite
   * 'unlocked': the announcement is a one-off and the broadcast stops, but a
   * report already in flight can land just after it and would put the screen
   * back behind a PIN prompt.
   */
  setDevice(prev => (prev === 'unlocked' ? prev : 'locked'));
}
```

The race it describes is real. `UNLOCKED` is announced once and the `INITIALIZED`
timer is stopped, so a report already queued can arrive milliseconds later and
would bounce the UI back behind a PIN prompt for no reason.

The cure removed the symptom and the signal together. **After the first unlock,
`INITIALIZED` was ignored for the lifetime of the app**, so the app could not
see the key lock by any route:

- the idle timeout (`TIMEOUT[0]`, checked every loop);
- a hold on button 3, which locks and restarts;
- entering config mode, which locks deliberately;
- `integrityctr1 != integrityctr2`, which locks on an integrity failure.

`App.tsx` puts the login door back when `emu.device` stops being `unlocked` —
its comment says "It relocked while we were inside" — and that branch could
never run. An idle-locked key showed a fully unlocked interface, and every
action on it would have failed with "Error device locked".

## How it surfaced

Building the Keys screen. Entering config mode locks the key, so the screen
waited for that and then offered the PIN — and the wait never ended. The screen
sat claiming config mode above a status pill still reading `unlocked`, which is
what made it obvious the app's idea of lock state was fiction.

Two wrong guesses came first, and both were checked away: that the button hold
had not reached the config-mode branch, and that the press had been discarded by
the pending-operation window. The firmware's own console settled it - it was
broadcasting `49 4E 49 54 49 41 4C 49 5A 45 44`, "INITIALIZED", the whole time.
The device had locked. The app was not listening.

## The fix

Time tells the race from a real re-lock, because they happen on different
scales. The broadcast runs at 1 Hz and the racing report lands within
milliseconds of the `UNLOCKED` it raced; a genuine re-lock is seconds later at
the earliest.

```js
const sinceUnlock = Date.now() - unlockedAt.current;
if (sinceUnlock > UNLOCK_GRACE_MS) {   // 1500 ms
  setDevice('locked');
}
```

The original protection is kept — an in-flight `INITIALIZED` is still ignored —
and everything after the window is believed.

## Worth remembering

The bug was introduced by a comment that was correct. The race was real, the
reasoning about it was right, and the fix was too broad by exactly one
dimension: it discarded the signal for all time instead of for the moment the
race could occur. A guard that says "never" is worth a second look when the
thing it is guarding against is "sometimes".
