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

## The one thing that is different about 2.1

`capabilities().presenceTest` is `'blocking'` there and `'keepalive'` on the 3.0
line - see FINDING-old-firmware-blocks-for-a-touch-instead-of-asking.md.
`ctap_user_presence_test(5000)` blocks for five seconds and then denies. There
is no keepalive to answer, so the suite presses on a 900 ms TIMER instead, armed
when `pressing()` is constructed.

**A suspicion, stated as one.** `pressing()` presses at most once per instance,
and one instance is constructed per device operation. The library retries a
derive up to `DERIVE_ATTEMPTS = 3` times on this exact error, reusing the same
`onKeepAlive` - so on blocking firmware a retry may get no press at all, because
the timer that would have supplied one already fired for the first attempt.

That would make the retry useless on precisely the firmware that needs it most.
It is NOT confirmed: a failing run logs FOUR presses for a test that constructs
only two `pressing()` instances, and that number is not explained by this
account. Something else is pressing, or the instances are being constructed more
often than reading the test suggests.

## What it would take to settle it

Attempt-level instrumentation. The library's derive retry emits nothing per
attempt, so a log cannot currently distinguish "attempt 2 went out without a
press" from "attempt 2 was pressed and still denied". Emitting a progress event
per attempt would make the press-per-attempt question answerable directly rather
than by counting log lines - and deduction has lost to instrumentation every
time on this project.

## Why it is recorded rather than fixed

The fix, if the suspicion is right, is a library change to how a retry signals
the host - and guessing at it would be a change to the derive path, on the
strength of a count that does not add up. The evidence above is worth more than
a speculative patch.
