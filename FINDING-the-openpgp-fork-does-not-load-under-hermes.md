# The OpenPGP fork did not load under Hermes: there was no WebCrypto

**Severity:** high — it blocks composite PQC PGP key generation on the phone,
and it was recorded as working
**Status:** FIXED - the fork loads, and composite key generation works on the phone
**Applies to:** ours — `node-onlykey-lib/src/vendor/openpgp/openpgp.js`, and the
plan's claim about it

## The cause

```
Error: The WebCrypto API is not available
    at getWebCrypto
    at anonymous
    at loadModuleImplementation
    at guardedLoadModule
    at metroRequire
```

OpenPGP.js v6 reads WebCrypto at MODULE SCOPE, not at point of use. A dozen
sites do:

```js
const webCrypto$b = util.getWebCrypto();     // openpgp.js:3209, 4377, 4730, …
```

and `getWebCrypto` throws when `globalThis.crypto.subtle` is absent
(openpgp.js:2162-2169). React Native has `crypto.getRandomValues` from
`react-native-get-random-values` and no `subtle` at all, so the factory throws
on the first of those lines and never reaches its exports.

## Why every probe missed it

The error is real and it is thrown, but `require()` does not rethrow it.
`metro-runtime/src/polyfills/require.js`:

```js
function guardedLoadModule(moduleId, module) {
  if (!inGuard && global.ErrorUtils) {
    inGuard = true;
    let returnValue;
    try {
      returnValue = loadModuleImplementation(moduleId, module);
    } catch (e) {
      global.ErrorUtils.reportFatalError(e);   // not rethrown
    }
    inGuard = false;
    return returnValue;                        // still undefined
```

So a module whose factory throws comes back `undefined` at the call site and
its error goes to the global handler instead. Every probe in the previous
version of this finding was looking at the call site, which is exactly where
the information is not.

It was found by installing `ErrorUtils.setGlobalHandler` around the require and
reading what arrived. That is now a permanent test -
`__e2e_tests__/11-compositePgp.e2e.js`, "CAPTURES the error Metro swallows" -
so the next failure of this kind reports itself instead of being investigated
from scratch.

## What the previous version of this finding got wrong

It listed the cause as unknown after ruling out the exports map, the symlink,
the resolver, the IIFE shape, and size. All of that ruling-out was correct and
none of it was enough, because the missing piece was not a property of the file
at all - it was that the error had been routed somewhere nobody was looking.

The earlier "size is the cause" conclusion was already corrected once. Two wrong
root causes in one finding is the argument for capturing the error rather than
reasoning about the symptom.

## Why the fork's own fallbacks do not save it

openpgp v6 has guards that look like they handle a missing WebCrypto:

```js
if (util.getWebCrypto()) {
  try {
    key = await webCrypto$9.importKey('raw', key, { name: 'AES-CBC', … });
```

They are unreachable. `getWebCrypto()` THROWS rather than returning falsy, so
the guard throws too - and in any case the module-scope reads happen long
before any of these run. Upstream v6 assumes WebCrypto is always present, which
is true of browsers and Node 18+, and false here.

## Fixed

`node-onlykey-lib/src/webcrypto/subtle.js` supplies a SubtleCrypto over @noble,
and `text.js` supplies TextEncoder/TextDecoder, which Hermes also lacks. The
app installs both from `src/installWebCrypto.js` - a side-effect import,
because `import` statements hoist and a bare call between two of them would run
after App had already been evaluated.

Measured on the phone: the fork loads, a composite key generates in about a
second with all four halves carrying real material, and its 18.5 KB armoured
public key parses back to a stable fingerprint across two round trips.

TextDecoder was a SECOND gap, and it only appeared once the first was closed:
generation needs no text codecs, reading armour does. That is the same shape as
the vault's `new TextDecoder()`, which passed twenty-one Node tests and threw
on the phone.

Two bugs in the shim were caught by checking it against Node's own WebCrypto
rather than against itself, and neither would have failed a self-consistent
test:

* `subarray(…).buffer` returns the WHOLE backing store, so ECDH handed back a
  33-byte secret where 32 were asked for - the compressed point's parity byte
  still attached.
* @noble rejects high-S ECDSA signatures by default and WebCrypto emits them
  freely, so 9 of 20 genuine signatures were rejected. A single-signature test
  passes about half the time and reads as flakiness rather than a bug.

## What the shim had to cover

The fork needs a real `crypto.subtle` at load time. The surface it uses is
bounded, and every piece of it was already a dependency of this library:

| method | calls | algorithms asked for |
|---|---|---|
| importKey | 18 | ECDH, ECDSA, HMAC, AES-KW, AES-CTR, AES-CBC, HKDF |
| exportKey | 8 | |
| generateKey | 4 | |
| encrypt / decrypt | 5 | AES-CTR, AES-CBC, AES-KW |
| sign / verify | 6 | ECDSA, HMAC |
| deriveBits | 3 | ECDH, HKDF |
| digest | 1 | SHA-1 and the SHA-2 family |
| wrapKey / unwrapKey | 2 | AES-KW |

`@noble/curves`, `@noble/ciphers` and `@noble/hashes` cover all of it, so this
is a shim over code that was already present rather than a new native
dependency.

Adding `react-native-quick-crypto` would also work and was rejected: it is a
native module, it would have to be built for iOS as well as Android, and it
would put the answer outside the shared library, which is the opposite of what
this project is for.

It lives in the library and does NOT install itself - the library is
platform-free by design, and a host that already has WebCrypto must keep its
own, which is more complete and better tested than this will ever be. The host
calls `install()` once at startup.

## Not fixed by editing the fork

The vendored file stays byte-for-byte identical to upstream, which
`test/openpgp-vendor.test.js` checks. Making `getWebCrypto` return `undefined`
instead of throwing would be a smaller change and a worse one: the guards it
would re-enable are not tested upstream in that configuration, so it would
trade a loud failure for a set of quiet ones.
