# Polling the key interferes with entering a PIN on it

Found 2026-09-13 while building the config-mode flow, on the developer hard key.

## What it was

Config mode locks the key and the unlock that follows is never announced, so
the app cannot see it happen. The obvious answer is to ask repeatedly: a slot
label read every 2.5 seconds, which the firmware answers only when unlocked
(`okcore.cpp:379-396`). As a detector that worked exactly as designed - watched
live, it reported `UNLOCKED` over an app still showing `Locked`, and `locked`
again after a replug.

## What it broke

Entering the PIN on the key itself.

The probe writes `OKGETLABELS` on the vendor interface. Doing that every couple
of seconds while someone is pressing the key's own buttons interferes with the
digits landing - the thing the probe is waiting for is the thing it disturbs.

That is the worst shape a check can have. It is not merely useless while the
user is busy; it actively prevents the event it exists to detect, and it does so
silently, so the symptom is "my PIN did not go in" rather than anything
pointing at the poll.

## Fixed

It is a button now: **Check config mode**, on the config panel beneath the PIN
pad and in the Testing panel. One press, one label read.

The person pressing it has just finished typing their PIN and knows they have.
The app does not have to guess, does not have to ask on a timer, and cannot get
in the way while they type. Nothing polls the key at all any more.

## Worth remembering

Every other poll in this app watches something the app itself is not competing
with - USB attachment, the Bluetooth host list, the firmware's own broadcasts.
This one shared a wire with the user's fingers.

Before adding a poll, ask what it writes and who else is writing at the same
time. See also FINDING-counted-presses-merge-without-an-idle-gap.md, where the
firmware's own timing was the thing being disturbed.
