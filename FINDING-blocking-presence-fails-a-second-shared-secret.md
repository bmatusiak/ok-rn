# On the 2.1 line, a SECOND shared-secret derive in quick succession is refused

**Where:** the derive suite against `v2.1.1` (and `v2.1.0`); the firmware side is
`ctap_user_presence_test(5000)`
**Status:** NOT ROOT-CAUSED. Reproducible, isolated to the 2.1 line, and
demonstrated NOT to be caused by the suites added in this session.

## What happens

Two tests in `__e2e_tests__/10-derive.e2e.js` fail on `v2.1.1`:

- `the SHARED SECRET is stable across calls, not just the public key`
- `a sealed credential survives being stored and read back`

Both fail the same way, and the library names it correctly:

```
the device did not answer this derive - the reply carries no device status,
so it is not a response to this request.
```

What the two have in common is that each performs **more than one
shared-secret derivation in quick succession**. Every test that does a single
one passes, including `a shared secret can be derived against that key`.

## What is NOT the cause

**The suites added in this session.** `8b-backup` presses button 1 for a
gesture and provokes nine seconds of typed refusal shortly before the derive
suite, which is exactly the kind of thing that would disturb it. Ruled out by
running every suite EXCEPT that one:

| run | result |
|---|---|
| full suite | 67 passed, 1 failed, 3 skipped |
| full suite | 67 passed, 1 failed, 3 skipped |
| full suite | 67 passed, 1 failed, 3 skipped |
| full suite | 66 passed, 2 failed, 3 skipped |
| **without `backupCapture`** | **65 passed, 2 failed, 2 skipped** |

The same two tests fail either way. Removing the new suite changes nothing.

**The 3.0 line.** `working-tree`, `v3.0.2`, `v3.0.1` and `v3.0.0` all pass the
full suite with these same tests in place. This is specific to 2.1.

## ROOT CAUSE, and it took instrumentation to see

`capabilities().presenceTest` is `'blocking'` on the 2.1 line and
`'keepalive'` on 3.0 - see
FINDING-old-firmware-blocks-for-a-touch-instead-of-asking.md.
`ctap_user_presence_test(5000)` blocks for five seconds and then denies. There
is no keepalive to answer, so the host presses on a 900 ms TIMER instead, armed
when `pressing()` is constructed - late enough that the request has reached the
device, because a press before the ceremony starts is discarded and costs the
whole window.

The library retries a derive up to `DERIVE_ATTEMPTS = 3` times on this exact
error. It reused the caller's `onKeepAlive` without announcing the retry, so a
host with one press per ceremony had already spent it. Once every attempt was
logged this was immediate:

```
derive attempt 1/3 for "vault.example"
pressed button 1 for the derive (timer - this firmware does not keepalive)
derive attempt 2/3 for "vault.example"      <- no press
derive attempt 3/3 for "vault.example"      <- no press
```

**The retry was useless on precisely the firmware that needs it.**

Counting `pressed button 1` lines against the tests around them is how this was
guessed at twice, wrongly - once as "the new backup suite disturbs it" and once
as an account whose press count did not add up. Deduction lost again;
instrumentation took one run.

## The fix is in two halves, and the first version of it was wrong

The library announces each attempt (`progress` `{step: 'derive', attempt}`) and
calls `onKeepAlive({retry: true, attempt})` before issuing a retry. It does not
press - it says a fresh touch is wanted and leaves the buttons to the host.

The host re-arms its budget on that signal. **The first attempt at this pressed
IMMEDIATELY, and it changed nothing**: the library calls the hook BEFORE the
retry request goes out, so the press landed before the ceremony started and was
discarded - the exact failure the 900 ms timer exists to avoid. A run with a
press logged against attempts 2 and 3 still failed both tests, which is what
said so. Re-arming the timer rather than pressing is what works.

Result on v2.1.0, from 66 passed / 2 failed:

```
Passed: 68 Failed: 0 Skipped: 3
```

## A correction to an earlier version of this file

It called the failure "reproducible" and said the same two tests fail every
time, on two runs. A third run passed both. It is TIMING-SENSITIVE and the two
multi-derive tests are simply the most exposed - which is consistent with the
cause above, since whether attempt 1 lands inside the five-second window is what
decides if a retry is needed at all.

## What was ruled out along the way

**The suites added in this session.** `8b-backup` presses button 1 for a
gesture and provokes nine seconds of typed refusal shortly before the derive
suite. Ruled out by running every suite EXCEPT that one and getting the same two
failures.

**The 3.0 line.** `working-tree`, `v3.0.2`, `v3.0.1` and `v3.0.0` all pass
with these same tests in place. The device asks for a touch there, so the host
is already answering and the missing retry signal never mattered.
