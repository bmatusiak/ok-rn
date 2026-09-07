# ok-rn

React Native app that talks to an OnlyKey, and (separately) turns the phone into
a FIDO2 authenticator of its own.

Two independent native bridges, one per tab:

| Tab | Direction | Transport | Status |
|---|---|---|---|
| **USB HID** | phone → OnlyKey | USB OTG host mode, or TCP to a mock | working |
| **FIDO2 BLE** | desktop → phone | CTAP2 over BLE GATT, service `0xFFFD` | GATT layer working, CTAP2 handlers stubbed |

Design notes and constraints live in [`EXPLAINER/`](EXPLAINER/).

---

## Requirements

React Native 0.87 is New-Architecture-only, so the app compiles C++ and needs
the NDK even though it has no C++ of its own.

| | version | notes |
|---|---|---|
| Node | ≥ 22.11 | |
| JDK | **17** | Gradle/AGP will not build on Android Studio's bundled Java 25 |
| Android SDK | platform 37, build-tools 37.0.0 | |
| NDK | 27.1.12297006 | pinned in `android/build.gradle` |
| CMake | 3.22.1 | |

Point `android/local.properties` at your SDK (`sdk.dir=...`) and set `JAVA_HOME`
to the JDK 17 install.

---

## Run it

```sh
npm install
npm start                 # Metro
npm run android           # build + install
```

### Without hardware

The Android emulator runs under QEMU and cannot pass host USB endpoints through
to the guest, so the USB module has a second transport: a plain TCP socket to a
mock device.

```sh
npm run mock              # listens on 0.0.0.0:9000
```

The emulator reaches your host at `10.0.2.2` (the iOS Simulator uses
`127.0.0.1`). The **Transport** control on the USB tab picks between:

- `auto` — TCP mock on a debug build *running on an emulator*, USB otherwise.
  A debug build on a real phone still talks to real hardware, which is what you
  want with a device plugged in.
- `usb` / `tcp` — force one.

The mock answers `CTAPHID_INIT` and `CTAPHID_PING`, so the framing layer gets
exercised end to end. It also injects faults on demand, which is the only
practical way to test the error paths:

```sh
node tools/hardware-emulator.js --heartbeat 2500     # unsolicited reports
node tools/hardware-emulator.js --drop-rate 0.3      # lose 30% of responses
node tools/hardware-emulator.js --fail-checksum      # corrupt every response
node tools/hardware-emulator.js --drop-after 5       # hang up after 5 reports
node tools/hardware-emulator.js --latency 800        # slow responses
```

### With hardware

You need a phone that supports **USB host mode** and a real **OTG adapter** —
charge-only cables fail silently. On connect, Android shows a permission dialog;
that consent arrives as a broadcast rather than a return value, which is why
`connect()` is a two-step (`requestPermission` then `connect`).

`android/app/src/main/res/xml/device_filter.xml` lists the vendor/product ids
that bring the app to the foreground on plug-in — OnlyKey's `0x1d50/0x60fc` and
the Teensy `0x16c0/0x0486`. Note that file wants **decimal**.

---

## Layout

```
specs/                    TurboModule specs (codegen input)
  NativeUsbHid.ts
  NativeFidoGatt.ts
src/
  transport/              hex helpers, CTAPHID framing, typed native clients
  hooks/                  useUsbHid, useFidoGatt, useLog
  screens/                UsbScreen, FidoScreen
  ui/                     shared components + theme
tools/hardware-emulator.js
android/app/src/main/java/com/okrn/
  usb/                    HidTransport + UsbHostTransport + TcpTransport
                          UsbPermissionBroker, NativeUsbHidModule
  fido/                   CtapBleFramer, NativeFidoGattModule
  OkRnPackage.kt
ios/OkRN/
  NativeUsbHid.{h,mm}     TCP transport; CoreHID path not implemented
  NativeFidoGatt.{h,mm}   CoreBluetooth peripheral + Secure Enclave keys
```

### Why hex strings on the bridge

Payloads cross the TurboModule boundary as hex, not `number[]`. A 64-byte report
becomes one 128-char string instead of 64 boxed doubles — which matters when
reports stream at HID interrupt rates. `src/transport/hex.ts` converts at the
edges.

### Framing

HID gives you fixed-width packets, not messages. Anything longer than one report
arrives split across several, so `src/transport/framing.ts` implements the
U2F/CTAPHID `INIT`/`CONT` framing that OnlyKey and most FIDO tokens speak.
`FrameAssembler` is stateful on purpose: a `CONT` packet is meaningless without
the `INIT` before it.

---

## iOS

The project builds for iOS but **cannot be built on Windows** — it needs macOS
and Xcode.

```sh
cd ios && pod install
npm run ios
```

What works and what does not:

- **`NativeFidoGatt`** is implemented — `CBPeripheralManager` GATT server with
  all four FIDO characteristics, BLE fragmentation, and P-256 keys in the Secure
  Enclave gated on biometrics. The CTAP2 command handlers are stubs, same as on
  Android.
- **`NativeUsbHid`** implements only the TCP transport. The CoreHID path
  rejects with `ERR_NOT_IMPLEMENTED`: `HIDDeviceManager` and `HIDDeviceClient`
  are Swift-only types with no Objective-C interface, so that path needs a Swift
  file added to the target, iOS 16+, and USB entitlements on the provisioning
  profile. [`EXPLAINER/ios-hid.md`](EXPLAINER/ios-hid.md) has the Swift shape.

The `.h`/`.mm` files exist on disk but are **not yet added to the Xcode target** —
that has to be done in Xcode (or by editing `project.pbxproj`) on a Mac. Add
`Info.plist` keys `NSBluetoothAlwaysUsageDescription` and
`NSFaceIDUsageDescription` at the same time.

---

## Not implemented

Honest list of what is scaffolding rather than working code:

- **CTAP2 command handlers.** Reassembled commands are forwarded to JS as
  `onCtapRequest`; JS supplies the response bytes. `authenticatorMakeCredential`
  and `authenticatorGetAssertion` need a CBOR encoder/decoder — approving a
  request currently acks with an empty CBOR map, not a real assertion. `rpId` on
  the request event is always empty for the same reason.
- **BiometricPrompt.** Android keys are generated with
  `setUserAuthenticationRequired(true)`, so `signWithCredential` throws
  `UserNotAuthenticatedException` until a prompt is wired to the signature
  object.
- **Foreground service.** Permissions are declared but no service runs, so a
  long BLE session can be throttled when the app backgrounds.
- **OnlyKey protocol.** The transport moves bytes; nothing above CTAPHID framing
  knows what an OnlyKey message means yet.
- **Auto-reconnect.** Hot-plug events are received and the transport is torn
  down cleanly, but reconnect is manual.

## Related repos in this workspace

`../node-onlykey-emulator/` runs the real OnlyKey firmware as a Node native
addon and exposes actual HID interfaces via `uhid` — a far better test target
than `tools/hardware-emulator.js`, but it needs Linux (`uhid`, `dummy_hcd`, udev
rules). Bridging this app's TCP transport to it would remove the need for the
hand-written mock.
