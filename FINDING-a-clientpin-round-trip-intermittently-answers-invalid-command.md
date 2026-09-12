# A clientPin round trip intermittently answers CTAP1_ERR_INVALID_COMMAND

## What happens

In a FULL run, one test in the `fidoPin` suite fails:

```
✗ a wrong PIN spends exactly one attempt, and a right one restores it
  -> Error: CTAP2 error CTAP1_ERR_INVALID_COMMAND. 7 attempts left.
```

Run that suite ALONE and it passes:

```
refused: CTAP2 error CTAP2_ERR_PIN_INVALID. 7 attempts left (one was just spent).
restored to 8
✓ a wrong PIN spends exactly one attempt, and a right one restores it
```

Run it after only the suite that precedes it - `--only ctapFlow,fidoPin` - and
that test passes while a DIFFERENT one in the same suite fails the same way:

```
✗ a PIN can be changed, and changed back
  -> Error: CTAP2 error CTAP1_ERR_INVALID_COMMAND. 8 attempts left.
```

So the failure is not attached to a test. It moves.

## What it is not

**Not a stale shared secret.** The obvious theory is the key agreement: the
firmware calls `ctap_reset_key_agreement()` on a wrong PIN BEFORE decrementing
the counter (ctap.cpp:2118-2121, 2170), so a client that cached the agreement
would be talking with a secret the device no longer holds. But `FidoAdmin._agree`
(`src/device/fido.js:122`) generates a fresh platform key and fetches a fresh
authenticator key agreement on every single call - `getPinToken`, `setPin` and
`changePin` all go through it. There is nothing cached to go stale.

**Not the app's changes.** The same code passed in the run before, at 107
passed and 0 failed, and passes now in isolation. Nothing in the CTAP path was
touched between the two.

**Not exhausted attempts.** The counter reads 8 at the start of the suite and
the failures happen at 7 and 8 remaining, well clear of the guard.

## What the error means, and the shape it points at

`CTAP1_ERR_INVALID_COMMAND` is 0x01: the device did not recognise the command
byte. It is what you get when the bytes the device parsed were not the bytes
the client framed - not when a PIN is wrong, which has its own status.

Every failure so far is in a test that makes SEVERAL clientPin round trips
back to back. `getPinToken` alone is three: `_guard` reads the retry count,
`_agree` fetches the key agreement, then the token request - and on failure
`_describe` reads the count again. `changePin` is the same shape.

That is the signature of a reply boundary problem rather than a crypto one: a
report left over from the previous exchange being collected as the first report
of the next, so the CBOR that gets parsed begins in the middle of something
else and its command byte is whatever happened to be there. This repository has
met that exact failure before, on the vendor interface, in
FINDING-a-collector-ate-the-previous-replys-reports.md.

That is a hypothesis consistent with every observation above. It is NOT
confirmed: no report-level capture has been taken across a failing exchange,
and until one has been, the mechanism is a guess.

## Not fixed

Named and left. Confirming it means capturing the raw CTAPHID reports on both
sides of a failing round trip, which needs a run that fails - and it fails
roughly one run in five, only in company. The cheap next step is to instrument
the collector rather than the test.

Worth knowing meanwhile: this is the flake that cost an unexplained "one
failure whose name was lost" earlier in the same session. It has a name now.

## Measured

Three runs on the Pixel against the working-tree soft key:

| run | result |
|---|---|
| full suite | `a wrong PIN spends exactly one attempt` fails, INVALID_COMMAND |
| `--only fidoPin` | 8 passed, 0 failed |
| `--only ctapFlow,fidoPin` | 11 passed, 1 failed - `a PIN can be changed` fails, INVALID_COMMAND |
