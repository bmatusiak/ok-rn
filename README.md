# OnlyKey RN

React Native 0.87 app bridging an Android/iOS phone to OnlyKey hardware, with
two independent native paths:

| Path | What it does | Status |
| --- | --- | --- |
| **USB HID** | Phone acts as USB **host** over OTG and talks to a physical OnlyKey | Working on Android |
| **FIDO2 BLE** | Phone acts as a **roaming security key**, speaking CTAP2 over BLE to a desktop | Transport works; CTAP2 handlers are stubs |

Design notes and constraints live in [`EXPLAINER/`](EXPLAINER/).

## Architecture

```
                         React Native (TypeScript)
                    src/screens · src/hooks · src/transport
                                    │
                    TurboModule boundary (specs/*.ts, codegen)
                                    │
        ┌───────────────────────────┴───────────────────────────┐
        │                                                       │
  NativeUsbHid                                            NativeFidoGatt
        │                                                       │
  ┌─────┴──────┐                                    ┌───────────┴──────────┐
  │            │                                    │                      │
UsbHost      Tcp                              BLE GATT server        Android KeyStore
Transport    Transport                        (service 0xFFFD)       / Secure Enclave
  │            │                                    │                      │
USB OTG    10.0.2.2:9000                     Desktop WebAuthn        P-256 in TEE
  │        (127.0.0.1 on iOS sim)                   │                / StrongBox
OnlyKey    tools/hardware-emulator.js        CTAP2 over BLE
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
  New-Architecture-only, so the app compiles C++ into `libappmodules.so` and
  genuinely needs the NDK.
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

### Developing without hardware

An Android emulator runs under QEMU and cannot pass host USB endpoints into
the guest, so the native module has a second transport that speaks the same
report stream over TCP:

```bash
npm run mock             # tools/hardware-emulator.js on :9000
```

The emulator reaches your machine's loopback at `10.0.2.2`; the iOS Simulator
uses `127.0.0.1`. Transport selection is `auto` by default, which resolves to
TCP **only** on a debug build running on an emulator — a debug build on a real
phone still talks to real hardware. Override it from the Transport segmented
control on the USB screen.

The mock answers `CTAPHID_INIT` and carries fault-injection switches so the
error paths can be tested deliberately instead of by yanking cables:

```bash
node tools/hardware-emulator.js --drop-rate 0.3      # lose 30% of responses
node tools/hardware-emulator.js --fail-checksum      # corrupt every response
node tools/hardware-emulator.js --drop-after 5       # hang up after 5 reports
node tools/hardware-emulator.js --latency 500        # slow responses
node tools/hardware-emulator.js --heartbeat 2500     # unsolicited reports
```

## Layout

```
specs/                  TurboModule specs; codegen reads these
  NativeUsbHid.ts
  NativeFidoGatt.ts
src/
  transport/            CTAPHID framing, hex helpers, typed native clients
  hooks/                useUsbHid, useFidoGatt, useLog
  screens/              UsbScreen, FidoScreen
  ui/                   shared components + theme
tools/
  hardware-emulator.js  TCP stand-in for the USB device
android/app/src/main/java/com/okrn/
  usb/                  HidTransport + UsbHostTransport + TcpTransport
                        + UsbPermissionBroker + NativeUsbHidModule
  fido/                 CtapBleFramer + NativeFidoGattModule
  OkRnPackage.kt        registers both TurboModules
ios/                    Objective-C++ modules; see ios/README.md
EXPLAINER/              design notes and platform constraints
```

## Protocol

The USB path speaks **CTAPHID** framing (`src/transport/framing.ts`), because a
HID endpoint delivers fixed-width packets rather than messages, and anything
longer than one report arrives split across several:

```
INIT packet:  [CID:4][CMD|0x80:1][BCNTH:1][BCNTL:1][data: n-7]
CONT packet:  [CID:4][SEQ:1 (0..0x7f)][data: n-5]
```

The BLE path uses CTAP's own 3-byte BLE fragmentation
(`CtapBleFramer.kt`), sized to the negotiated ATT MTU.

Report width is read from the endpoint's `maxPacketSize` rather than assumed to
be 64.

## Known gaps

- **CTAP2 command handlers are not implemented.** Reassembled commands are
  forwarded to JS as `onCtapRequest`; JS supplies the response bytes.
  `makeCredential` / `getAssertion` CBOR encoding is the next piece of work.
- **No CBOR decoder**, so `rpId` is always empty on request events.
- **BiometricPrompt is not wired to the signing operation.** Keys are created
  with `setUserAuthenticationRequired(true)`, so `signWithCredential` throws
  `UserNotAuthenticatedException` until a prompt unlocks them.
- **No foreground service yet.** The GATT server will be throttled by the OS
  during a long desktop session; the permissions are declared but the service
  is not written.
- **iOS has never been compiled** — see [`ios/README.md`](ios/README.md). Its
  USB path deliberately rejects, since CoreHID is Swift-only and needs
  entitlements.
