# v2.1.2 stores a PIN through its own bracket and then refuses it

v2.1.2 was `blocked` for the life of this project because its pinned commit
was not in the local checkout. Unblocking it (see
`android/okemu/scripts/versions/v2.1.2.js`) made it stageable for the first
time, and it gets further than any previously blocked release has: it stages
with no version-specific patches, builds, boots, and completes OKCONNECT.

**It cannot be unlocked.** The device accepts a PIN, confirms it through the
firmware's own six-step bracket, reports INITIALIZED afterwards, and then
never unlocks when that same PIN is entered.

## What was measured

Three matrix runs as production, then one deliberate debug build for the
console. Identical every time: ten passed, three failed, bailed after
`deviceFlow`.

```
  pressed 1 … 6, 1
    ✗ unlocks with the PIN -> the device did not unlock within 20000ms
    ✗ reads its labels now that it is unlocked -> probably locked
    ✗ writes a slot label and reads it back -> no reply on interface 2
```

The bus during the failure shows the device answering, not hung - it
broadcasts `INITIALIZED` once a second throughout, and answers the vendor
interface. It simply never reaches `UNLOCKED`.

## Everything that would explain it, ruled out by measurement

**Not stale flash.** The first failure was against a `v2.1.2` storage slot
created hours earlier, while the version was briefly mispinned to `8f74eac`.
That slot was deleted and the release provisioned itself from nothing. The
failure is identical on the fresh slot.

**Not the PIN bracket.** Provisioning completes every step, in order, on the
console the debug build provides:

```
  armed, entered, stored, confirming, re-entered, committed
```

Both entries are `1234561`, the firmware reported "Both PINs Match", and the
device reports INITIALIZED on the next boot. So a PIN was stored, and the
firmware agreed the two entries matched.

**Not the button mapping.** `buttonProbe` on the same debug build:

```
  mapping: {"1":1,"2":2,"3":3,"4":4,"5":5,"6":6}
    ✓ every button arrives as itself
```

All six buttons, each arriving as itself, 2924 characters of console. The
presses reach the firmware and the firmware names them correctly.

**Not the production gate.** It fails identically on a debug build, where the
console is present and prints the presses.

**Not the 2.1 line.** v2.1.0 staged as production - the same gate, the same
harness, the same PIN - unlocks on the first try:

```
    ✓ unlocks with the PIN
    ✓ reads its labels now that it is unlocked
    ✓ writes a slot label and reads it back
PASS  passed=7 failed=0
```

That also makes this the first release measured as production on the 2.1
line, and it passes.

**Not the touch threshold.** `remove-touchsense` - the branch this release was
cut from - comments out the "any button reads 20% lower than ref, recalibrate"
early return, and the 2.1.0→2.1.2 delta also changes the press threshold from
a fixed `ref+40` to a proportional `ref + touchoffset*(ref/50)`. Neither
matters here: the emulator's HAL reports 1000 idle and 6000 held
(`ok_hal.cpp:690`), which clears 1040 and 1240 alike. The press-detection
ladder and its button assignments are byte-identical between the two pins.

## So what is left

The PIN is stored by one path and evaluated by another, inside a single
build, and they disagree. `pass_keypress` (OnlyKey.ino) appends each press and
calls `password.profile1hashevaluate()`; provisioning writes the hash through
the setup bracket. Something between those two moved in the
2.1.0 → 2.1.2 delta, which is 1278 changed lines in `okcore.cpp` alone and
includes `de9b78e "Testing 24 hmac slots (#23)"` - a change to how slots are
laid out, and therefore a candidate for having moved what the hash is stored
beside.

**Not chased further, deliberately.** This is one release of nine, it was
unreachable until today, nothing depends on it, and the remaining work is
production-readiness rather than archaeology. The next measurement, for
whoever picks it up, is a `Serial.println` of the stored hash at set time and
at evaluate time in a throwaway `.stage` copy - which says whether the two
disagree on the hash or on where it lives.

## Status

`v2.1.2.js` is `boots`, which is exactly what was watched happen: it stages,
builds, starts on a phone and completes OKCONNECT. It is not `tested` and
should not be recorded as such.
