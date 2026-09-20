# Finding: RNG2 is declared `u8` and defined `unsigned`, and only one ABI forgives it

**Status:** measured on the Windows emulator build, 2026-09-20. Reproduced on
every run before the fix, gone on every run after. Root cause identified and
fixed via a staged patch.
**Severity:** memory corruption inside key generation. On Windows it killed the
process; on any target it is an unbounded write driven by a stale register.
**Found by:** `01-protocol/12-webauthn-tunnel` dying with `0xC0000005` and
leaving nothing behind to read.
**Whose code:** OnlyKey's, in the vendored tweetnacl copies - not a port
artifact.

## The defect

One symbol, two disagreeing declarations:

    libraries/onlykey/okcore.cpp:7630   int RNG2(uint8_t *dest, unsigned size)
    libraries/onlykey/okcore.h:369      extern int RNG2(uint8_t *dest, unsigned size);

    libraries/tweetnacl/tweetnacl.c:88               extern int RNG2(u8 *,u8);
    libraries/justhashtweetnacl/justhashtweetnacl.c:86  extern int RNG2(u8 *,u8);

C has no overloading, so both resolve to the same function. `crypto_box_keypair`
calls `RNG2(x,32)` through the `u8` declaration; `RNG2` reads `unsigned` and
passes it straight to `RNG.rand(dest, size)` over a 32-byte buffer.

## Why it is invisible on ARM and on Linux

This is an ABI difference, not a compiler one.

- **AAPCS** and the **SysV x86-64 ABI** require the CALLER to widen a narrow
  argument to a full register. The callee reading `unsigned` therefore sees
  exactly 32, and the mismatch has no effect.
- **The Microsoft x64 ABI does not.** The upper bits of a narrow argument are
  explicitly undefined and the callee may not rely on them.

So on Windows `size` is `32` in its low byte and whatever the register already
held above it. Nowhere else does the bug have consequences, which is why
firmware that has shipped for years is not obviously wrong.

## Why nothing could report it

Neither the SEH filter in `okemu_firmware_run()` nor a vectored exception
handler armed at module load ever ran, while the process still exited
`0xC0000005`. Windows dispatches VEH before any frame-based handler, so both
being skipped means exception DISPATCH could not proceed - and dispatch needs a
sane stack. An unbounded `RNG.rand()` write supplies the smashed stack.

That also disposes of three earlier hypotheses, each of which had looked
plausible and each of which was wrong:

- **Stack exhaustion.** 8 MB and 64 MB behaved identically, and a
  `SetThreadStackGuarantee` of 64 KB - which exists precisely so an overflow
  can still be reported - produced no report.
- **A short read past `client_handle`.** The tunnel's credential id is
  `HEADER 10` plus a payload padded to at least `MIN_DATA 16`, so the reads at
  indices 9..42 are inside the 256-byte buffer.
- **LLP64 pointer truncation.** Real in this codebase, but unsupported by any
  of the evidence here.

## How it was actually found

By console bisect, after the fault-reporting routes had all come back empty.
The firmware's own `DEBUG` output arrives reliably right up to the instant it
dies, so two temporary markers split the gap between the last known line and
the next expected one:

    Current Time Set to: ...          <- last known-good
    okemu-bisect: A set_time returned
    okemu-bisect: B memset done       <- last output
    (RNG2's own "Generating random number of size" never printed)

`crypto_box_keypair` is two statements: `RNG2(x,32)` then
`crypto_scalarmult_base`. Dying inside `RNG2` before its own debug line put the
fault in `RNG.available()` or `RNG.rand()`, and the prototypes did the rest.

The markers were removed once they had answered.

## The fix, and what it should be

Staged patch bringing the two tweetnacl declarations into line with the
definition. Scoped `platform: 'win32'` to leave the Linux build byte-identical,
in keeping with every other firmware fix in this port.

**That scoping is expedient, not right.** The declarations are simply wrong,
and correcting them upstream costs nothing on any target - a caller that
widens an already-correct value widens it the same. The Windows scope should
disappear the moment the fix can be made where the sources live.

## The general lesson

A prototype that disagrees with its definition is not a style problem. It is a
latent bug whose blast radius is decided by the calling convention, and it can
sit dormant for the entire life of a project until someone builds for a
platform that makes different guarantees. Compare
`FINDING-64bit-pointer-narrowing.md`: same shape, different ABI detail.
