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

## A full sweep measured it, and it is not a flake

Twenty runs of `4b-fidoPin` across one production sweep of the whole matrix:
**15 runs of the test, 4 failures.** Every one identical, and the earlier
description of it "moving between tests" is WRONG - it did not move once.

| | |
|---|---|
| suite | `4b-fidoPin`, every time |
| test | "a PIN can be changed, and changed back", every time |
| error | `CTAP1_ERR_INVALID_COMMAND`, attempt counter intact |
| which call | the FIRST `changePin` - there is never an intervening log line |

**The 750ms delay at `4b-fidoPin.e2e.js:253` is disproved.** It was added as
an admitted guess after one sighting, with the note "the next one to see it
should say so rather than assume this fixed it". This is that note being
honoured: the delay sits BETWEEN the two changes, and the failure happens
before the first one returns, so it was never on the path.

### Where the failures fell

| version | result |
|---|---|
| v3.0.4 | **run 1 failed**, runs 2-3 passed |
| v3.0.1 | **runs 1-2 failed**, run 3 passed |
| v2.1.2 | **run 1 failed**, run 2 passed |
| v2.1.1 | **run 1 failed**, run 2 passed |
| v3.0.3, v3.0.2, v3.0.0, v2.1.0, working tree, working tree DUO | all passed |

Four of five are the FIRST run after a fresh APK install, when the app's own
startup polling is heaviest. And **no failure has ever been seen on the
working tree** - not in the sweep, and not in eleven deliberate reproduction
runs afterwards (eight warm, three each preceded by a reinstall), where the
measured rate predicts about three.

### What it sits at the end of

The test before it ends with a deliberate wrong PIN, a retry read, a
successful token fetch and another retry read. `changePin` then adds four more
round trips of its own (`fido.js:176` - pinState, guard, agree, change). So
the failing call is the eighth or ninth `clientPin` exchange in a burst.

### The shape now suspected, and how to confirm it

HEAD's own comment on an adjacent fix names the mechanism class exactly
(`fido2/ctap.cpp`, on `pending_operation`):

> it is a global owned by a different code path: `process_packets()`
> (okcore.cpp) resets it to `CTAP2_ERR_NO_OPERATION_PENDING` on every inbound
> raw-HID packet, which includes the CTAPHID packets carrying these very polls

The app polls the vendor interface continuously for status broadcasts while a
CTAPHID burst is in flight. Concurrent raw-HID traffic clobbering a global
mid-exchange would account for all of it: intermittent, worst on a cold first
run, absent on the working tree if HEAD has since tightened that path, and a
status that contradicts itself - the device plainly knows `clientPin`, it ran
it seconds earlier.

**Instrumented rather than patched.** `4b-fidoPin.e2e.js` now taps the bus
across the first `changePin` and dumps the last forty frames on failure, each
tagged by interface (`kbd`/`fido`/`vend`/`ser`). The next occurrence will show
whether vendor traffic is interleaved with the FIDO exchange at the moment it
fails, which is the difference between this theory and another guess. A delay
would have made it rarer and taught nothing.

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

## Narrowed, 2026-09-18 — it is the BUFFER, not the command

The instrumentation paid off: a run failed with the bus tap armed, and the
capture plus the firmware source rules out most of the field.

The wire, around the failing exchange:

```
+364ms fido>  init frame, 188-byte clientPin changePIN (subcommand 0x04)
+381ms fido>  seq 0
+504ms fido>  seq 1        <- a 123ms gap mid-message
+520ms fido>  seq 2
+521ms fido<  01           <- CTAP1_ERR_INVALID_COMMAND
```

**Where that byte comes from.** `CTAP1_ERR_INVALID_COMMAND` is reachable from
exactly one place on this path — the `default:` arm of the top-level dispatch
in `ctap.cpp:2452-2454`:

```c
default:
    status = CTAP1_ERR_INVALID_COMMAND;
    printf2(TAG_ERR,"error, invalid cmd: 0x%02x\n", cmd);
```

`cmd` is the **first byte of the reassembled CBOR buffer**. We sent `06`,
`CTAP_CLIENT_PIN`, which has its own case immediately above. So the device did
not reject our command: **it read a different first byte than we sent.**

**What it is not.**

- *Not the CTAPHID transaction timeout.* `ctaphid_check_timeouts()` fires at
  750ms per CID (`ctaphid.cpp:348-356`) and answers `CTAP1_ERR_TIMEOUT`. The
  stall was 123ms and the error was not TIMEOUT.
- *Not a sequencing fault.* The reassembly path raises `CTAP1_ERR_INVALID_SEQ`
  for an out-of-order or restarted message and `CTAP1_ERR_CHANNEL_BUSY` for a
  crossed channel (`ctaphid.cpp:462-506`). Neither came back. **The frames
  arrived in order and reassembly believed it had succeeded.**
- *Not the device forgetting the command.* The same subcommand succeeded
  seconds earlier in the same session.

**So: right sequencing, wrong contents.** The buffer was accepted as complete
while holding something other than what was sent — which is the signature of
the assembly globals (`ctap_buffer`, `ctap_buffer_offset`, `ctap_buffer_bcnt`)
being reset or written from elsewhere between the init frame and the dispatch,
rather than of frames being lost on the way in.

That is the same "clobbering a global" theory as above, but now with the global
identified and, more usefully, with two competing explanations eliminated by
the device's own choice of error code.

**The one measurement still missing** is what byte it actually read. The
firmware prints it — `error, invalid cmd: 0x%02x` — on the debug console, so a
debug build that captures `[fw]` output across the failure answers it outright.
A stale byte from the previous exchange and a truncated-then-misread payload
look identical on the wire and different in that one line.

Still intermittent: it did **not** reproduce in either full run on 2026-09-18
(`passed=99 failed=0`), so catching it needs repetition rather than a
particular sequence.
