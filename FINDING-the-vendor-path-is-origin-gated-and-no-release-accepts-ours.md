# This library cannot reach the vendor path on any released firmware

## What happened

Building the pinned releases as PRODUCTION rather than forcing the debug gate
on turned one `ctapFlow` test red on v3.0.4:

```
✗ a vendor request reaches the device through the tunnel
  -> the tunnel produced neither an answer nor an error:
     "CTAP2_ERR_EXTENSION_NOT_SUPPORTED"
```

The same test, on the same firmware, passed thirteen times in the sweep before
it - once per build in the matrix. Nothing about the firmware changed between
those runs. The only difference is the DEBUG gate.

## Why

`webcryptcheck()` decides whether a FIDO2 request is allowed to reach the
OnlyKey vendor path. It is in `fido2/device.cpp:83` at every pinned release,
and it begins like this:

```c
    #ifdef DEBUG
    ... byteprint of the ids ...
    return 2; // Trust all origins for debug firmware
    #endif

    appid_match1 = memcmp (stored_apprpid, rpid, 12);
    appid_match2 = memcmp (stored_appid, _appid, 32);
    if ((appid_match1 == 0 || appid_match2 == 0) && ...) return 2;
```

**On a debug build it returns before comparing anything.** Every origin is
trusted, so any rpId reaches the vendor path and the test passes. With the gate
off, the comparison actually runs, and `stored_apprpid` is
`"apps.crp.to"` - spelled out byte by byte in the source.

The library's tunnel sends `onlyagent.app`. `src/protocol/ctap.js:42` sets
`RP_ID = 'onlyagent.app'`, and `tunnel.js` binds every request to it. No
release knows that origin: it was added to the firmware in
`libraries@a5b731f` (2026-07-08), "fido2: accept onlyagent.app origin
alongside apps.crp.to", which is working-tree work and has never shipped.
`git grep onlyagent.app` finds nothing at `5d7ce7a` (v3.0.2) or `c8804e3`
(v3.0.4) and two hits at HEAD.

So the origin does not match, `ok_extension.cpp:364` sets
`CTAP2_ERR_EXTENSION_NOT_SUPPORTED` with the comment "APPID doesn't match",
and the tunnel gets neither an answer nor a device-authored error.

## It is not the tunnel. It is the whole vendor path

The tunnel was only where it surfaced first. `ok_extension.cpp:137` wraps
EVERY branch of the OnlyKey extension in the same call:

```c
    if (webcryptcheck(_appid, client_handle)) {
```

OKCONNECT, the derives, the tunnel - all of it is inside that `if`. When the
origin does not match, the branch is skipped and the device answers nothing at
all. Once the tunnel test was made to skip and the sweep ran on, v3.0.4's
`derive` suite failed seven tests, every one of them with "the device did not
answer this derive": the public key, the same-label determinism, the different
-label check, the shared secret, its stability, X-Wing, the age file.

So on a RELEASED OnlyKey, `okcrypto.derivePublicKey` and everything built on
it - derived passwords, the vault, age identities - go unanswered through this
library. That includes the app's Crypto tab against a real production key.

**The official web app is unaffected**, which is why nobody has hit this: it
is served from `apps.crp.to` and matches. The origin this library chose is the
new agent site's, and `ctap.js:36-41` says as much - the browser client never
sets an rpId at all and falls back to its page origin, while a library driving
CTAP2 directly has to state one.

The bench key is a developer build, so it has trusted every origin all along.

## Why nobody saw it

The matrix forced `OKEMU_DEBUG=1` on every pinned release, because a
production build cannot be given a first PIN - the bracket is a conversation
in `Serial.println`. That was recorded as a provisioning requirement and never
examined for what else it changed. It changed this: **thirteen green passes
were the origin check being skipped, not the tunnel working.**

The user put it plainly when the production default was proposed: the debug
build enables a channel the product does not have, and testing through it is
cheating. This is the sharpest instance of that in the repository.

## Fixed: the test now refuses itself by name

A new capability, `vendorOrigin`, alongside the two boundaries corrected in
the same session. True for the development line - a `-test` build at 3.0.4 or
later, which is where `onlyagent.app` was staged - and false for every
release. `ctapFlow`'s tunnel test and every test in `derive` skip on it rather
than failing, and say which origin the firmware would have accepted.

That is a real coverage gap on releases, and it should be read as one: the
matrix now reports that it cannot exercise the derive path on any shipped
firmware, rather than reporting a pass it did not earn.

Nothing is assumed forward. A future release that ships a5b731f will need this
raised, deliberately, once there is one to measure - the same rule that the
`postQuantum` and `touchFreeDerive` guesses broke by assuming the next release
would fix things.

## NOT fixed, and it is a design decision rather than a defect

The library could send `apps.crp.to` on a release and the tunnel would work.
It is deliberately not doing that, and `tunnel.js:67` already says why:

> The rpId is not a free choice. okcrypto.cpp stages "onlyagent.app" where
> okcrypto_hkdf() reads it, so everything derived through this path is bound
> to that origin - asking with a different one derives DIFFERENT KEYS, with
> no error at any layer. It surfaces much later as "no identity matched any
> of the recipients" against a file that is perfectly intact.

Switching origins per firmware version would make the tunnel answer and
silently change every key derived through it. A blob sealed on a release and
opened on the development line, or the reverse, would fail as corruption. That
trade is the user's to make, not this file's.

The open question, recorded rather than decided: **should the library speak
`apps.crp.to` to a firmware that does not know `onlyagent.app`, accepting that
the two produce different keys, or should the vendor path simply be
unavailable on released firmware until one ships that accepts the origin?**

It is a bigger question than it looked when this only concerned the tunnel.
Unavailable means no derived passwords, no vault and no age identities against
any OnlyKey a user owns today. Speaking `apps.crp.to` means every key derived
through a release differs from the same label derived through the development
line, silently, with the failure appearing much later as a file that will not
open.

## Measured

`node tools/matrix.js v3.0.4 v3.0.2` with the production default: v3.0.4
bailed after `ctapFlow` on all three runs with the error above. The same test
shows `✓` thirteen times across `sweep.txt`, every one a debug build. The
source quotes are from `git show 5d7ce7a:fido2/device.cpp` and
`git show 5d7ce7a:fido2/ok_extension.cpp`, which is v3.0.2 as released.
