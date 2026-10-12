# FINDING: which Android route fills Chrome's password fields, on both phones

2026-10-11, the Password Manager's Autofill stage (before any native code).

## Seen

- Pixel 6a, Android 17 (API 37), Chrome 155.0.8059.39:
  `settings get secure autofill_service` =
  `com.android.credentialmanager/com.android.credentialmanager.autofill.CredentialAutofillService`.
  The phone's autofill service is the Credential Manager bridge, so on this phone, password
  suggestions in Chrome can come from Credential Manager **providers**.
- ok-rn is already a Credential Manager provider (`OkCredentialProviderService`, passkeys), but
  `res/xml/provider_config.xml` declares public-key credentials only, so it is never asked for
  a password.
- Galaxy A13, Android 13 (API 33): Credential Manager provider services need Android 14
  (API 34). That route cannot reach the A13.

## So

- A classic `android.service.autofill.AutofillService` (API 26+) is the route that fills on
  **both** phones. That is what the plan already says.
- Password credentials through the existing Credential Manager provider would reuse the passkey
  flow (CredProviderActivity on the shared ReactHost), but only on Android 14+. It is an extra for
  later, not the route for 0.0.7.
- On Android 14+, turning OnlyKey on as the autofill service replaces the Credential Manager
  bridge as the phone's preferred service. Chrome also needs its own setting, "Autofill using
  another service". Both must be checked on the phones when the service exists.

## Not yet measured

- The A13 (Android 13): everything below is the Pixel only.
- A press store opened from the sheet (the Pixel's soft key store is touch-free).

## Measured on the Pixel (Android 17, Chrome 155), 2026-10-11, with the service built

- Chrome asks a third-party AutofillService only after its own setting is switched: Settings ›
  Autofill settings › "Autofill using another service" (Chrome restarts). Before that it shows
  Google Password Manager and never calls us. Both switches are needed: the phone's autofill
  service = OnlyKey, and that Chrome setting.
- Then, on github.com/login, Chrome calls onFillRequest with `webDomain` set and hints
  `username` / `current-password` (html types text / password); the OnlyKey row shows; tapping it
  opens the sheet in front of Chrome; a pick fills both fields.
- A cold app (Chrome woke it): the sheet starts the soft key itself, which is then locked and asks
  for the PIN on the sheet. Logged in first (testing mode), the sheet opens the store touch-free.
- Save: with SaveInfo on the response, submitting the form makes the phone offer "Save username and
  password to OnlyKey"; onSaveRequest gets the typed values; the sheet seals them on Save.
- adb's burst typing (`input text` of a whole word) reached the save cut short (first 10 / 7
  characters); typed at a person's pace (one character per 0.4 s) the values were exact. Not a
  code fault; a person's typing or a paste is one value change at a time.
- Atomic Wallet (io.atomicwallet), restore screen (Brad opened it, 2026-10-11): it DOES ask the
  autofill service - three requests in 7 s, each `1 text field(s), hints [html:textarea], web false`
  (a web view in the app, no webDomain). The service answered nothing (no password field), and
  Android showed "can't be autofilled" - which read as autofill being off in the app. It is not:
  the phrase box is reachable, and the BIP39 step answers it.
