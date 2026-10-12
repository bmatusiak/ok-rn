# FINDING: the Autofill service never fills the app's own fields, so a login form inside ok-rn cannot test fill and save

2026-10-12. PASSWORD-MANAGER-SPEC.md, implementation step 4, planned "a debug-only login form inside ok-rn" so the e2e runner could exercise fill and save without driving another app.

## Why it cannot work

`android/autofill/src/main/java/com/okrn/autofill/OkAutofillService.kt:57-64` answers nothing when the asking app is ok-rn itself:

```kotlin
val caller = structure.activityComponent?.packageName ?: ""
/* never offer to fill the app's own fields: its secrets are typed by the person, here */
if (caller == packageName) { callback.onSuccess(null); return }
```

This is on purpose. The app's own fields include the PIN pad, passphrases and the Password Manager's editor, and none of them should be offered saved secrets or a "save to OnlyKey" prompt. A test form inside the app would get the same empty answer. Allowing an exception for one test screen would put a test path into the service that ships.

## How fill and save are tested instead

- **The parts in the app:** jest tests site matching and app matching (`src/plugins/passwords/__tests__/match.test.ts`: registrable domain, look-alikes, package and certificate).
- **The whole path, by hand, on each phone build:**
  1. Chrome on a local login page (served from the PC with `adb reverse`).
  2. Tap the field: the OnlyKey row appears.
  3. The sheet lists that site's entries; picking one fills both fields.
  4. Submit: "Save to OnlyKey" is offered.

  Done on the Pixel TEST build 2026-10-12: the row showed, and the pick filled `slowuser2` and its password.
