# Findings from porting the firmware to Android

Everything found while getting `libokemu.so` to build for Android, with its
reporting status. The status column is the point of this file: the write-ups
themselves say what was found and how it was measured.

**Nothing here has been reported yet.** That is a fact about this repo, not a
judgement about the findings.

None of these are exploitable on a physical OnlyKey. They are hosting and
toolchain defects — with one exception, `#2`, which is a live hazard for the
*device* build the moment its toolchain is updated.

| # | finding | severity | ours? | reported |
|---|---|---|---|---|
| 1 | [64-bit pointer narrowing](FINDING-64bit-pointer-narrowing.md) | blocking on 64-bit; one site feeds a truncated length into a bounds check | 2 of 6 sites | no |
| 2 | [`uECC.c` implicit declaration](FINDING-uecc-implicit-declaration.md) | **blocking on GCC 14+ / clang 16+, device build included** | vendored | no |
| 3 | [`Print::printf` fd round-trip](FINDING-print-printf-fd-roundtrip.md) | low — unreachable in the compiled set | Teensy core | no |
| 4 | [Arduino `Time` is host-hostile](FINDING-arduino-time-host-hostile.md) | blocking off glibc / on case-insensitive filesystems | Arduino | no |

## Read #2 first

It is the only one that does not depend on hosting, on 64-bit, or on Android.
`uECC.c` calls a function eleven lines before defining it, relying on C's
implicit-declaration rule — which GCC 14 and clang 16 both turned into an
error. Nothing in the source has to change for that build to start failing;
only the compiler does.

## Checked and *not* a defect

Recorded because both look alarming and cost real time to rule out, and the next
person will wonder the same thing.

**`libraries/randombytes/randombytes.c` is DJB's `surf()` test PRNG with a
hard-coded seed, and it is compiled in.** It is never called. OnlyKey's vendored
tweetnacl was modified to use `RNG2()` — the ChaCha20 CSPRNG in
`libraries/Crypto/RNG.cpp` — so `crypto_box_keypair()` at `tweetnacl.c:528` does
not reach it, and ML-KEM/ML-DSA route through `onlykey_mlkem_randombytes()` /
`onlykey_mldsa_randombytes()` (`okcrypto.cpp:130`, `okpqc.cpp:46`), which both
call `RNG.rand()`. `grep -w randombytes` across the compiled set returns only
the PQC config headers that redirect it. The file survives as a symbol provider
and nothing more.

**`libraries/fido2/device.cpp.bak`** is a stray editor backup in the checkout.
It is not compiled — `gen-sources.js` matches `.c` and `.cpp` only — but it does
get copied into the staging tree, and it will confuse a `grep` for anything in
`device.cpp`.

## Not filed as findings

Differences between bionic and glibc, rather than defects in anyone's code.
Listed so the workarounds in `android/okemu/` have a rationale on record:

- **`backtrace()`** — bionic ships `<execinfo.h>` but gates the functions behind
  API 33. Both uses are diagnostic; they degrade to a note below that.
- **`fcvt()`** — obsolete in POSIX.1-2001, removed in POSIX.1-2008, never
  shipped by bionic. `nonstd.c`'s `dtostrf()` needs it for `String(float)`.
  Supplied in `src/okemu_compat.c`.
- **`-fbracket-depth`** — `okeeprom.c` builds its address tables as one deeply
  parenthesised constant expression, past clang's default 256 nesting cap. GCC
  has no equivalent limit.
- **`-fpermissive`** — a GCC flag with no clang equivalent, which the Node
  emulator relies on. This was expected to be the hard part of the port and was
  not: it needed a named warning-suppression list, nothing structural.

## Where the fixes live

All of them are in `android/okemu/scripts/stage.js`, applied to *staged copies*.
`OnlyKey-Firmware` and `libraries/` are read and never written, matching
`node-onlykey-emulator`'s rule.

Two entries patch OnlyKey's own source — `okcrypto.cpp` and `ctap_parse.cpp`,
both from finding #1. The emulator's convention is that anything the firmware
needs in order to build hosted belongs upstream under `#ifdef OK_EMULATOR`,
never as a textual patch, precisely because patches stop applying silently when
upstream whitespace moves. That rule cannot be followed from here. Both sites
are marked in `stage.js` as belonging upstream, and both want an *unconditional*
correction rather than an `#ifdef`: `uintptr_t` is a 32-bit type on the
MK20DX256, so the device build would be byte-identical.

If a patch stops matching, `stage.js` fails the build rather than skipping it.
