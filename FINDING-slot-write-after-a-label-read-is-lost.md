# A slot write issued straight after a label read is never looked at

**Severity:** medium — silent, and every field of the slot editor is this call
**Status:** fixed — `readLabels` no longer resolves inside the window, and
`setSlot` resends an unacknowledged frame
**Applies to:** ours — `node-onlykey-lib/src/device/slots.js`,
`node-onlykey-lib/plugins/device/index.js`

## The measurement

`__e2e_tests__/3-deviceFlow.e2e.js` — "writes a slot label and reads it back",
on a Pixel 6a:

| | runs | failed |
|---|---:|---:|
| before | 10 | **4** |
| with a 400 ms pause before the write | 6 | 0 |
| with the fix | 6 | 0 |

Nothing else in the suite failed, and the rate was stable across unrelated
changes.

## What is actually happening

Captured across the failing write, on every interface:

```
+5458ms ser<  12 7C FF FF ...        the last label report
+5470ms vend> e2e4654                our OKSETSLOT goes out, 12ms later
+10499ms ser< wipe buffers after 5 sec
```

and **nothing** in between. Not the acknowledgement, not the once-a-second
status broadcast, and — the line that settles it — not the
`Serial.print("Received packet")` that `recvmsg()` emits for every frame it
looks at (`okcore.cpp:342-344`).

So the frame was not dropped, not misrouted, and not filtered by the client. It
was **never looked at**. `recvmsg()` was not running.

`readLabels()` resolved on the last label, but `get_slot_labels()` had not
returned yet: it still owed the `delay(20)` that follows each
`send_transport_response` (`okcore.cpp:1578-1583`) and the walk back out of
`recvmsg()` and `checkKey()`. A write issued inside that gap sits in the queue
until the firmware next services HID.

The window is about 20 ms wide, and `readLabels()` used to resolve at the start
of it — which is why a write issued 12 ms later lost the race roughly 40% of the
time, and why nothing in the suite that wrote at any other moment ever failed.

## Two wrong turns worth recording

**The first version of this file guessed the cause and got the mechanism
wrong.** It said the firmware "does not service incoming vendor packets while it
is still emitting that list", and proposed that stale label reports were being
mistaken for the reply. The first half was roughly right; the second was not —
`isSlotAcknowledgement` already excludes them, and the real problem was the
`delay(20)` *after* the list, not the list itself.

**The diagnostic built to test that guess reproduced nothing.** Eight writes
with no label read, then eight writes each straight after one: 0 failures out of
16. That looked like it exonerated the label read, and it did not — it only
showed that `readLabels()` followed by `setSlot()` at *test* speed usually
misses a 20 ms window. The cause was only found by capturing the traffic around
the real failure and noticing which debug line was **absent**.

Absence was the whole signal. Every present line had an innocent explanation;
the missing "Received packet" is what proved the frame was never examined.

## The fix, in two parts

**Do not create the window.** `readLabels()` takes a `settleMs` (default 60)
and resolves after it rather than on the last report. Sixty milliseconds is
comfortably past the firmware's own `delay(20)` plus its return path, and is not
perceptible in a UI that has just drawn twelve labels.

**Survive it anyway.** `setSlot()` resends a frame the device never
acknowledged, up to `retries` times (default 2). This is the general fix and it
is not redundant with the settle: a silent device is an *unknown* write, not a
failed one, and any number of other things can make the firmware busy at the
wrong moment. An `Error ...` reply is a definitive answer and is never retried —
resending would be arguing with the device.

Resending is safe for every field this sends. Each frame is a complete
self-contained store of one value, so writing it twice leaves the slot exactly
as writing it once would.

`applied[].attempts` reports how many it took, so the retry is visible rather
than hidden. With the retry alone and no settle, two of six runs took a second
attempt and cost a full timeout — which is why not creating the window is worth
doing as well.

## A read straight after a read, sometimes (2026-09-11)

`device.getPublicKey` arrived with no settle, and a read issued immediately
after another one is sometimes never answered.

Measured on the Pixel bench, soft key, the `cryptoSign` suite's two startup
probes. They ask slot 101 and then slot 103, back to back. Across four runs:

| slot 101 at probe time | slot 103 |
|---|---|
| holds a key | answered |
| holds a key | answered |
| **empty** (answers with an error sentence) | **no answer, timed out** |
| **empty** | **no answer, timed out** |
| **empty**, with a 60 ms settle in place | **no answer, timed out** |
| **empty**, with settle and retry | answered, retry not needed |

So: it only ever happened when the FIRST read hit an empty slot — which
answers with `hidprint`'s "Error no ECC Private Key set in this slot"
rather than with key bytes — and it is **intermittent**, not deterministic.
The last run above answered on the first attempt with nothing but luck
different. A 60 ms settle alone did not prevent it.

**What is NOT established.** Whether this is the same dead window this
finding describes. The shape matches — a read, then a write the firmware
never looks at — and the error path differs from the key path only in going
through `hidprint`, but nothing here traced the firmware far enough to say
so. Calling it the same cause would be a story, not a measurement.

**What was done.** `getPublicKey` settles 60 ms before returning, on the
refusal path as well as the success path, and resends once if the device
says nothing at all. A read is idempotent, so a resend cannot do half a
thing, and an unanswered read is unknown rather than failed — the rule
`sendField` and `loadKey` already follow for writes. Only silence is
retried; a refusal, an error and a key all count as answers.

**Still open:** the underlying silence. It is now survived rather than
understood, and the retry will hide it from here on, so if the cause
matters later it needs a bus capture of the empty-slot reply with the next
frame beside it — the way the original measurement above was made.
