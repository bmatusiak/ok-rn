# Findings from porting the firmware to Android

Everything found while getting `libokemu.so` to build for Android, with its
reporting status. The status column is the point of this file: the write-ups
themselves say what was found and how it was measured.

**Nothing here has been reported yet.** That is a fact about this repo, not a
judgement about the findings.

None of these are exploitable on a physical OnlyKey. They are hosting and
toolchain defects — with one exception, `#2`, which is a live hazard for the
*device* build the moment its toolchain is updated.

`#7` is the odd one out: not a defect in anyone else's code but a bug of ours,
recorded because the firmware behaviour that caused it is undocumented and the
wrong version of the table looks exactly like the right one.

| # | finding | severity | ours? | reported |
|---|---|---|---|---|
| 1 | [64-bit pointer narrowing](FINDING-64bit-pointer-narrowing.md) | blocking on 64-bit; one site feeds a truncated length into a bounds check | 2 of 6 sites | no |
| 2 | [`uECC.c` implicit declaration](FINDING-uecc-implicit-declaration.md) | **blocking on GCC 14+ / clang 16+, device build included** | vendored | no |
| 3 | [`Print::printf` fd round-trip](FINDING-print-printf-fd-roundtrip.md) | low — unreachable in the compiled set | Teensy core | no |
| 4 | [Arduino `Time` is host-hostile](FINDING-arduino-time-host-hostile.md) | blocking off glibc / on case-insensitive filesystems | Arduino | no |
| 5 | [`okemu_hal_shutdown()` leaks the flash mapping](FINDING-emu-shutdown-leaks-mapping.md) | blocking for in-process restart; error message misdirects | emulator | no |
| 6 | [a bad flash mapping looks healthy](FINDING-emu-degraded-mode-is-silent.md) | silent loss of all crypto capability — **now structurally impossible** | emulator | no |
| 7 | [the touchpin order is not the button order](FINDING-touchpin-order-is-not-button-order.md) | high for anything that presses buttons | **ours** | n/a |
| 8 | [holding button 3 ends the soft key](FINDING-lock-gesture-ends-the-soft-key.md) | high for the soft-key goal; a deliberate user gesture disables the device | **ours** | n/a |
| 9 | [every BLE fragment after the first was dropped](FINDING-ble-notifications-dropped-after-the-first.md) | blocking — no CTAP2 response could reach a host intact | **ours** | n/a |
| 10 | [an unanswered descriptor read stalls every connection](FINDING-descriptor-read-stalls-every-connection.md) | blocking — discovery never completed, and it poisons the host cache | **ours** | n/a |
| 11 | [setting a PIN only works on a DEBUG build](FINDING-provisioning-needs-a-debug-build.md) | blocking for first-time setup on a release build | OnlyKey firmware | no |
| 12 | [Windows reserves GATT 0xFFFD](FINDING-windows-reserves-the-fido-service.md) | none — bounds how the BLE path can be tested | Windows | n/a |
| 13 | [holds were timed against a counted band](FINDING-holds-were-timed-against-a-counted-band.md) | high — overshooting a hold runs backup() or restarts the key | **ours** | n/a |
| 14 | [presses are discarded for 20s after a FIDO2 ceremony](FINDING-presses-discarded-after-a-fido-ceremony.md) | medium — the key ignores its buttons and only a yellow LED says so | OnlyKey firmware | no |
| 15 | [a slot write after a label read is never looked at](FINDING-slot-write-after-a-label-read-is-lost.md) | medium — was ~40% of writes; **fixed**, and the cause was found by a debug line that was absent | **ours** | n/a |
| 16 | [dead keys were dropped from the keyboard override](FINDING-deadkeys-were-dropped-from-the-keyboard-override.md) | medium — accented characters typed as their bare base key, silently | **ours** | n/a |
| 17 | [only US English types on a debug build](FINDING-only-us-english-types-on-a-debug-build.md) | medium — a settable preference that disables typing entirely | OnlyKey firmware | no |
| 18 | [two characters, one keystroke](FINDING-layout-tables-map-two-characters-to-one-keystroke.md) | low here, medium upstream — Portuguese types ^ as ~ on real hardware | OnlyKey firmware | no |
| 19 | [a `=+` typo assigns to the accent mask](FINDING-keylayouts-nested-assignment-typo.md) | low — reaches the ISO-8859-1 tables only | OnlyKey firmware | no |
| 20 | [loading a key needs config mode, which never ends](FINDING-loading-a-key-requires-config-mode.md) | high for the Keys screen — provisioning and using a key cannot share a firmware lifetime | OnlyKey firmware | no |
| 21 | [the three-digit signing challenge is one press](FINDING-the-signing-challenge-is-one-press.md) | medium — weaker than it looks, and the extra presses type passwords | OnlyKey firmware | no |
| 22 | [no side-effect-free confirmation press](FINDING-no-side-effect-free-confirmation-press.md) | design constraint — every press on an unlocked key types a slot, so a press cannot mean "yes" | OnlyKey firmware | no |
| 23 | [a re-lock was invisible to the app](FINDING-relock-was-invisible-to-the-app.md) | high — an unlocked UI over a locked key, and the PIN door never returned; **fixed** | **ours** | n/a |
| 24 | [unlocking in config mode is never announced](FINDING-config-mode-unlock-is-silent.md) | medium — a client waits forever over a device that is ready | OnlyKey firmware | no |
| 25 | [a PIN typed at finger speed loses digits](FINDING-pin-taps-are-dropped-not-queued.md) | high — the first thing anyone does, near-silent, and the buffer cannot be cleared; **fixed** | **ours** | n/a |
| 26 | [two counted presses with no gap are one longer press](FINDING-counted-presses-merge-without-an-idle-gap.md) | high — the durations SUM, and past 72 that is backup() or CPU_RESTART(); **fixed** | **ours** | n/a |
| 27 | [a published Bluetooth keyboard is neither visible nor reachable over an old bond](FINDING-a-published-keyboard-is-neither-visible-nor-reusable.md) | medium — registers cleanly and cannot be paired with, with no error anywhere | Android | n/a |
| 28 | [a connected Bluetooth keyboard that would not type](FINDING-the-keyboard-was-gated-on-a-notification.md) | medium — the profile said connected, the screen said connecting, and typing was hidden; **fixed** | **ours** | n/a |
| 29 | ["extension not supported" is really a preference bit](FINDING-a-preference-bit-masquerades-as-an-unsupported-feature.md) | medium — two consecutive statuses, neither naming its own cause | OnlyKey firmware | no |
| 30 | [the derived password was the wrong 32 bytes](FINDING-the-shared-secret-response-is-two-values.md) | high — deterministic, label-sensitive, and not what any other client derives; **fixed** | **ours** | n/a |
| 31 | [the vault worked in every test and failed on the phone](FINDING-a-global-that-only-exists-in-the-test-runner.md) | high — Hermes has no TextDecoder, and the error was reported as a wrong key; **fixed** | **ours** | n/a |
| 32 | [the OpenPGP fork did not load under Hermes](FINDING-the-openpgp-fork-does-not-load-under-hermes.md) | high — blocked composite PGP key generation on the phone, silently, and was recorded as working; the cause was Metro swallowing a module-scope WebCrypto throw; **fixed** | **ours** | n/a |
| 33 | [every CPU_RESTART() killed the app](FINDING-cpu-restart-writes-to-unmapped-memory.md) | high — the idle lockout, the lock gesture and every wipe took the process down; **fixed** | **ours** | n/a |
| 34 | [enabling touch-free derive mid-run kills CTAPHID](FINDING-enabling-touch-free-derive-mid-run-kills-ctaphid.md) | medium for the suite - six device tests fail with a timeout that names nothing, and a second run is green | **ours** | n/a |
| 35 | [a shipped release needs thirteen fixes to run hosted](FINDING-v3.0.2-cannot-run-hosted-without-thirteen-fixes.md) | high for the version matrix - v3.0.2 could not be unlocked at all, and blamed the PIN; **fixed**, 67/67 | OnlyKey firmware | no |
| 36 | [old firmware blocks for a touch instead of asking](FINDING-old-firmware-blocks-for-a-touch-instead-of-asking.md) | high for any host written against newer firmware - every press-required derive fails and the device blames the user | OnlyKey firmware | no |
| 37 | [a pinned release is the travel edition](FINDING-a-pinned-release-is-the-travel-edition.md) | high for the matrix - v2.1.1 cannot be given a PIN as pinned, and nothing says why | ours / the pin | n/a |
| 38 | [a DUO has two pads and its third button is a chord](FINDING-the-duo-third-button-is-a-chord.md) | high for any host that presses buttons on a DUO - button 3 does nothing and button 2 answers as something else | OnlyKey firmware | no |
| 39 | [the backup refusal is typed, and blocks the device](FINDING-the-backup-refusal-is-typed-and-blocks-the-device.md) | medium for any host that scripts a backup - the device answers nothing on vendor for five to nine seconds and nothing says why; the NEXT thing tried fails | OnlyKey firmware | no |
| 40 | [USB claims one interface and the app needs three](FINDING-usb-claims-one-interface-and-the-app-needs-three.md) | high for real hardware - over USB the app can speak CTAPHID and nothing else; no PIN, no slots, no labels, no backup. The one interface it claims is picked by a three-way tie-break | ours | n/a |
| 41 | [blocking presence fails a second shared secret](FINDING-blocking-presence-fails-a-second-shared-secret.md) | high for the 2.1 line - the derive retry went out with NO press, so it could not succeed however many times it ran; the vault round trip was one of the casualties. **Fixed**, 68/68 | ours | n/a |
| 42 | [the debug console is a control channel on new firmware only](FINDING-the-debug-console-is-a-control-channel-on-new-firmware-only.md) | high for real hardware - it decides whether a developer key can be driven unattended, and unlock()'s default path silently cannot work on ANY released firmware | OnlyKey firmware | n/a |
| 43 | [probing on a locked key burns PIN attempts](FINDING-probing-on-a-locked-key-burns-pin-attempts.md) | high for anyone iterating on a press probe - repeated `--only` runs of a locked-state press suite WIPED the bench key back to unconfigured | ours | n/a |

## Read #6 first, then #2

**#6 is the one that cost real time**, and it cost it by passing. A flash
mapping that lands too high leaves a device that boots, answers HID, drives its
LED and returns its real version string — while silently unable to perform any
crypto. The warning goes to stderr, which Android discards, and `FSEC` is then
set to already-provisioned so the crash it warns about never happens. This
project believed it, wrote it up as a success, and had to retract that. The
write-up says how it presented and what would have caught it.

**#2 is the one that reaches furthest.** It is the only finding here that does
not depend on hosting, on 64-bit, or on Android.
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

Three entries patch OnlyKey's own source. The emulator's convention is that
anything the firmware needs in order to build hosted belongs upstream under
`#ifdef OK_EMULATOR`, never as a textual patch, precisely because patches stop
applying silently when upstream whitespace moves. That rule cannot be followed
from here, so each site says in `stage.js` what it should have been:

- `okcrypto.cpp` and `ctap_parse.cpp`, both from finding #1, want an
  **unconditional** correction rather than an `#ifdef` — `uintptr_t` is a
  32-bit type on the MK20DX256, so the device build would be byte-identical.
- `okcore.h`'s flash rebase is the opposite case, and the only genuinely
  emulator-specific patch here: it moves the origin of the flash array so the
  whole thing is mappable on Android, and it must **not** change the device
  build. That one really does want `#ifdef OK_EMULATOR`.

If a patch stops matching, `stage.js` fails the build rather than skipping it.
