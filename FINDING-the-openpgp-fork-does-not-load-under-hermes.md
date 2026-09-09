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

| probe | result |
|---|---|
| `node-onlykey-lib/crypto/pgp` (the exports map) | `undefined` |
| `node-onlykey-lib/src/vendor/openpgp/openpgp.js` | `undefined` |
| `../../node-onlykey-lib/src/vendor/openpgp/openpgp.js` | `undefined` |
| `node-onlykey-lib/definitely-not-here` | **throws** |
| `node-onlykey-lib/crypto` → `.composite.generateCompositeKey` | a function |
| a tiny file with the fork's exact top-level shape | works |
| **30,000 generated lines inside one IIFE (1.9 MB)** | **works** |
| **30,000 generated lines at module top level (1.8 MB)** | **works** |
| a byte-for-byte copy of the fork whose last line reports what ran | `undefined` |
| `GET /…/probe-openpgp-copy.bundle` from Metro | **HTTP 200, 1.5 MB** |

## What that leaves, and what it rules out

**An unresolvable module throws.** This one resolves, so the exports map, the
symlink and the resolver are innocent.

**The IIFE construction is fine**, proven by reproducing the exact shape.

**SIZE IS NOT THE CAUSE.** This was my first conclusion and it was wrong: a
generated 1.9 MB file with a single 30,000-line IIFE loads and returns its
exports. The correction matters more than the original guess did - a wrong root
cause in a findings file is worse than an admitted gap, because the next person
stops looking.

**Metro builds it.** Asked for that one file as a bundle entry, the dev server
answers 200 with 1.5 MB of JavaScript, so the transform succeeds.

**The factory does not reach its last line.** A copy of the fork whose final
statement was replaced with `module.exports = {markerRan: true, …}` ALSO comes
back `undefined` - so it is not that `openpgp` was unset when the export ran;
the export never ran. And Metro initialises `module.exports` to `{}`, so
`undefined` cannot come from a factory that merely did nothing. Something set
it, or the module was never evaluated.

**Nothing throws.** Not through `require`, not in logcat, not as a rejected
promise - checked with an explicit try/catch around the require.

So the cause is still open. The next things worth trying: inspecting Metro's
module registry for the id at runtime, disabling `inlineRequires`, and
requiring the fork from the app's own module graph rather than from a test
suite, to rule the harness in or out.

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

## The fix is not yet known

Re-bundling as ordinary modules was the obvious candidate while size looked like
the cause. It no longer is: the same volume in the same shape loads without
complaint, so a re-bundle would be a large change made on a guess.

The one claim that can be made confidently is the negative one in VENDORED.md.
It states the appended CommonJS line makes the file "an ordinary require()-able
module in Node, browsers, nw.js and Hermes alike". It is not, and that sentence
should not be trusted until this is understood.

## Guarded by

`__e2e_tests__/11-compositePgp.e2e.js`, which asserts the failure so the suite
stays honest and green, and which fails loudly with an instruction the moment
the fork starts loading.
