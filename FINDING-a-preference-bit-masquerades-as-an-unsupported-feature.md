# "Extension not supported" actually means a preference bit is off

**Severity:** medium — the status names the wrong cause, and the right one is a
setting the app can change
**Status:** worked around — the derive path asks for the press variant, which
is not gated
**Applies to:** OnlyKey firmware — `libraries/fido2/ok_extension.cpp:257-266`

## What the device says

A `derive_public_key` with `DERIVE_PUBLIC_KEY` (no press) comes back:

    CTAP2_ERR_EXTENSION_NOT_SUPPORTED

which reads as "this firmware does not implement that", and sent me looking at
the request encoding, the key type and the tunnel — none of which were wrong.

## What it means

```c
okeeprom_eeget_derived_key_challenge_mode(&derived_key_challenge_mode);
if (!(is_bit_set(derived_key_challenge_mode, 3))) {
    //derived keys per site without touch not enabeled
    ret = CTAP2_ERR_EXTENSION_NOT_SUPPORTED; //APPID doesn't match
    wipedata();
    return ret;
}
```

Bit 3 of one EEPROM byte. The feature is implemented, the request was
well-formed, and the device is declining because "derived keys per site without
touch" has not been turned on. The trailing comment — `//APPID doesn't match` —
names a third thing that is also not what happened.

Only the NON-press actions are gated. `DERIVE_PUBLIC_KEY_REQ_PRESS` and
`DERIVE_SHAREDSEC_REQ_PRESS` skip the check entirely and ask for a finger
instead, so the same derivation succeeds by asking for it differently.

They are also **different keys**: the press variants set
`additional_data[0] = 1` so that a touch-required derivation cannot be replayed
as a touchless one. Switching a caller between them silently changes every
secret it derives.

## The other refusal on the way there

Before this one, the same request answered `CTAP2_ERR_USER_ACTION_PENDING`,
which reads as "press a button" and means "ask again later" — it comes from the
RETRIEVE branch (`ok_extension.cpp:533-539`), taken because `pending_operation`
was still set from the FIDO ceremony in the preceding test suite. That window
runs up to twenty seconds
(`FINDING-presses-discarded-after-a-fido-ceremony.md`), and no keepalive is
ever sent, so waiting for a press that the status seems to ask for waits
forever.

Two consecutive statuses, neither describing its own cause:

| status | reads as | actually |
|---|---|---|
| `CTAP2_ERR_USER_ACTION_PENDING` | press a button | a previous operation has not aged out |
| `CTAP2_ERR_EXTENSION_NOT_SUPPORTED` | the firmware lacks this | an EEPROM bit is clear |

## What was done about it

`__e2e_tests__/10-derive.e2e.js` asks for the press variants, so it does not
depend on a device preference, and waits out the pending-operation window
before its first derive. Both reasons are written into the test rather than
left as unexplained constants.

Offering the setting in the Preferences screen is the obvious follow-up — it is
one more `OKSETSLOT` field — but it should be offered as what it is: turning
off the touch requirement for per-site derived keys.
