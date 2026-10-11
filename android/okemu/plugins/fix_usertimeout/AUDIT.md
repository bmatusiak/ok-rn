# fix_usertimeout: a stale 20 s timer answers "Timeout" for the next request

A fix for the OnlyKey 3.1.0 firmware, staged as a plugin so it can be built and tested on its own
before it is proposed upstream. Hard keys running 3.1.0 have the same code.

## The issue

`okcore_prime_user_confirmation()` starts the 20 s user timer (`fadeoffafter20()` →
`Usertimeout`, a `DelayRun`) every time a request is primed for confirmation. Nothing stops the
timer when the request is decided: `okcore_run_pending_op()` clears `CRYPTO_AUTH` and fades off,
but the timer keeps running and expires 20 s after the last prime.

When it expires, `fadeoffafter20sec()` checks `isfade || CRYPTO_AUTH` and `pending_operation`.
If the next request's packets are arriving at that moment, its first `OKSIGN` or `OKDECRYPT`
packet has already set `pending_operation` to `OK*_ERR_USER_ACTION_PENDING`, while its own prime
(which would restart the timer) has not run yet. The old timer then:

- sends `Timeout occured while waiting for confirmation on OnlyKey` to the host, which reads it as
  the answer to the new request - a refusal;
- fades red and wipes the packet details.

The new request is then primed and may even complete, but the host has already given up on it.

**When it happens:** any sign or decrypt whose packets start arriving about 20 s after the
previous prime - for example an ssh login 20 s after a confirmed sign. A multi-packet request over
a slow link widens the window.

## The fix

One line, at the start of `okcore_run_pending_op()`:

```c
cancelfadeoffafter20(); /* the request is decided: its 20 s wait for the user is over */
```

`okcore_run_pending_op()` runs once a primed request is decided - after the press or challenge,
or at once for a request that needs no press. From then on the timer has nothing left to guard.
`cancelfadeoffafter20()` already exists (it removes `Usertimeout` from the timer list); the FIDO2
code uses it the same way.

**What it does not change:** a request that is never decided still times out after 20 s, with the
same message, the same red fade and the same wipe. Paths that end a waiting request without
`okcore_run_pending_op()` (for example a wrong challenge) are unchanged; they leave the timer
running as before.

## The test

`tests/kit.test.js`, run by the onlykey-testing kit (`01-protocol/38-softkey-plugins.test.js`) on
an emulator built with this plugin:

1. Request A, a two-packet `OKSIGN`, is primed and pressed.
2. Request B's first packet is sent 19 s after A's prime. Its last packet is sent once the
   emulator's DEBUG console reports that the 20 s timer has expired.
3. Before B is pressed, the host must not have received "Timeout occured". After the press, B
   must be signed.

Without the fix the test fails: B is answered "Timeout occured while waiting for confirmation on
OnlyKey" before it can be pressed. With the fix it passes.

**Recorded runs** (desktop emulator, 3.1.0 tree, DEBUG build, 2026-10-10):

| Build | Result |
|---|---|
| this plugin with no hooks | fail: the old timer ran out 20,068 ms after A's prime, between B's packets; B was answered "Timeout occured while waiting for confirmation on OnlyKey" before its press |
| this plugin with the hook | pass: no timer ran out by 21,512 ms; B received nothing before its press and was signed after it |
| with the `config` and `edge` plugins as well | the whole plugin kit: 25 pass, 0 fail, 1 skip |

The same issue was first seen on a phone: an ssh login made 20 s after a confirmed request
received "Timeout occured" although the key primed it once and signed it.

## Hooks

| # | File | Where | What |
|---|---|---|---|
| 1 | okcore.cpp | first line of `okcore_run_pending_op()` | `cancelfadeoffafter20();` |

No new messages, no storage, no new source file.
