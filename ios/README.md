# iOS setup

The iOS target is scaffolded but has never been compiled — it needs macOS with
Xcode, and this project was set up on Windows. Treat everything below as the
checklist for the first Mac build, not as a verified working state.

## First build on a Mac

```bash
cd ok-rn
npm install
bundle install            # CocoaPods, via the Gemfile
bundle exec pod install --project-directory=ios
npm start                 # Metro, in one terminal
npm run ios               # in another
```

## Adding the native modules to the Xcode target

`NativeUsbHid.{h,mm}` and `NativeFidoGatt.{h,mm}` exist on disk but are **not
yet referenced by `OkRN.xcodeproj`** — a `project.pbxproj` cannot be edited
safely without Xcode. On the first Mac build:

1. Open `ios/OkRN.xcworkspace` (the workspace, not the project).
2. Right-click the `OkRN` group → *Add Files to "OkRN"…*
3. Select all four files. Uncheck *Copy items if needed*; check the `OkRN`
   target under *Add to targets*.
4. Build. Codegen generates `AppSpecs` from `specs/*.ts` during `pod install`,
   so `#import <AppSpecs/AppSpecs.h>` resolves once pods are installed.

## Frameworks to link

| Framework | Used by |
| --- | --- |
| `CoreBluetooth` | `NativeFidoGatt` — GATT peripheral, FIDO service 0xFFFD |
| `Security` | `NativeFidoGatt` — Secure Enclave P-256 keys |
| `LocalAuthentication` | `NativeFidoGatt` — Face ID / Touch ID gate |

## What works and what does not

**`NativeUsbHid`** — the TCP transport is complete and is what the Simulator
uses, since the Simulator cannot route real USB HID endpoints. The `usb`
transport deliberately rejects with `ERR_NOT_IMPLEMENTED`.

Implementing it means:

- **iOS 16+ deployment target.** `CoreHID` does not exist before that. For
  older iOS you are pushed onto the External Accessory framework, which
  requires MFi-certified hardware — see `EXPLAINER/!.md` section 4.
- **A Swift file.** `HIDDeviceManager` and `HIDDeviceClient` are Swift-only
  types with no Objective-C interface, so the CoreHID client has to be written
  in Swift and bridged. `EXPLAINER/ios-hid.md` has the shape.
- **Entitlements.** USB device access needs entitlements on both the
  `.entitlements` file and the provisioning profile.
- **Usage pages.** If the hardware reports a system-reserved usage page
  (keyboard, mouse), iOS consumes the reports before the app sees them.

**`NativeFidoGatt`** — the GATT peripheral, advertising, CTAP BLE
fragmentation and Secure Enclave keygen/signing are written. The CTAP2 command
handlers are not: reassembled commands are forwarded to JS as `onCtapRequest`
and JS supplies the response bytes, so the CBOR encoding of
`makeCredential` / `getAssertion` is still to be built.

Note that iOS is considerably more restrictive than Android here — a
third-party app advertising as a FIDO authenticator is not a supported Apple
use case, and background advertising is throttled even with the
`bluetooth-peripheral` background mode declared. Validate this on real hardware
early before building on top of it.

## Info.plist keys already added

- `NSBluetoothAlwaysUsageDescription`
- `NSFaceIDUsageDescription`
- `UIBackgroundModes` → `bluetooth-peripheral`
- `NSAppTransportSecurity.NSAllowsLocalNetworking` (already in the RN template)
  is what lets the Simulator reach the mock server on `127.0.0.1`.

## Mock server

Same server as Android, different host: the iOS Simulator shares the Mac's
loopback, so it connects to `127.0.0.1:9000` rather than Android's `10.0.2.2`.

```bash
npm run mock
```
