# v2.1.2 was staged without the flash-stride patch, so half of every PIN hash was lost

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

## The cause, read straight out of flash.bin

Every guess above was made by reading the firmware. The answer came from
reading the FILE. After a clean provision on the debug build, `flash.bin` was
pulled off the phone and searched for the two 32-byte values the firmware had
just printed - the nonce it generated and the public key it said it stored.
Neither was found. Looking at the only two sectors with anything in them:

```
sector 118 (0x3b000)         <- flashstorestart 0x3A800 + 2048, "2nd free sector"
   +0..3    e3e66c62         <- nonce word 0, byte-reversed; then FOUR BYTES OF 0xFF
   +8..11   50f04142         <- nonce word 1; then 0xFF again
   +16..19  5ca32a29
   ...
   +64..67  e8124951         <- p1hash word 0, same 4-written / 4-skipped stride
```

The values are there, at the right offsets, as little-endian 32-bit words -
and only EVERY OTHER word survived. The firmware walks flash with
`unsigned long *adr`, which is 4 bytes on a Teensy and 8 on a 64-bit Android
host, so the write advances twice as far as the byte buffer beside it and
half the words never land. Read back, the nonce and the hash are each half
`0xFF`, and nothing hashed from them can ever match.

This is `shared.flashWalkStride`, which `_shared.js` describes as "without
this the PIN never matches", and which v2.1.0, v2.1.1 and every 3.0.x
script imports. **v2.1.2's script had `patches: []`**, on the stated
reasoning that copying v2.1.1's list "would record a measurement nobody
made". That caution was the bug. `okcore_flashsector` is byte-identical
between v2.1.1 and v2.1.2, and every one of v2.1.1's twelve patches matches
this release's sources - stage.js refuses a literal that does not match, so
one that did not belong would have said so.

Everything earlier in this file follows from that: a stable stored hash that
matches nothing, a "PIN" the firmware confirmed (the bracket compares the two
entries in RAM, which are fine) and then refused (the check reads flash, which
is half empty), and a self-destruct slot that happened to hold a
half-written value that lined up with one printed elsewhere.

**Fix:** `v2.1.2.js` imports v2.1.1's patch list. Twelve patches, all
applied.

## A real bug was found on the way, and it was NOT this one

`setPin` was returning before the device had finished storing the PIN.
"Both PINs Match" is printed at the TOP of the firmware's commit block, and
what follows is a fresh nonce2 into EEPROM, a nonce into flash on first use,
two Curve25519 evaluations and a 254-byte sector rewrite - with the hash
taken from `password.guess` at that moment. Measured with the console tapped
across one provisioning and the unlock that followed:

```
===== SETTING THE PIN =====
Both PINs Match                 <- setPin returned here
===== ENTERING THE PIN =====
Generating NONCE                <- still committing, while we pressed
Storing public key of PIN hash =
Successfully set PIN
```

Fixed in `node-onlykey-lib` with a seventh bracket step that waits for
"Successfully set PIN" and sends nothing. Every release from v2.1.1 through
HEAD prints that line. It did not fix v2.1.2, because the stride bug sits
underneath it; it would have bitten any release eventually.

## Wrong turns, recorded so nobody re-walks them

Each cost a build and a run, and each is ruled out. (1) An off-by-one in the
PIN buffer - the counter is printed after the evaluate on the failure path,
so the block belongs to the seventh press. (2) The presses landing in the
setup state machine - there are two `password appended with` prints and the
one that fires is the unlock path's. (3) A bare OKPIN tripping the setup
wizard via `recv_buffer[5]` - real branch, but the library sends byte 5 = 0.
(4) The `Profile_Offset` type patch - v2.1.2 declares two `uint8_t`, so it
does not need it. (5) EEPROM overflow - the layout tops out at 1984 of 2048.
(6) A moving chip ID or nonce - byte-identical across restarts.

The lesson is the one the matrix was built on and this file forgot for a
day: **measure the artefact, not the source.** The flash file answered in one
command what six readings of the firmware could not.

## Status

**Fixed.** `v2.1.2.js` is `tested`: 87 passed, 0 failed, 43 skipped, swept as
production on a wiped slot. Blocked for the whole life of this project, and
green the same day it was unblocked.

Two things came out of it, and only one was the cause:

- **The cause** was an empty patch list, which denied this release the
  flash-stride fix every other 2.x and 3.x script imports.
- **A real bug found on the way**, fixed and kept: `setPin` returned before
  the device had finished storing the PIN. It would have bitten any release
  eventually.
