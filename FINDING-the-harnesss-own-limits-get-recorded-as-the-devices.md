# The harness's own limits get recorded as the device's

**Severity:** medium — it does not break anything, it writes down something
false in a place that is later trusted. Two assertions and one reverted commit
came from it in a single day.
**Status:** handled for the instances found; the pattern is the point.
**Applies to:** the e2e suite and the FINDING notes, not to the firmware.

## The shape

A test exercises the device through a harness. The harness has a limitation.
The test fails. The failure is written down as a fact about the **device**,
because that is what the test was nominally about — and from then on the
assertion defends the wrong thing, and the note misleads whoever reads it next.

It is hard to spot because the evidence is real. The test really did fail. The
device really did refuse. Everything except the attribution is correct.

## Three instances, all on 2026-09-18

**1. A vault seal "could not" be made.**

`10-derive.e2e.js` asserted that a seal must fail. The real cause was that a
press took 757–855ms on the sensed path, which missed the keepalive window the
operation needed. The device was capable throughout. Once presses went through
the injected queue at ~96ms the operation succeeded, and the assertion — which
had been protecting the bug — had to be inverted.

**2. `COUNTED_TAP` "broke unlocking".**

A benchmark suite, `7b-pressBench`, pressed buttons to measure them. Those
presses landed in the locked key's PIN buffer, so the `deviceFlow` suite that
ran afterwards could not unlock. The conclusion drawn was that the new press
path was faulty, and a good commit was reverted on that evidence. The press
path was fine; the suite ordering was not. The benchmark was renumbered from
`2d-` to `7b-` so it runs after the flows it was poisoning.

**3. "A release cannot be provisioned."**

`FINDING-provisioning-needs-a-debug-build.md` stated that setting a PIN
requires a DEBUG build, because the bracket's prompts are `Serial.println`
inside `#ifdef DEBUG`. True of the prompts the library was reading. The
firmware also announces every step with `hidprint`, ungated, on the vendor
interface — a channel the first implementation simply did not watch. A
production build provisions, and did so on device the same day.

## What they have in common

In each case the sentence written down was of the form *"the device cannot X"*,
when the supportable sentence was *"we could not get the device to X **this
way**"*. The second is falsifiable by trying another way. The first invites
nobody to.

The same shape appeared on the Bluetooth side the same week and cost two days —
`FINDING-removing-a-windows-pairing-does-not-clear-what-windows-cached.md`. The
app reported "registered" truthfully and it meant nothing about the host, so
every local signal agreed with a conclusion that was wrong.

## What to do instead

- **Name the path in the claim.** "Sealing fails when the presence press takes
  >700ms" survives contact with a faster press. "Sealing fails" does not.
- **Before asserting a device limit, change one thing about the harness.** A
  different press path, a different channel, a different suite order. A real
  device limit is indifferent to all three.
- **Suspect ordering when a suite fails only in company.** Two of the three
  above were invisible when the suite was run alone.
- **When a claim is about a peer, measure the peer.** Local state cannot tell
  "working" from "the other side is ignoring us"; it reports success either
  way. That is what `tools/btcache.js` exists for.

## Why this is worth its own note

These do not read as mistakes afterwards. They read as findings — with
measurements, logs and a reproduction. The only thing separating a good finding
from one of these is whether anyone tried the same thing a second way before
writing it down, and that step leaves no trace when it is skipped.
