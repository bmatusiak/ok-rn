# Finding: a BLE-paired phone types the backup suite's output to the paired computer

**Status:** measured on the bench Pixel 6a, 2026-09-20. Reproduced once, in
anger, and fixed. Deterministic given the precondition.
**Severity:** key material leaves the phone and lands wherever the paired
computer has focus. The e2e run also aborts with no verdict, which is how it
gets noticed — the leak itself is silent.
**Found by:** running `npm run e2e:run` while the phone happened to be paired
to the development PC as a Bluetooth keyboard.
**Whose code:** ok-rn's, and arguably nobody's — each half is behaving exactly
as designed.

## What happened

The run reached `backupCapture`, which is supposed to:

    backup gesture: button 1, 72..179, holding 100
      ✓ the backup band is read from the device, not chosen here

Holding button 1 past the gesture band makes the firmware run `backup()`, and
`backup()` **types the entire key out on the keyboard interface**. That is the
point of the suite: it holds the button, captures what is typed, and checks it.

But the phone was paired to the PC as a BLE HID keyboard. So the keystrokes
went out over Bluetooth instead of into the app, and arrived in the terminal
window that happened to have focus — which was the one driving the run. What
appeared there was the slot contents, then:

    -----BEGIN ONLYKEY BACKUP-----
    <base64, for as long as it took to notice>

The app then lost the foreground and the runner stopped:

    e2e: com.okrn left the screen mid-run.

`.last-e2e.json` kept the previous verdict, so the run produced nothing.

## Why it is not obvious from reading the suite

Nothing in `backupCapture` mentions Bluetooth, and nothing in the BLE code
mentions the suite. The keyboard interface is one interface: the firmware types
on it, and whoever is listening receives it. In every normal run that is the
app. Pairing quietly adds a second listener with better claim to the
keystrokes, and neither side has any reason to mention the other.

The failure it produces is also misleading. "com.okrn left the screen mid-run"
reads like a crash or a stray tap; there is no error, nothing in logcat, and
the suite that caused it passed its last assertion before dying.

## The fix

`RUN TESTS` turns the app's Bluetooth off before arming the suite:
`E2EScreen` takes an `onRunStart`, `TestingScreen` passes it through, and
`App.tsx` supplies `() => setBtOn(false)`.

At the RUN, not in `tools/e2e.js`, because a run can be started from the phone
as well as from a terminal — the hazard belongs to the suite, not to the
runner.

## What to check if it happens again

- Anything typed is in the terminal's scrollback and possibly shell history.
  A backup is the whole key; treat it as exposed and judge by what the backup
  passphrase protects it with.
- A `-----BEGIN ONLYKEY BACKUP-----` in a window nobody expected is this, not a
  compromise of the host.
- The long runs of a single repeated character between base64 blocks are a held
  button repeating, not data.

## The part that is still sharp

This only removes the hazard for runs started through `RUN TESTS`. A backup
gesture performed by hand, while paired, still types to the paired computer -
because that is what a keyboard is for. The firmware cannot tell a wanted
backup from an unwanted one, and the phone cannot tell which listener deserves
the keystrokes.
