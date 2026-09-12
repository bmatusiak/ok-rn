# The vendor tunnel has never worked on a released firmware

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

A new capability, `vendorTunnel`, alongside the two boundaries corrected in
the same session. True for the development line - a `-test` build at 3.0.4 or
later, which is where `onlyagent.app` was staged - and false for every
release. `ctapFlow` skips on it rather than failing, and says which origin the
firmware would have accepted.

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
the two produce different keys, or should the vendor tunnel simply be
unavailable on released firmware until one ships that accepts the origin?**

## Measured

`node tools/matrix.js v3.0.4 v3.0.2` with the production default: v3.0.4
bailed after `ctapFlow` on all three runs with the error above. The same test
shows `✓` thirteen times across `sweep.txt`, every one a debug build. The
source quotes are from `git show 5d7ce7a:fido2/device.cpp` and
`git show 5d7ce7a:fido2/ok_extension.cpp`, which is v3.0.2 as released.
