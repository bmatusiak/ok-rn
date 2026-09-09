# The press flag changes the derived key, it does not just gate it

`DERIVE_PUBLIC_KEY` and `DERIVE_PUBLIC_KEY_REQ_PRESS` do not derive the same
key. Neither do `DERIVE_SHAREDSEC` and `DERIVE_SHAREDSEC_REQ_PRESS`. The flag is
an input to the derivation, not a permission check in front of one.

`libraries/fido2/ok_extension.cpp:243-246`:

```c
uint8_t additional_data[33] = {0};
if (opt1 == DERIVE_PUBLIC_KEY_REQ_PRESS || opt1 == DERIVE_SHAREDSEC_REQ_PRESS) {
    additional_data[0] = 1; // Generate different key for REQ_PRESS than non REQ_PRESS
}
...
memcpy(additional_data+1, client_handle+43, 32);
okcrypto_derive_key(KEYTYPE_P256R1, additional_data, RESERVED_KEY_WEB_DERIVATION);
```

`additional_data` is what the key is derived from. Its first byte is the press
flag. So one label yields TWO device keys, and which one you get depends on
whether you asked for a touch.

## Why this matters more than it looks

The web app's vault deliberately uses a DIFFERENT flag on each of its two steps
(`onlykey.github.io/src/plugins/vault/vault.js:342-344`):

```js
ok.derive_public_key(phrase, KEYTYPE_P256R1, false, function (err, pubkey) {
    ok.derive_shared_secret(phrase, pubkey, KEYTYPE_P256R1, true, ...);
});
```

Its comment explains the intent as user experience - no touch needed just to
fetch a public key, a touch for the sensitive computation. But because the flag
feeds the derivation, the actual effect is arithmetic:

```
P      = public(derive(label, press=0))      the point handed back
secret = ECDH(private(derive(label, press=1)), P)
```

The ECDH is between the press=1 private key and the press=0 public key. Two
different device keys, on purpose or not, and that pairing IS the vault key.

We used one flag for both steps, so we computed `ECDH(priv(k), pub(k))` for a
single k. A perfectly good value, stable per label, and not the one any other
client computes. A blob sealed here could never be opened there.

## The consequence for error handling: do not fall back

The touch-free variants are refused unless an EEPROM bit is set
(`ok_extension.cpp:261`, `derived_key_challenge_mode` bit 3, the "derived keys
per site without touch" preference), and the refusal arrives as
`CTAP2_ERR_EXTENSION_NOT_SUPPORTED` - which reads like the firmware has no such
feature.

The tempting repair is to catch that and retry with the press variant. **That
would be wrong**, and silently so: the retry derives a different key, so the
vault would appear to work while producing blobs no other client can open, and
which this app itself could not open once the preference was turned on.

So the refusal is surfaced with its real cause instead, and the preference has
to be enabled. Setting it needs config mode - `okcore.cpp:2013` gates field 21
on `configmode == true || !initcheck` - which is what
`onlykey-testing/test/03-gui/11-password-generator.test.js` does before it
derives anything.

## How it was found

Not by reading. The vault's e2e round trip started failing with
`CTAP2_ERR_EXTENSION_NOT_SUPPORTED` after the press asymmetry was introduced,
and the obvious reading - "the asymmetry is only UX, so fall back" - is what
sent me to `additional_data`. The comment on line 245 is the whole answer and it
is one line long.

## Status

The library now uses the reference's asymmetry, refuses rather than falling
back, and says which preference is missing. The derived-secret parity itself is
verified against an independent ECDH in
`__e2e_tests__/13-deriveParity.e2e.js`; that test uses matching flags on both
steps, which is a legitimate pairing and the one it computes its oracle for.
