# The derived "password" was the wrong 32 bytes, and nothing said so

**Severity:** high — the value shown, copied and used as a password was not the
secret, and no client would agree with it
**Status:** fixed — the two halves are split by name, and the test that let it
through has been strengthened
**Applies to:** ours — `node-onlykey-lib/src/crypto/okconnect.js`,
`plugins/okcrypto/index.js`

## The mistake

`derive_public_key` returns a payload ending in one value, the public key, so
"take the last 65 bytes" is right. I reused that reader for
`derive_shared_secret`, whose payload ends in **two**:

    [ ... | sharedPub(65 for P-256, 32 for the 25519 curves) | secret(32) ]

(`onlykey-3rd-party.js:441-448`). Taking the last 65 bytes therefore returned
**33 bytes of the public key with the secret glued to the end of it**.

## Why nothing caught it

Every property you would think to check was still true:

- it was the right sort of value — 65 bytes of hex;
- it was **deterministic**, the same for a given label every time;
- it **changed** when the label changed;
- it **contained** the real secret, so any test looking for correlation found it;
- the device was perfectly happy, because the device never saw the mistake.

The only thing wrong with it was that it was not the number every other OnlyKey
client derives for that label. A password generated in this app would simply
not be the password generated in the web app, and the failure would surface as
"the site rejected my password" — arbitrarily far from the cause.

My own e2e assertion was `assert.ok(secret.payload.length > 0)`. It passed.

## What it should have asserted, and now does

The SHAPE, checked against the other call:

```
secret: 32 bytes, 08c382f5d209b6781c96c873...
its public half: 0474224cfb2cac34f16733d7...
```

and the public half is byte-for-byte the key `derive_public_key` returned for
the same label. Two calls, independently derived, agreeing — which is a real
cross-check rather than a self-consistent one. Plus: the secret is 32 bytes, the
public key is 65, the payload holds both, and the secret is not the tail of the
public key.

## The general shape of it

An API that returns one value for one action and two for another, with the
extra value appended, cannot be read by length. The reader has to know which
call it is reading. `derive()` now branches on the key action rather than on
the payload, and the shared-secret path returns `{ secret, publicKey }` so a
caller cannot pick the wrong one without naming it.

**A test that only checks a length can only catch a truncation.** This value was
never truncated.
