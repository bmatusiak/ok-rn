# Enabling the touch-free derive preference mid-run kills CTAPHID for the rest of it

**Severity:** every device test after it fails, with a timeout that names nothing
**Status:** open — not fixed. A second run passes, because the EEPROM byte
persists and the path is not taken again.
**Applies to:** `ok-rn/__e2e_tests__/10-derive.e2e.js` and its
`helpers/touchFreeDerive.js`, against the soft key

## What was measured

A device whose `derived_key_challenge_mode` bit 3 is CLEAR, running the full
suite:

```
suite: cryptoSign
  already provisioned; nothing to do
  ✓ provisions a signing key if the slot is empty, which needs config mode
suite: derive
  ✓ the plugin offers the derive pair at all
  ✓ derives a public key for a label
  ✓ the same label derives the same key twice
  ✓ a different label derives a different key
  ✓ a shared secret can be derived against that key
  ✓ the SHARED SECRET is stable across calls, not just the public key
  the preference is off; entering config mode to set it
  unlocked again, now in config mode
  ✗ a vault blob sealed on this device opens again      -> no CTAPHID reply within 30000ms
  ✗ a sealed credential survives being stored and read back
  ✗ an export carries sealed blobs and imports back
  ✗ the X-Wing key type returns its split-custody pair
  ✗ an age file encrypted to the device is read back by it
suite: identity
  ✗ the console the build claims is actually there      SEREMU traffic seen: false
suite: deriveParity
  ✗ the shared secret matches one computed independently -> no CTAPHID reply within 60000ms
```

54 passed, 7 failed, and the run then exceeded the harness's 420-second budget
because six of those failures are 30- and 60-second waits.

Run again with nothing else changed: **66 passed, 0 failed, 165s.**

## The cause

`10-derive.e2e.js` enables the preference ON DEMAND — it tries the touch-free
derive, and if the firmware refuses it, calls `enableTouchFreeDerive()` and
retries. That helper does what the app does: gesture into config mode, which
LOCKS the device, then unlock again.

The device is then unlocked **and in config mode**, and it stays that way for
the rest of the process. Every CTAPHID request after that point goes
unanswered. The firmware does not refuse them; it says nothing, which is this
firmware's usual way of refusing (see `CLAUDE.md`) and is indistinguishable
from a hang.

`9-cryptoSign` is where this is supposed to happen — it is already in config
mode there for its own reasons, so the byte costs nothing extra. It only skips
that when the signing slot is already provisioned, which is exactly the case
here: a device carrying a provisioned slot but not the preference falls into
the gap between the two suites.

## Why nobody saw it

The byte persists in EEPROM. Whoever set it once never took this path again,
and a bench device that has run the suite before is a device where the branch
is dead. It reappears the moment device state is replaced — a wipe, a restore,
a new handset, or a per-version state directory, which is precisely what the
version matrix is about to introduce for every release.

## What would fix it

Restart the firmware after `enableTouchFreeDerive()` rather than continuing in
config mode. The device reboots from `flash.bin` and comes back normal, which
is what the next RUN of the suite does implicitly and why the second run is
green. `OkEmu.restart()` refuses in-process by design
(`NativeOkEmuModule.restart`), so the honest options are to force-stop and
relaunch, or to make config mode an explicit exit rather than a state the test
leaves behind.

Not done here because it changes how the suite drives the device, and the
measurement that mattered — the suite passes, 66/66 — was available without it.
