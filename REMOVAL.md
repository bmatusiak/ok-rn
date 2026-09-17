# Removing the Android Credential Manager experiment

This file exists because the feature it describes is an experiment, and an
experiment nobody can delete cleanly is a permanent feature by accident.

## What the experiment is

Letting Chrome **on this phone** hand a WebAuthn call to this app, which relays
it to the OnlyKey. This is a different door from the BLE authenticator in
`com.okrn.fido`, which answers a **desktop** browser and is not part of this
experiment. Nothing below touches that path.

## Switching it off without removing it

Set `CRED_PROVIDER_EXPERIMENT = false` in
`android/app/src/main/java/com/okrn/credprovider/CredProviderGate.kt`, rebuild.

The service then returns no entries, so Android stops offering OnlyKey in the
passkey sheet and the activity refuses if it is somehow reached. The manifest
entry stays; the feature is inert. This is the reversible switch — prefer it to
deleting while the experiment is still being judged.

Note that a provider with no entries simply does not appear, which is the
intended behaviour. It is not the same as a provider that throws, which makes
the user dismiss an error.

## Removing it completely

**Delete these, whole:**

- `android/app/src/main/java/com/okrn/credprovider/` (the entire directory)
- `android/app/src/main/res/xml/provider_config.xml`
- `src/credprovider/` (the entire directory — milestone 2 onward)
- `specs/NativeCredProvider.ts` (milestone 2 onward)
- this file

**Revert these edits — each is one contiguous, commented block:**

| File | What to remove |
|---|---|
| `android/app/src/main/AndroidManifest.xml` | the block marked `EXPERIMENT: Android Credential Manager` — one `<service>`, one `<activity>` |
| `android/app/build.gradle` | the commented `androidx.credentials:credentials` line in `dependencies` |
| `android/app/src/main/java/com/okrn/OkRnPackage.kt` | the `NativeCredProviderSpec` import, its `getModule` branch and its `moduleInfo` entry (milestone 2 onward) |
| `index.js` | the second `AppRegistry.registerComponent` for the cred-provider surface (milestone 2 onward) |

**Nothing else is touched.** In particular the experiment does not modify
`node-onlykey-lib` at all — it only calls it. `protocol/bridge.js` especially is
left alone: it is a deliberate pass-through that must not learn to re-encode
CBOR, because re-encoding breaks the signature over `authData`.

## How to verify the removal

1. `grep -ri credprovider android/ src/ specs/ index.js` returns nothing.
2. `npx tsc --noEmit -p .` is clean.
3. `npm run e2e:run` matches the pre-experiment baseline
   (`passed=108 failed=0 skipped=23`, 2026-09-17).
4. On the phone, Settings → Passwords & autofill no longer lists OnlyKey.
