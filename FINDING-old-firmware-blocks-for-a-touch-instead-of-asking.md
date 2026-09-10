# The 2.1 line blocks for a touch instead of asking for one

**Severity:** high for any host written against newer firmware — every
press-required derive fails, and the device blames the user
**Status:** handled by knowing about it. `capabilities().presenceTest` reports
which behaviour a device has, and the suite presses accordingly. **No firmware
patch** — a real v2.1 key behaves this way.
**Applies to:** OnlyKey firmware v2.1.0 and v2.1.1 (measured); fixed somewhere
before v3.0.0

## The two behaviours

A derive that needs user presence is answered in one of two ways, and the split
is the generation boundary:

| firmware | `ok_extension.cpp` | what a host must do |
|---|---|---|
| v3.0.0 and later | returns `CTAP2_ERR_PROCESSING` while it waits; the host keeps polling and the device sends KEEPALIVE | press from inside the keepalive |
| v2.1.1 and earlier | `ctap_user_presence_test(5000)` **blocks** for five seconds, then returns `CTAP2_ERR_OPERATION_DENIED` | press on a **timer**, shortly after the request |

Measured by whether `CTAP2_ERR_PROCESSING` appears in that file at each pin:
present at `5d7ce7a`, `a27ffa6` and `5515974`; absent at `0dc7cf0` and
`8687474`.

## Why it presents as something else

On the older firmware there is nothing to answer. A host that presses only when
asked is never asked, so it never presses, and five seconds later the device
says the operation was DENIED. That is the same status it would send if someone
had been standing there and refused to touch it.

Measured on a v2.1.0 soft key: **every press-required shared-secret derive
failed** while the touch-free derives beside them passed, seven tests at a time,
none of them naming a press.

## What was done

`capabilities().presenceTest` is `'keepalive'` or `'blocking'`. An unreadable
version reports `'blocking'`, which is the safe direction: pressing on a timer
completes a ceremony on either firmware, while waiting to be asked completes
nothing on the older one.

The e2e press helpers arm a 900ms timer when the device blocks, and the press is
still guarded so a keepalive arriving first wins and only one press is ever
sent — an extra press on an unlocked device types a slot.

With that, **v2.1.0 passes 67 of 67**.

## Related, found in the same session

A request issued immediately after another one is **dropped** on v2.1.0. The
first key write produced no answer and no console output at all; the identical
write 1.5 seconds later succeeded. `device.loadKey` had been the one command in
its plugin that did not wait for an acknowledgement — `sendField` has retried
since it was written — so a lost write was indistinguishable from a successful
one until the slot turned out to be empty one operation later. It now waits and
retries.
