# v2.1.2, as we stage it, stores a PIN through its own bracket and then refuses it

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

## So what is left, and it is probably OURS

The first version of this finding concluded that the PIN is stored by one path
and evaluated by another inside one build, and left it as a defect in the
release. **That was stated far too confidently.** The user asked whether
v2.1.2 was ever signed at all, which is exactly the right question, and the
answer settles the direction:

```
Signed_OnlyKey_2_1_0_STD  declares  v2.1.0-prod
Signed_OnlyKey_2_1_1_STD  declares  v2.1.1-prod
Signed_OnlyKey_2_1_2_STD  declares  v2.1.2-prod
```

read out of the bundled signed images' own string tables. **v2.1.2 shipped.**
A released firmware that cannot be unlocked would have been caught by the
first person who installed it, so the release is almost certainly fine and
this is our emulation of it.

Which makes the two live candidates:

1. **The staging.** `stage.js` applies eighteen shared literal patches, drops
   thirty-one bare-metal files, overlays nine core files and rebases
   fifty-seven system-block registers. v2.1.2 takes all of that with NO
   version-specific patches - the only 2.x release that needs none - and
   "needs no patches" and "needs one nobody has found yet" look identical from
   here. v2.1.0 and v2.1.1 each carry their own, which is the difference
   between them and this.
2. **The pin.** `12eb5b0` is the upstream `v2.1.2-prod` tag in `libraries`,
   but the signed image was built from a pair of commits, and only the
   `libraries` half is verified by that tag. `OnlyKey-Firmware@bbb910a` is
   pinned by the same convention and has not been checked against the signed
   image at all.

The next measurement is cheap and says which: `Serial.println` the stored hash
at set time and at evaluate time, in a throwaway `.stage` copy. If they
disagree on the VALUE, something in our patching corrupts the write. If they
disagree on WHERE, a layout offset moved - `de9b78e "Testing 24 hmac slots"`
is in this delta and is the obvious suspect.

**Not chased further, deliberately.** One release of nine, unreachable until
today, nothing depends on it, and the remaining work is production-readiness
rather than archaeology.

## Status

`v2.1.2.js` is `boots`, which is exactly what was watched happen: it stages,
builds, starts on a phone and completes OKCONNECT. It is not `tested` and
should not be recorded as such.
