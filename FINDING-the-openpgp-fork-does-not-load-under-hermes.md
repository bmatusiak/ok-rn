# The OpenPGP fork does not load under Hermes, and says nothing about it

**Severity:** high — it blocks composite PQC PGP on the phone entirely, and it
was recorded as working
**Status:** open — the blockage is pinned by a test; the fix is a re-bundle
**Applies to:** ours — `node-onlykey-lib/src/vendor/openpgp/openpgp.js` as
bundled, and the plan's claim about it

## The claim that was wrong

The plan lists "the vendored PQC openpgp fork, verified byte-for-byte and
Hermes-safe" among the things already finished. The first half is true. The
second was inferred from Node tests passing, and nothing had ever required the
file on a phone.

    require('node-onlykey-lib/crypto/pgp')   ->  undefined

Not an error. Not a rejected promise. Nothing in logcat, nothing from Metro.

## Ruling things out

Each of these was measured on the device rather than reasoned about:

| require | result |
|---|---|
| `node-onlykey-lib/crypto/pgp` (the exports map) | `undefined` |
| `node-onlykey-lib/src/vendor/openpgp/openpgp.js` | `undefined` |
| `../../node-onlykey-lib/src/vendor/openpgp/openpgp.js` | `undefined` |
| `node-onlykey-lib/definitely-not-here` | **throws** |
| `node-onlykey-lib/crypto` → `.composite.generateCompositeKey` | a function |
| a tiny file with the fork's exact top-level shape | works |

The fourth row is the important one: **an unresolvable module throws.** So this
module resolves, is bundled, and its factory runs — it simply produces
`undefined`. The exports map, the symlink, the resolver and the
`var x = (function(exports){...})({}); module.exports = x;` construction are all
therefore innocent, the last proven by reproducing the shape in a file four
orders of magnitude smaller.

What is left is SIZE: 1,272,241 bytes, and one function of about 31,000 lines,
which Hermes fails to yield a value for silently.

## Why it is worth its own file

Every other Hermes gap found here announced itself:
`FINDING-a-global-that-only-exists-in-the-test-runner.md` threw a
`ReferenceError` naming `TextDecoder`. This one has no symptom at the point of
failure. The first thing the caller sees is
`Cannot read property 'generateKey' of undefined`, which reads as a wrong import
path — and the import path is fine.

## What still works without it

Most of the composite feature, as it happens. The blob format, its offsets, and
the device operations that consume it cost only @noble:

  packBlob / unpackBlob        the four-secret layout
  composite_sign / _decrypt    proven on device (9-cryptoSign)
  registerCompositeHooks       wiring, once there is an openpgp to wire

Only key GENERATION needs the fork — and only because a composite key is a PGP
key, not because the device wants one. A key generated elsewhere and loaded into
a slot would sign on the phone today.

## The fix, when it is worth doing

Re-bundle the fork as ordinary modules rather than one enormous IIFE. It is a
build-configuration change in the vendoring step, not a code change, and it
keeps the byte-for-byte verification meaningful because the SOURCE does not
move. Precompiling to Hermes bytecode is the other option and a worse one: it
pins an engine version into the library.

## Guarded by

`__e2e_tests__/11-compositePgp.e2e.js`, which asserts the failure so the suite
stays honest and green, and which fails loudly with an instruction the moment
the fork starts loading.
