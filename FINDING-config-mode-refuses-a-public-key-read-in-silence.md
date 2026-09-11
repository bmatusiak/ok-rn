# Config mode refuses a public-key read, and says so only to itself

Found 2026-09-11, bringing up on-device post-quantum key generation
(`__e2e_tests__/9b-pqcSlots.e2e.js`) on the soft key.

## What it looked like

The device generated an X-Wing key into slot 105 and handed back all 1216
bytes of the public half. Reading the same slot back, one test later, failed:

```
slot 105 did not answer OKGETPUBKEY within 15000ms
```

Which reads as a key that was never stored - the exact failure the firmware's
own comment at `okcore.cpp:5342` warns about, where a PQC keygen falls through
to the ordinary write and the slot ends up holding a different key from the one
just reported. So the natural conclusion was the worst one available.

## What was actually happening

The suite was changed to log the firmware's debug console and every vendor
report during the read. The console said:

```
Received packet
FF FF FF FF EC 69 06 00 00 ...
ERROR NOT SUPPORTED IN CONFIG MODE
```

and the vendor interface carried **zero reports**. Both times.

`OKGETPUBKEY` is refused while the device is in config mode. The key was
stored perfectly well; the question was never asked.

## Why it cost a debugging cycle

The refusal exists only on the DEBUG serial console, which is a build option
and is not there on a production key at all. On the wire there is nothing:
no error sentence, no status, no empty reply. A host cannot tell this apart
from a device that has crashed, a slot that is empty, or a cable that has
fallen out - all it sees is its own timeout expiring.

This is the same shape as a slot number past 116, where `okcrypto.cpp` has no
`else` and the request simply evaporates. Two different reasons, one
indistinguishable symptom.

## What changed here

Only the suite. Generation needs config mode; reading back does not and cannot
have it. So the order is now:

1. enter config mode
2. generate into slot 105, and into 106 to prove they differ
3. **restart, which is the only way out of config mode, and unlock again**
4. read slot 105 back and compare against what generation reported

Step 3 is not tidying up at the end any more - it is a step the next test
depends on, and its comment says so.

## What was NOT changed, and why

Nothing in the library. `getPublicKey` could refuse early when the session
knows it is in config mode, and that would turn a silent timeout into a
sentence. It is not done here because the library does not currently track
config mode as session state - `enterConfigMode` is a gesture helper, and
nothing records that the gesture landed. Inventing that state to improve one
error message would put a second, inferred copy of the device's mode in the
host, and a wrong copy of it would refuse operations the device would have
accepted. The device is the authority on its own mode.

If config mode does become session state for another reason, this is a good
error message to add on the way past.
