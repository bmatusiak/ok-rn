# The CTAP2 status table was shifted, and a test held it in place

Found 2026-09-11, while running the first FIDO2 PIN suite against the soft key.
Fixed the same day in `node-onlykey-lib/src/protocol/ctaphid.js`.

## What happened

The new FIDO PIN suite sends one deliberately wrong PIN and checks that the
attempt counter moves. It did move - 8 to 7 - but the error read:

```
refused: CTAP2 error CTAP2_ERR_PIN_NOT_SET. 7 attempts left (one was just spent).
```

That is self-contradictory. `CTAP2_ERR_PIN_NOT_SET` is returned before the
firmware looks at a PIN at all (`ctap.cpp:2283`), and it does not decrement
anything. A device that spent an attempt had a PIN set. The name was wrong,
not the device.

## The bug

`CTAP2_ERROR` in `ctaphid.js` was transcribed by hand and had slid. Against
`libraries/fido2/ctap_errors.h`, the header the firmware itself compiles:

| byte | the table said | it actually is |
|---|---|---|
| 0x2b | NO_CREDENTIALS | UNSUPPORTED_OPTION |
| 0x2d | NOT_ALLOWED | KEEPALIVE_CANCEL |
| 0x2e | PIN_INVALID | NO_CREDENTIALS |
| 0x31 | PIN_NOT_SET | PIN_INVALID |
| 0x36 | PIN_AUTH_INVALID | PIN_REQUIRED |
| 0x6a | UNSUPPORTED_OPTION | not a CTAP2 status at all |

`CTAP2_STATUS`, the table of bytes this library may SEND, drew its three
non-trivial values from the same slide: `NO_CREDENTIALS: 0x2b`,
`NOT_ALLOWED: 0x2d`, `UNSUPPORTED_OPTION: 0x6a`.

## Why it mattered more than a bad log line

`CTAP2_STATUS` is what the BLE security-key path answers a desktop browser
with. `FidoGatt.rejectRequest` defaults to `CTAP2_STATUS.NOT_ALLOWED`, so
every rejected WebAuthn request from a paired desktop went out as 0x2d,
KEEPALIVE_CANCEL - a byte that means "the ceremony you cancelled is
cancelled", not "this authenticator refuses". `fidoBridge` is the same story
for its own codes.

For a person at a browser, the difference is whether the page says to try
another key or silently retries a ceremony nobody started.

## The part worth remembering

There was already a comment at that table, and a test enforcing it. Both said
the numbers had been CORRECTED:

> having only the first is how ok-rn came to keep its own table with
> `NOT_ALLOWED: 0x30` in it - a byte the spec does not define at all - and
> `UNSUPPORTED_OPTION: 0x2b`, which is really NO_CREDENTIALS.

`0x30` IS `CTAP2_ERR_NOT_ALLOWED` (ctap_errors.h:42). The app's table had been
right, the library replaced it with a wrong one, and

```js
assert.equal(CTAP2_STATUS.NOT_ALLOWED, 0x2d);
assert.equal(CTAP2_STATUS.NO_CREDENTIALS, 0x2b);
assert.equal(CTAP2_STATUS.UNSUPPORTED_OPTION, 0x6a);
```

froze it. A test that pins values retyped from the same wrong source as the
code cannot catch the code being wrong; it only makes the wrongness load
bearing. The one real check it had - "every value here is a key of
CTAP2_ERROR" - passed, because both tables were wrong in the same direction.

## The fix

Two changes, and the second is the one that matters.

1. `CTAP2_ERROR` is no longer retyped. It is built from `ctap.js`'s `STATUS`,
   which was transcribed separately from the shipped web client
   (`onlykey.extra.js:245-292`) and is correct, with 0x00 renamed from
   `CTAP1_SUCCESS` to `CTAP2_OK` for this direction. Two hand copies of one
   table was the bug; deriving one from the other removes the possibility.
2. The test's oracle is now `ctap_errors.h` itself: all 32 codes checked by
   name against the firmware's header, not the three that were noticed.

## What is still unverified

The BLE path itself. `rejectRequest` now sends 0x30, but no WebAuthn ceremony
from a paired desktop has ever run against this app - the bridge is exercised
by jest and dumpsys. The byte is right; what a browser does with it is still
untested. Same gap as the one the README names.
