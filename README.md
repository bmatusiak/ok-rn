# OnlyKey RN

React Native 0.87 app that runs the **real OnlyKey firmware on the phone**, and
also talks to physical OnlyKey hardware.

The firmware is not reimplemented here. `android/okemu` compiles
`OnlyKey-Firmware` and `libraries` — the actual C sources — for Android, and the
app drives them over JNI. So the phone IS a key, with the same protocol
behaviour, the same refusals and the same bugs as one on a keyring.

Everything above the wire lives in
[`node-onlykey-lib`](../node-onlykey-lib), the shared library this app and the
web app are both meant to use. **One lib, any GUI.**

| Path | What it does | Status |
| --- | --- | --- |
| **Soft key** | OnlyKey firmware compiled for Android, driven over JNI | Working; the app's default device |
| **PGP, age, vault** | Composite post-quantum PGP, X-Wing age identities, sealed credentials | Working on device |
| **Bluetooth HID** | Phone types passwords into another machine as a keyboard | Working |
| **FIDO2 BLE** | Phone as a roaming security key, CTAP2 over BLE to a desktop | Working; the firmware answers, the phone relays |
| **Hard key over USB** | Phone as USB **host** over OTG to a physical OnlyKey, as a full device session | Working; connect, unlock, slots, config mode, a signature made on the key — all measured |

Design notes and constraints live in [`EXPLAINER/`](EXPLAINER/); per-bug
write-ups are the `FINDING-*.md` files, indexed by [`FINDINGS.md`](FINDINGS.md).
Working rules are in [`CLAUDE.md`](CLAUDE.md).

## Architecture

```
                         React Native (TypeScript)
                     src/screens · src/hooks · src/transport
                                    │
                     node-onlykey-lib  (protocol, crypto, device)
                                    │
                     TurboModule boundary (specs/*.ts, codegen)
                                    │
   ┌──────────┬──────────┬──────────┼──────────┬──────────┐
   │          │          │          │          │          │
NativeOkEmu  UsbHid   FidoGatt  BtKeyboard  Secrets     Share
   │          │          │          │          │          │
 libokemu.so  USB OTG   BLE GATT   HID device  Keystore   SAF
 (firmware)   │         (0xFFFD)   profile     +Biometric
              OnlyKey    desktop    another     prompt
                         WebAuthn   machine
```

Payloads cross the bridge as **hex strings**, not `number[]`. A 64-byte report
is one 128-character string instead of 64 boxed doubles, which matters once
reports stream at HID interrupt rates.

## Requirements

- **Node** ≥ 22.11
- **JDK 17** — not 21 or 25. Android Studio's bundled JBR is too new for this
  Gradle/AGP pair. `winget install EclipseAdoptium.Temurin.17.JDK`
- **Android SDK** with platform `android-37`, build-tools `37.0.0`,
  **NDK `27.1.12297006`** and **CMake `3.22.1`**. RN 0.87 is
  New-Architecture-only, and the firmware is compiled from C, so the NDK is not
  optional.
- Sibling checkouts of `OnlyKey-Firmware`, `libraries` and the Teensy Arduino
  toolchain — `android/okemu/scripts/stage.js` copies and patches them into
  `.stage` at build time. They are READ-ONLY references; the patches go to the
  copy.
- A **USB OTG adapter** for the USB path. Charge-only cables fail silently.

`android/local.properties` is not checked in. Create it with your SDK path,
using forward slashes — a `.properties` file treats `\U` as an escape and will
mangle a Windows path:

```properties
sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk
```

## Running

```bash
npm install
npm start                # Metro
npm run android          # build + install
```

## Testing

```bash
npm run tsc                          # typecheck
npm test                             # jest, no device
npm run e2e:run                      # on-device suite, all of it
npm run e2e:run -- --only derive     # one suite, for iterating
```

The e2e suite runs **inside the app on the phone**, because that is the only
place the answers mean anything: the firmware is C over JNI and does not exist
in Node or in a Jest environment. `--only` takes suite function names and
restores itself afterwards, so a full run is what happens by default.

Set `ANDROID_SERIAL` when more than one device is attached - to the phone THE
KEY IS IN, not the one that happens to be cabled to the PC. The bench phone
for the hard key is a Pixel 6a on wireless adb (its port changes per
session; `adb mdns services` finds it); a Samsung on the same adb was
pinned by mistake for a morning and its stale USB history read as "the key
fell off the bus" (`FINDING-doctor-said-attached-for-a-key-that-was-not-on-the-bus.md`,
correction). `node tools/doctor.js` prints the serial next to its verdict.

The matrix builds each pinned release **as it ships** — the DEBUG gate off —
because a debug build opens a serial console the product does not have, and a
suite that proves something through that console proves it through a channel no
user has. `OKEMU_DEBUG=1` forces the other one, and provisioning needs it.

### Building a released firmware version

`OKEMU_VERSION` builds a pinned release instead of the working tree, from the
commits `ok-versions.json` names:

```bash
npm run e2e:matrix                             # build and run every release
node android/okemu/scripts/stage.js --list     # what OKEMU_VERSION accepts
node android/okemu/scripts/version-probe.js    # do the patches still match?
OKEMU_VERSION=v3.0.2 OKEMU_DEBUG=1 npm run android
```

**Pinned versions build as production, which is what they ship as.** A release
cannot be given a first PIN that way — the bracket is a conversation held
entirely in `Serial.println` — so `matrix.js` does one debug build to set the
PIN and goes straight back. Flash and EEPROM are files and outlive the APK, so
that happens once per version, ever.

Building a release with `OKEMU_DEBUG=1` by hand is still the right move when you
need the console to see what the firmware is doing. Just know what it changes:
`webcryptcheck()` returns "trust all origins for debug firmware" before
comparing anything, so the whole FIDO2 vendor path answers on a debug build no
matter which origin asked, while a real one compares. That hid a genuine bug
through thirteen green sweeps — the library was sending an origin no release
treats as first-party, so every derive went unanswered on released firmware
(`FINDING-the-vendor-path-is-origin-gated.md`). Two suites that read the serial
console to decide a verdict still refuse themselves on a production build, and
those skips are the honest report.

`OKEMU_STD=1` is the same lever for the standard-versus-travel edition, and the
keyboard layouts follow the DEBUG gate automatically — a production build
compiles all 26, a debug one keeps US English, which is the flash-overlap fix
the working tree needs.

Each release has its own stage script in `android/okemu/scripts/versions/`,
holding the patches that release needs and how far it has actually been taken:
`blocked`, `untried`, `stages`, `builds`, `boots`, `tested`. Sources are read
out of the pinned commit's object database into `.stage-src/`, so the firmware
checkouts are never written to.

### Developing without hardware

**Not needed until iOS work starts.** On Android the app talks to a real key
over OTG, and the byte-level panel is a window on that same pipe. What follows
is kept for the emulator case: an Android emulator runs under QEMU and cannot
pass host USB endpoints into the guest, so the native USB module has a second
transport that speaks the same report stream over TCP:

```bash
npm run mock             # tools/hardware-emulator.js on :9000
```

The emulator reaches your machine's loopback at `10.0.2.2`; the iOS Simulator
uses `127.0.0.1`. Transport selection is `auto` by default, which resolves to
TCP **only** on a debug build running on an emulator — a debug build on a real
phone still talks to real hardware.

The mock answers `CTAPHID_INIT` and carries fault-injection switches, so error
paths can be tested deliberately instead of by yanking cables:

```bash
node tools/hardware-emulator.js --drop-rate 0.3      # lose 30% of responses
node tools/hardware-emulator.js --fail-checksum      # corrupt every response
node tools/hardware-emulator.js --drop-after 5       # hang up after 5 reports
node tools/hardware-emulator.js --latency 500        # slow responses
node tools/hardware-emulator.js --heartbeat 2500     # unsolicited reports
```

Note this mock stands in for a USB OnlyKey, not for the soft key — the soft key
is the real firmware and needs no stand-in.

## Layout

```
specs/                  TurboModule specs; codegen reads these (six modules)
src/
  transport/            OkEmu (firmware), UsbHid, FidoGatt — typed native clients
  hooks/                useOkEmu, useConfigMode, useBtKeyboard, useUsbHid,
                        useFidoGatt, useWipeOnLock, useSecureScreen, …
  screens/              19 screens: Key, Slots, Keys, Backup, Crypto, Messages,
                        Keyboard, Tools, Settings, Security, Log, …
  biometrics.ts         biometric-gated secrets and PIN auto-unlock
  onlykey.ts            builds the node-onlykey-lib plugin app
  ui/                   shared components + theme
__e2e_tests__/          the on-device suite
android/okemu/          the firmware, compiled for Android
  scripts/stage.js      copies + patches the read-only firmware into .stage
  scripts/version-probe.js
android/app/src/main/java/com/okrn/
  emu/                  NativeOkEmuModule — starts and drives the firmware
  usb/                  HidTransport + UsbHostTransport + TcpTransport
  fido/                 CtapBleFramer + NativeFidoGattModule
  btkbd/                Bluetooth HID device profile
  secrets/              clipboard, FLAG_SECURE, BiometricVault
  share/                Storage Access Framework
ios/                    two of six modules; see ios/README.md
```

## Protocol

The USB and BLE paths speak **CTAPHID** framing, from
`node-onlykey-lib/src/protocol/ctaphid.js`, because a HID endpoint delivers
fixed-width packets rather than messages:

```
INIT packet:  [CID:4][CMD|0x80:1][BCNTH:1][BCNTL:1][data: n-7]
CONT packet:  [CID:4][SEQ:1 (0..0x7f)][data: n-5]
```

The BLE path adds CTAP's own 3-byte BLE fragmentation (`CtapBleFramer.kt`),
sized to the negotiated ATT MTU. Report width is read from the endpoint's
`maxPacketSize` rather than assumed to be 64.

## Verified on hardware

### Soft key — the firmware running on the phone

Galaxy A13 (SM-S136DL, Android 13, **armeabi-v7a** — a 32-bit-only build):

```
okemu        : firmware started, storage=/data/user/0/com.okrn/files/okemu
ReactNativeJS: [softkey] OKCONNECT ok: "UNINITIALIZEDv3.0.4-testc"
```

- `flash.bin` (262144 B) and `eeprom.bin` (2048 B) created at the device's own
  sizes in app-private storage
- the NeoPixel reports `#00af00`, so the main loop is running rather than having
  answered once and stopped

**Why OKCONNECT is the pass condition and "it booted" is not.** Android pins
`vm.mmap_min_addr` at `0x8000` and an unprivileged app cannot lower it, while
the firmware reaches `certified_hw` at `0x5BB0`. A bad mapping produces a device
that boots, answers HID, and then faults the first time it encrypts anything.
OKCONNECT performs the NaCl key exchange, so completing it exercises that
mapping.

State DOES persist across a restart: the e2e runner force-stops the app between
runs and the device comes back provisioned, because `flash.bin` and
`eeprom.bin` outlive the process.

### A hard key over USB — a physical OnlyKey over OTG

The same library plugins that drive the soft key drive a real one: the app
claims the key's HID interfaces (`UsbPipe`, `plugins/transport/usb`), and
everything above the byte pipe — session, device, crypto, every screen — is the
same code. Measured on the bench key (a developer build, whose debug console
reads commands; a production key has no fourth interface and is pressed with a
finger):

- four interfaces, each identified **by HID usage page**, not by position —
  three are otherwise identical on the wire (`FINDING-usb-claims-one-interface-and-the-app-needs-three.md`)
- the vendor interface answers `OKCONNECT`; the key's once-a-second status
  broadcast drives the lock door
- wipe, provision (the firmware's own OKSETPIN bracket) and unlock through the
  console — `__e2e_tests__/16-hardKeyProvision.e2e.js`, named-only
- a slot written and typed back over the **claimed keyboard interface**, so
  what the key types goes nowhere on the phone but the app's capture pane
- config mode entered and left, the vault's touch-free derive preference set,
  a composite post-quantum PGP key loaded into RSA slot 1, and a signature
  made **on the key** behind two button challenges —
  `__e2e_tests__/17-hardKeyConfig.e2e.js`, named-only

The two named-only suites change the key (wipe, preferences, RSA slot 1) and
reboot it. They run only under `--only`, skip every test otherwise, and want
the app pinned to the soft key while they run.

Keys are **compared, never merged**: one is active at a time, chosen on the
This Key tab (auto or manual, with an override), and no screen blends readings
from both. A hard key reports no LED and draws no keypad unless its console can
press for it.

Seeing what the phone is doing, from a terminal:

```bash
node tools/doctor.js --shot     # bench state on one screen, plus a screenshot
node tools/logwatch.js --follow # the app's own log, one line per event
node tools/tap.js Menu Slots    # drive one screen without a full run
```

The bench phone is arm64. An older 32-bit handset needs `armeabi-v7a` in the
APK or it fails to install with `INSTALL_FAILED_NO_MATCHING_ABIS`.

## Since the audit (2026-09-11)

Everything the desktop and web apps offer that this app did not, from a
side-by-side inventory of both, and the half-done things the FINDINGs named:

- **Keys tab**: Signature / Decryption / Backup roles on a raw key, "also the
  backup key" on a PGP one (`MODIFIER` bits the library had and the screen
  never set); **OpenSSH import** - the library reads the openssh-key-v1
  container itself (`node-onlykey-lib/src/device/openssh.js`, sshpk does not
  run under Hermes) and `device.loadSshKey` loads one key into one slot.
  cryptoSign verifies the device's signature against the fixture's public key.
- **Settings**: change a PIN on a key that already has one (config mode, the
  firmware's rule); a **Permissions** section that shows Bluetooth and
  notification state and can ask again or open the system page.
- **Messages**: look a recipient's public key up on Keybase, ProtonMail or a
  URL - on the press only, never on its own (`src/keySearch.ts`).
- **Crypto**: the vault reaps expired sessions every 30 s and on resume;
  "delete everything" behind a confirm.
- **Keypads** say when a press would be dropped: the soft key from its LED,
  a hard key from a 20 s timer after a relayed FIDO ceremony.
- **This Key**: the halt banner offers the restart from every tab; the hard
  key counts ticks under a finger like the soft one; restart and wipe go
  through the library; a locked hard DUO is drawn as a DUO (the firmware says
  INITIALIZED-D once a second - untested on a hard DUO, the bench has a Classic).
- **DUO screens**: 24 slots, the typed PIN form, model from the build.
- **Security**: a foreground service with a notification while the GATT
  server is up (`FidoGattService.kt`); `rpId` filled from the CTAP2 payload
  with the library's CBOR decoder. The BLE path itself is only exercised by a
  real paired desktop, which the bench has not.
- **Firmware update**: library-first (`device.requestFirmwareUpdate`,
  `device.sendFirmware`, tested against a fake bootloader) and a screen on
  the Testing tab that fetches a signed file from its release URL and gates
  the two irreversible steps behind a typed word. **Not yet run on a key**, and
  the reason is the bootloader rather than caution: a production bootloader
  takes SIGNED firmware only, and a developer bootloader refuses signed
  firmware and takes only an unsigned build from the Docker firmware builder.
  The bench key is a developer key, so nothing in `signed_firmware/` can go
  onto it. A production key is the last step.
- **Tools**: `doctor.js` names the phone it read; `e2e.js` fails at once on a
  wrong suite name; the hard-key suite skips, by name, when no key is attached.

## The kitchen sink (2026-09-11)

The library is the one implementation of the protocol and this app is its only
GUI, so a capability the library has and no screen reaches is a capability
nobody has. An inventory found twelve `device` methods, eighteen `okcrypto`
ones, three `FidoAdmin` ones and thirteen `capabilities()` fields that only
tests could reach. Two ordinary questions found the worst of it - "how does
the FIDO2 PIN get set the first time?" and "can I change it?" - where the
honest answer was "the library can, the app cannot".

The tab bar after this: This Key, Slots, Keys, Bluetooth, Backup, Crypto,
Messages, Settings, Advanced, Passkeys, Log, plus Testing when enabled.

- **Passkeys** sets a FIDO2 PIN and changes one, with the remaining attempts
  beside the field and the last attempt refused without `allowLastAttempt`.
  `getInfo` is rendered in full. Set and change were verified on the bench key,
  and a real WebAuthn registration over Bluetooth followed - a 239-byte
  `makeCredential` with `rk` and `credProtect` from a desktop browser.
- **Bluetooth** is one tab. The BLE keyboard and the BLE security key were on
  separate tabs called Keyboard and Security; both are the phone acting as a
  Bluetooth peripheral, and a person looking for either was looking for the
  radio.
- **Advanced** holds the irreversible and the developer-only, with the typed
  words kept and no testing mode needed: firmware update, factory wipe, the
  debug console with `consoleAnswers()`, the device-type override beside the
  detected type. The Tools tab is gone - it was links to web pages for things
  this app now does, and the page cannot reach this key anyway. Its two
  desktop-agent guides moved here, because those genuinely happen on a
  computer.
- **Crypto** signs and decrypts with a key held in a slot, picks the curve a
  label derives under (a label derives a DIFFERENT key on each), and opens an
  age file from an identity string. A real 64-byte signature came back from
  slot 101 through the screen. Live use found what review had not: the
  challenge appeared here while the keypad that answers it was on another tab,
  so "press them for me" is now on the section.
- **Keys** reads the public half out of a slot, hex and base64, with the size
  chosen because the reply carries none.
- **This Key** lists every `capabilities()` field, and tracks config mode for
  as long as the session lives. Config mode ends at a reboot and at nothing
  else: `OKCONNECT` answers UNLOCKED from inside it. So the library clears the
  flag on `restart()` and `wipeUserspace()` and NOT on `connect()`, a USB
  detach drops the session, and the banner says what the app did rather than
  claiming to have detected anything.
- **Backup** reads a file before arming the button that overwrites the key.
  The restore always verified its own digest chain, so nothing damaged could
  reach the key; what was missing was finding out without pressing a
  destructive control. It also names a firmware file pasted by mistake, which
  is one wrong paste away now that Advanced can flash one.
- **Faded, not hidden.** A feature the attached firmware does not have is
  drawn at low opacity with a line saying why, and "unknown is not absent" -
  a null capability report fades nothing. Measured on a real release: built
  v3.0.2 and watched the post-quantum section fade, while its suite refused
  itself with "this firmware predates post-quantum support - no release has
  it". **No released firmware has post-quantum support**; it is in the
  development line the bench keys run.

Four bugs the work found, each with its own FINDING:

- The CTAP2 status table was shifted, so three errors were reported under the
  wrong names, and a comment claimed to have corrected a value that was right.
- A collector ate the previous reply's reports, so a slot-label listing was
  read as key bytes.
- Config mode refuses a public-key read in silence - the allow-list is eleven
  messages and everything else is dropped to a console nobody reads.
- The BLE bridge relayed to the wrong key: a hook above the provider read the
  context default rather than the active key.

And two more since:

- A vault policy change was never stored, so the control snapped back - and,
  worse, a credential stored under `always` had its key cached again after a
  restart.
- The 2019 beta seeded its RNG from an address that was a reading:
  `RNG.stir((uint8_t *)analog1, ...)` where `&analog1` was meant, ten times
  - twice in setup and eight more in the loop that runs forever. It reads
  mapped flash on a Teensy and segfaults on a phone. Patched, and the release
  now boots, provisions and answers.

## The firmware matrix (swept 2026-09-12)

Every pinned release, built from its own sources and run against the whole
suite on the phone. `node tools/matrix.js` does all of it; one name does one.

| build | result |
|---|---|
| working tree | 107 passed, 23 skipped |
| working tree (DUO) | 103 passed, 27 skipped |
| v3.0.4 | 60 passed, **5 failed**, 3 skipped |
| v3.0.3 | 60 passed, **5 failed**, 3 skipped |
| v3.0.2 | 94 passed, 36 skipped |
| v3.0.1 | 95 passed, 35 skipped |
| v3.0.0 | 95 passed, 35 skipped |
| v2.1.2 | **blocked** - its pinned commit is on a branch this fork lacks |
| v2.1.1 | 95 passed, 35 skipped |
| v2.1.0 | 95 passed, 35 skipped |
| v0.2-beta.8 | 14 passed, **3 failed** - stops at the unlock |

The pins are upstream release TAGS, checked against the GitHub API rather than
inferred; the two that have no tag are derived by release date and the rule is
in `android/okemu/scripts/versions/index.js`. A skip is not a pass: a firmware
without a feature refuses itself by name, which is why the older releases skip
thirty-five tests and the working tree twenty-three.

**The two failing releases are the library, not the firmware.** v3.0.3 and
v3.0.4 disprove two capability boundaries that were written as guesses about
the release after v3.0.2 - `touchFreeDerive` and `postQuantum`. Neither is
changed yet, because the development tree also declares 3.0.4 and no version
threshold can separate them. See
[the finding](FINDING-capability-guesses-about-the-next-release-were-wrong.md).

**v0.2-beta.8 stops at the unlock**, and not by crashing: the firmware calls
`CPU_RESTART()` itself, from the integrity check that this release threads
through thirty-odd paired counters. See
[the finding](FINDING-the-2019-beta-restarts-itself-during-pin-entry.md).


## Known gaps

- **Firmware update has not touched hardware.** See above; the screen and the
  library say so in their own text until a production key has taken one.
- **The BLE security-key path** has now carried a real ceremony: a desktop
  browser registered a passkey over Bluetooth, and the key answered with a
  239-byte `makeCredential`. What is still untested is the rest of the
  ceremony vocabulary - assertions, credential management over the radio, and
  anything a second paired host would do.
- **iOS has never been compiled** - see [`ios/README.md`](ios/README.md). Two of
  six native modules exist. Its USB path deliberately rejects, since CoreHID is
  Swift-only and needs entitlements.
