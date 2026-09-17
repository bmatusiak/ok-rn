# Chrome rejects a correct WebAuthn response over two JSON fields

**Found** 2026-09-17 building the Android Credential Manager experiment
(`com.okrn.credprovider`), against Chrome on Android 17 and the okemu soft key
running v3.0.4-testc. Both fixed the same session.

## What happened

Registration and assertion both completed **on the key**. The firmware minted a
real credential, signed with a packed attestation under the genuine OnlyKey CA
chain (`CryptoTrust`, `crp.to`). Chrome then threw the whole thing away and the
page said only:

> An unknown error occurred while talking to the credential manager.

That message is the same for a malformed response, a refused one, and a
provider that never answered — so from the app's side, which had already logged
`CREATE answered`, it is indistinguishable from success.

## Where the real reason lives

Not in the app's log, and not in `CredentialManager`'s. It is Chrome's own,
under the `chromium` tag:

    E chromium: [ERROR:components/webauthn/android/fido2credentialrequest_native_android.cc:59]
      MojoClassFromJSON failed to convert JSON: field missing or invalid: publicKey

    E chromium: [...same...] field missing or invalid: userHandle

`cr_ChromiumWebauthn` logs the entire rejected JSON on the next line, which is
what makes this diagnosable at all. **When a provider's response is refused with
no explanation, read logcat for `chromium:` before changing any code.**

## The two fields

**1. `response.publicKey` is required on registration.** The DER
SubjectPublicKeyInfo of the credential public key, base64url. The W3C
serialization marks it OPTIONAL, so omitting it looks correct. For P-256 it is
26 constant bytes followed by the uncompressed point; see `spkiFromCose` in
`src/credprovider/authData.ts`.

**2. `response.userHandle` must be OMITTED, not null, on assertion.** The W3C
serialization calls it nullable, so `userHandle: null` is the obvious thing to
write. Chrome's JSON-to-Mojo converter rejects the null and wants the key gone.
It is legitimately absent whenever the assertion was answered from an
allowList rather than a discoverable credential.

## Why it is written down

Both fields are ones the spec says you may leave out or null, and both are
rejected by a converter that says nothing the calling app can see. The failure
points at the crypto — attestation, signature, clientDataHash — and the crypto
was right the whole time. Two hours of doubting a correct signature is the cost
of not knowing where Chrome writes its reason.
