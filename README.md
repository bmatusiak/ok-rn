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
| **USB HID** | Phone as USB **host** over OTG to a physical OnlyKey | Byte level only — see Known gaps |

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

Set `ANDROID_SERIAL` when more than one device is attached.

Firmware built with the DEBUG gate off — as it ships — is staged with
`OKEMU_PRODUCTION=1`.

### Building a released firmware version

`OKEMU_VERSION` builds a pinned release instead of the working tree, from the
commits `ok-versions.json` names:

```bash
node android/okemu/scripts/stage.js --list     # what OKEMU_VERSION accepts
node android/okemu/scripts/version-probe.js    # do the patches still match?
OKEMU_VERSION=v3.0.2 npm run android
```

Each release has its own stage script in `android/okemu/scripts/versions/`,
holding the patches that release needs and how far it has actually been taken:
`blocked`, `untried`, `stages`, `builds`, `boots`, `tested`. Sources are read
out of the pinned commit's object database into `.stage-src/`, so the firmware
checkouts are never written to.

### Developing without hardware

An Android emulator runs under QEMU and cannot pass host USB endpoints into the
guest, so the USB module has a second transport that speaks the same report
stream over TCP:

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

### USB HID — a physical OnlyKey over OTG

Same handset, with a real OnlyKey attached:

- enumeration finds it as `ONLYKEY - vid 0x1d50 pid 0x60fc`
- the Android permission dialog fires and the grant returns through
  `UsbPermissionBroker`
- the transport claims **interface 1** and negotiates a **64-byte** report size
- `CTAPHID_INIT` writes succeed, and **nothing answers**

Interface 1 is the OnlyKey's own raw-HID protocol, not CTAPHID. This was
measured before the library's interface handling existed, and has not been
re-run since — see Known gaps.

Note the ABI: that phone is 32-bit ARM. An APK built without `armeabi-v7a`
fails to install with `INSTALL_FAILED_NO_MATCHING_ABIS`.

## Known gaps

- **USB is not a device session.** `src/transport/UsbHid.ts` satisfies none of
  the six methods `node-onlykey-lib/src/transport/contract.js` requires, and its
  only consumer is a byte-level view behind the Testing tab. A plugged-in key
  cannot be driven as a device, which is also why the `CTAPHID_INIT` result
  above has never been revisited.
- **`rpId` is always empty on BLE request events.** A CBOR decoder exists in the
  library; it is not wired into the native event path.
- **The DUO has no screens.** The library handles it — 24 slots, four profiles,
  its own PIN encoding — and nothing in `src/` calls any of that.
- **No foreground service.** The GATT server will be throttled by the OS during
  a long desktop session; the permissions are declared and the service is not
  written.
- **iOS has never been compiled** — see [`ios/README.md`](ios/README.md). Two of
  six native modules exist. Its USB path deliberately rejects, since CoreHID is
  Swift-only and needs entitlements.
