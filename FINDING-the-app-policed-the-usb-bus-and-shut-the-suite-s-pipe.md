# FINDING: the app closed any open USB pipe while the soft key was selected, including the suite's

**Measured:** 2026-09-10, bench phone, `node tools/e2e.js --only hardKeyProvision`
with the app's override set to Soft Key.

## What happened

    ✓ runs only when named, on a developer key
    ✗ wipes userspace and the key reboots -> Error: No open transport
    ✗ sets a PIN through the firmware bracket … -> Error: No open transport
    ✗ UNLOCKS with that PIN … -> Error: No open transport

The suite's first test opened the pipe and connected; every later test found
it closed. Nothing in the suite closed it.

## Why

`useKey` owns opening and releasing the hard key's pipe. Its effect read:

    if (backend !== 'usb') {
      if (UsbPipe.isRunning()) void UsbPipe.stop();
      return;
    }

and, since the same session, it re-ran whenever the hard key's `state`
changed - that dependency was added so a key that stopped (the e2e suite
hands it back when it finishes) would be re-opened. The two together: the
suite opened the pipe, the hard key's state became `running`, the effect
re-ran, saw the soft key selected and a pipe open, and closed it. The app was
policing the bus rather than releasing what it had opened.

The earlier full run did not show this because the effect did not yet depend
on the state; only the second change made the standing condition fire.

## Why nobody saw it

The override had just been switched to Soft Key ON PURPOSE, to keep the app
from reopening the pipe and clearing the console mid-bracket while the suite
provisioned the key. The one setting meant to keep the app out of the way was
the one that made it close the pipe.

## What is fixed

`useKey` remembers the previous backend and closes the pipe only on the
TRANSITION away from the hard key. With the soft key selected it does not
touch a pipe someone else opened. Re-run: 6 passed, 0 failed, and the bench
key went INITIALIZED → UNINITIALIZED → INITIALIZED → UNLOCKED.

## What is not fixed

With the HARD key selected, the app still re-opens a pipe that stops - by
design, so a key that was handed back comes back. A suite that reboots the
key must therefore run with the soft key selected, or it will race the app's
reopen and console probe. `16-hardKeyProvision.e2e.js` says so in its header;
nothing enforces it yet.
