# The 2019 beta restarts itself during PIN entry, on purpose

## What happens

v0.2-beta.8 boots, provisions, comes back INITIALIZED and maps all six
buttons. Then the unlock never completes:

```
✗ unlocks with the PIN -> the device did not unlock within 20000ms
✗ …                    -> button 1 still owes 10 of 10 ticks after 10000ms
                          - the firmware main loop is not running
```

The version script used to say this was "the same shape as the setup() crash",
something dereferenced where the hardware would have tolerated it. **It is not
a crash.** Logcat across a failing unlock carries no SIGSEGV, no fault address,
no tombstone. What it carries is this:

```
I okemu        : firmware started, storage=…/files/okemu/v0.2-beta.8
I ReactNativeJS: [softkey] OKCONNECT ok: "INITIALIZED"
I ReactNativeJS: [softkey] CPU_RESTART() - firmware thread gone, restart the app
```

The firmware asked for a reset itself. On hardware that is a reboot; here the
firmware thread only exits through the AIRCR trap and cannot be restarted in
process, so the main loop is simply gone afterwards - which is exactly what
"button 1 still owes 10 of 10 ticks" is reporting, one symptom later.

## Which CPU_RESTART

The only one on the PIN path is rngloop's INTEGRITY CHECK
(`okcore.cpp:2279-2285`):

```cpp
integrityctr2++;
if (integrityctr1 != integrityctr2)
{ //Integrity Check
    unlocked = false;
    CPU_RESTART();
    return;
}
```

This release is threaded throughout with paired `integrityctr1++` /
`integrityctr2++` - about thirty sites across the sketch and okcore.cpp. It is
a glitch-detection scheme: skip an instruction and the two counters disagree,
and the device resets rather than continuing in a state an attacker chose.
rngloop increments one at :2263 and the other at :2279, then compares, so any
imbalance left anywhere else is caught on the next pass of the main loop.

## Where the imbalance looks like it comes from

READ FROM THE SOURCE, NOT MEASURED, and the difference matters - the last
guess written into this release's notes was wrong and cost the time it saved.

`OnlyKey.ino`'s PIN handler increments as follows on a press that does not
complete a valid PIN:

| line | counter | condition |
|---|---|---|
| 536 | ctr1 | always |
| 559 | ctr2 | only inside `if (firsttime)` |
| 561 | ctr1 | only inside `if (firsttime)` |
| 574 | ctr2 | always |
| 576 | ctr1 | always |
| 579 | ctr2 | only inside `if (unlocked \|\| profile1hashevaluate() \|\| profile2hashevaluate())` |

On a press that leaves the PIN incomplete the last branch is not taken, so
ctr1 gains two and ctr2 one. rngloop then adds one to each, compares, and
restarts.

That reading cannot be the whole story, because it would mean the device
resets on the first digit of every PIN on real hardware too. Something must
re-balance it there - a branch this staged build takes differently is the
obvious candidate, and `profilemode == NONENCRYPTEDPROFILE` gates several
paths in this area, including an early return in `set_private` that leaves the
same counters unbalanced (`okcore.cpp:5105-5107`).

## The next measurement, named rather than guessed

Print both counters at the check. A DEBUG build has `Serial` and this release
is staged with `OKEMU_DEBUG=1`, so one `Serial.println` before
`okcore.cpp:2280` says which side is ahead and by how much, and whether it
happens on the first digit or the last. That turns the table above from a
reading into a measurement, and says whether the imbalance is inherent to the
release or something this staging does.

It is a diagnostic print, not a behaviour change, so it belongs in a throwaway
`.stage` copy and not in the version script's patch list unless it earns a
place there.

## Not fixed

Status stays `boots`. The release does everything up to the unlock and nothing
after it, and now the reason is a named mechanism rather than "the main loop
stops".

Worth saying plainly: nothing here suggests the firmware is wrong. A device
that resets when its integrity counters disagree is doing what it was built to
do. What is unknown is why they disagree under this staging.

## Measured

`OKEMU_VERSION=v0.2-beta.8 OKEMU_DEBUG=1`, built and installed, then
`node tools/e2e.js --only deviceFlow`: boots, reports its lock state, is
silent to a label read while locked - and then fails the unlock with no crash
in logcat and `CPU_RESTART()` logged by the emulator at the moment it stops.
