# FINDING: the composite sign adapter took (slot, data) while its only caller passed (slot, half, digest)

**Measured:** 2026-09-10, bench key (developer build, console answers),
`node tools/e2e.js --only hardKeyConfig`, first device-backed signature
attempt through the library.

## What happened

    ✗ SIGNS THROUGH THE KEY -> Error signing message: nothing to sign or decrypt

The composite key had just been loaded and acknowledged ("Successfully set
RSA Key"). The fork's hardware hook fired, called the library, and the
library refused before a byte went out.

## Why

`src/crypto/composite_pgp.js` wires openpgp's hooks to
`ok.composite_sign(slot, HALF_ECC, hashed)` - the shape of
onlykey-3rd-party.js and of python-onlykey's `pqc.sign_composite(ok, slot,
component, digest)`: a selector byte for which half, then the digest. The
plugin's adapter in `plugins/okcrypto/index.js` took `(slot, data, opts)`,
so the hook's `HALF_ECC` (the number 0) became `data` and the digest became
`opts`. `Uint8Array.from(0)` is empty, and the operation threw its
"nothing to sign" guard.

The adapter's own tests called it the adapter's way, so they passed; nothing
called it the hook's way until a key existed on a device to sign with.

## A second gap behind it

The device answers a composite signature as 64 bytes (Ed25519) or 3309 bytes
(ML-DSA-65): 52 consecutive 64-byte reports. `deviceOperation` resolved on
the FIRST non-status report, so even with the call shape fixed the ML-DSA
half would have returned one report's worth. python-onlykey's `read_exact`
collects to the expected size and warns why `read_string()` cannot be used.

## What is fixed

- `composite_sign(slot, half, digest, opts)`: validates the half, prepends
  the selector, and asks for the right number of bytes.
- `deviceOperation` takes `expectBytes` and collects reports until the answer
  is complete, recognising status broadcasts and error sentences only before
  the first data byte (read_exact's rule).
- `composite_decrypt` expects the 32-byte shared secret.
- The adapter tests now call it the hook's way and assert the selector leads
  the payload.

Re-run on the bench key: challenges 6-3-6 and 4-5-3 pressed through the
console, 4808 characters of signature, `verify: true`.

## Found on the way

The first version of the hardKeyConfig suite signed while still in config
mode; the key raised its challenge and never answered. Signing is forbidden
in config mode, which 9-cryptoSign's header already says, and config mode
ends only at restart. The suite now restarts and unlocks before signing.
