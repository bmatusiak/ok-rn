# apk-signer

Signs ok-rn's apk with an OnlyKey.

**Not part of the app.** Nothing in ok-rn's `src/`, `App.tsx`,
`android/app/` or `__e2e_tests__/` uses it, and it is never bundled: Metro,
jest and eslint all ignore this folder. Its one caller is `tools/release.js`,
at signing time. **Experimental and removable:** delete this folder and ok-rn
still builds and releases - the apk keeps Gradle's debug-keystore signature,
exactly as with `release.js --no-sign`.

It is its own npm project because its dependencies are not the app's: a JCA
provider compiled with a JDK, Android's apksigner, the sibling
`onlykey-testing` kit (for the emulated key), and - for hard keys - `node-hid`.

## Commands

    npm test                                  device-free tests
    node cli.js build                         compile the provider (javac)
    node cli.js provision                     load the signing key into the emulated key
    node cli.js sign <apk> [--backend emulated|software]
    node cli.js verify <apk>                  the signer apksigner finds

## How it works

apksigner asks for signatures through `OnlyKeyProvider` (JCA), which runs
the program `OKSIGN_CMD` names and speaks a line protocol to it: a hex
SHA-256 digest per line in, a hex PKCS#1 v1.5 signature (or `ERR <reason>`)
per line out. A backend is anything that speaks it:

| backend | holds the key | |
|---|---|---|
| `software` | a PEM file (`OKSIGN_SOFTWARE_KEY`) | proves the provider, no device |
| `emulated` | an emulated OnlyKey (`.local/storage`) | the pipeline; the key is still a file on disk |
| dev hard key | a development OnlyKey on USB | next - see the plan |
| production hard key | a production OnlyKey | app-store builds, its own key |

## Two keystores

- **debug keystore** - `../android/app/debug.keystore`, shipped with the repo
  (the React Native template key, cert `fac61745…`, private half public).
  Debug and pre-release builds. `provision` loads THIS key into the emulated
  key, so signing through it keeps the same certificate and existing installs
  update in place.
- **production keystore** - app-store builds only, on a production hard key,
  its own key - never the debug one.

`.local/` is gitignored and holds generated files, including
`.local/storage/flash.bin`, which **contains the signing key**.

History: built as `tools/oksign` in ok-rn - `fb3e47c` (the provider),
`9d4be76` (the emulated key), `649574a` (release.js signs).
