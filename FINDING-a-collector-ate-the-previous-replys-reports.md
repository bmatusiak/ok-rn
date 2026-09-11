# A collector ate the previous reply's reports, and blamed the user for it

Found 2026-09-11, on the first live run of the post-quantum slot suite
(`__e2e_tests__/9b-pqcSlots.e2e.js`) against the soft key.

## What it looked like

The suite reached config mode, triggered a key generation, and was told the
challenge was `1-2-1`. It pressed **one** button instead of three, waited, and
failed a minute later with:

```
slot 105 produced no key within 60000ms; the challenge was 1-2-1
  - were those buttons pressed?
```

Which is an accusation, and a wrong one. The buttons were not pressed because
the library had already said the device had answered.

## What was actually on the wire

The suite was changed to log every vendor report and the firmware's own debug
console during the generation. Twelve reports arrived, and none of them were a
key:

```
[01 7c 62 61 6e 64 2d 61]  .|band-a......
[02 7c 74 79 70 65 64 00]  .|typed.......
[03 7c ff ff ff ff ff ff]  .|............
[04 7c ff ff ff ff ff ff]  .|............
```

`[index, 0x7c, label]` is the answer to a slot-label listing. `band-a` and
`typed` are labels earlier suites wrote. The app refreshes its slot list when
the device unlocks, and this suite unlocks the device on its way into config
mode - so the listing was still streaming when the generation went out.

## Why the collector could not tell

A post-quantum public key comes back as consecutive 64-byte reports with **no
length, no tag and no terminator anywhere in it**. The only thing that ends
the read is a byte count the caller supplies. So any report arriving on the
vendor interface is, as far as the collector can see, the next 64 bytes of the
key.

The first label report started the key. That set `answered`, which
`generateKey` hands to the caller as `isAnswered()` - the flag that exists so
a client pressing on someone's behalf can **stop early**, because for slots
101..116 the firmware may accept a single press instead of three
(okcore.cpp:7567-7573). The suite did exactly what it was told and stopped
after one button. The generation was never confirmed.

So one stale reply produced a wrong answer, a wrong number of button presses,
a sixty-second wait, and an error message pointing at the user.

## Two fixes, and why the first is not enough

**Reports sent before our request are dropped.** Nothing the device emitted
before the trigger left the host can be a reply to it. Correct, cheap, and it
fixed nothing here - the label listing was still arriving *after* the write.

**Wait for the bus to go quiet first.** `generateKey` now waits for a gap with
no vendor report (`quietMs`, 250ms, capped by `quietTimeoutMs`) before sending
the trigger. Reaching the cap is not an error; the operation proceeds and its
own timeout covers it. A few hundred milliseconds in front of an operation a
human takes several seconds to confirm.

## What this says about the other collectors

`readPublicKey` and okcrypto's `deviceOperation` have the same shape and the
same blind spot. Neither has been seen to fail this way, and both are usually
called well after any other traffic - but "usually" is what this was too.
`FINDING-slot-write-after-a-label-read-is-lost.md` is the same family of
problem from the other direction, and its cause was never established either.

Not changed here, deliberately: a fix applied to a path nobody has seen fail
is a change with no measurement behind it, and these two are on the hot path
of every suite. The place to start, if it happens again, is that a label
listing is the traffic that keeps turning up in both findings.
