# The vault worked in every test and failed on the phone

**Severity:** high — the feature was unusable on the target platform, and the
error it produced named the wrong cause
**Status:** fixed — `bytesToUtf8` instead of `TextDecoder`, with a test that
deletes the global
**Applies to:** ours — `node-onlykey-lib/src/crypto/vault.js`

## What happened

`vault.open()` ended with:

```js
return new TextDecoder().decode(pt);
```

Twenty-one unit tests passed, including a full seal/open round trip and a
cross-check of the key schedule against WebCrypto. On the phone:

    ReferenceError: Property 'TextDecoder' doesn't exist

**Hermes has neither `TextDecoder` nor `TextEncoder`.** `src/bytes.js` exists
because of that — there is even a commit named for it — and `bytesToUtf8` was
already sitting there, imported by other modules in the same directory.

## Why the tests could not have caught it

They run in Node, where the global exists. Nothing about the code is wrong *as
JavaScript*; it is wrong about its environment. No amount of testing the
behaviour catches a dependency on something the target does not have — the only
thing that catches it is running on the target, or removing the global.

This is the shape to watch for: a **platform capability** difference, not a
logic error. The others in the same family are `Buffer`, `atob`/`btoa` and
`crypto` — the reason this library injects `randomBytes` rather than reaching
for one.

## The second failure, which hid the first

The screen reported it as:

> That did not open. Either the service name is not the one it was sealed
> under, or the blob has been altered — there is no way to tell which.

That sentence is true of a TAG failure and this was not one. My `catch` had
replaced every possible error with it, so a `ReferenceError` was presented as a
wrong service name — pointing at the one thing that was fine. The handler now
only claims that for an actual decryption failure and shows anything else as
itself.

A catch-all that rewrites an error is a catch-all that can hide its own bug.

## Guarded by

`test/vault.test.js` — "a sealed blob opens where there is no TextDecoder",
which deletes `globalThis.TextDecoder` and `TextEncoder` for the duration. It is
the closest Node can get to Hermes and it is exactly the untested condition.

Verified load-bearing: restoring the `TextDecoder` call fails that test and only
that test.

Also covered end to end now by `__e2e_tests__/10-derive.e2e.js` — "a vault blob
sealed on this device opens again", which runs where the global is really
absent.
