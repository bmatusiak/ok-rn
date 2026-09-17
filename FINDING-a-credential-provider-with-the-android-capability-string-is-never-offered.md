# A credential provider with the `android.credentials.*` capability string is never offered

**Found** 2026-09-17, building the Android Credential Manager experiment
(`com.okrn.credprovider`). Fixed the same hour.

## What happened

`res/xml/provider_config.xml` declared:

    <capability name="android.credentials.TYPE_PUBLIC_KEY_CREDENTIAL" />

Everything downstream of that looked correct:

- the app installed;
- `adb shell cmd package query-services -a android.service.credentials.CredentialProviderService`
  listed `com.okrn/.credprovider.OkCredentialProviderService` alongside Google's;
- the provider could be enabled, and stuck, in `settings get secure credential_service`.

And yet OnlyKey never appeared in the passkey sheet, and
`onBeginGetCredentialRequest` was never called — no crash, no exception, no
error visible from the app at all. From inside the app this is indistinguishable
from Chrome refusing to use third-party providers.

## The one line that says so

It is only visible in the **system** log, not the app's — so
`tools/logwatch.js`, which follows the app's own process, cannot see it:

    I/CredentialManager: Service does not have the required capabilities:
      ComponentInfo{com.okrn/com.okrn.credprovider.OkCredentialProviderService}

Two lines above it, the framework names the string it is actually matching
against:

    I/CredentialManager: Option of type: androidx.credentials.TYPE_PUBLIC_KEY_CREDENTIAL
      meets all filtering conditions

## The fix

    <capability name="androidx.credentials.TYPE_PUBLIC_KEY_CREDENTIAL" />

`androidx`, not `android`. The capability namespace is the Jetpack library's,
even though the manifest action (`android.service.credentials.CredentialProviderService`)
and the meta-data key (`android.credentials.provider`) are both platform names.
Three adjacent strings, two namespaces, and only one of them is checked at a
moment where anything is logged.

## Why it is written down

The failure is SILENT and it is in a file nobody re-reads. The natural next move
on seeing an empty passkey sheet is to doubt the service code, the manifest, the
PendingIntent, or Chrome's willingness to use third-party providers — four
expensive things — before doubting one word in a four-line XML file.

If a provider is enabled but never invoked, read the system log for
`CredentialManager:` before changing any code.
