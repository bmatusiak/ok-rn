# A locked device does not say what it is, and the library believed it

## What happened

`10b-thirdPartyOrigin` failed on 2026-09-23 with a status string that was not
a string:

```
apps.crp.to -> status "M\r'fTU$..9þgmª^ÎDÓ æ<\bQsgª\u001du¦í\u001cX\u0019óÞ", key 38b4f60c… (65 bytes)
apps.crp.to -> status "¸øw", key 59f39918… (65 bytes)
✗ -> Error: the first-party key is not stable
```

The same suite had passed an hour earlier inside a full run, against the same
firmware, the same key and the same library. Nothing had changed except HOW IT
WAS RUN: `--only deviceFlow,thirdParty` instead of the whole sweep.

Garbled status and different "key" bytes on every call is the transit v1
signature - v1 framing applied to a v2 frame decrypts to noise. So
`capabilities.transitV2` was FALSE, on a device that had just announced itself
as `UNLOCKEDv3.0.5-testc` two lines above.

## Why

`plugins/session` parses the status string in ONE place - `connect()`:

```js
identity = version.parseStatus(device.status || '');
caps = version.capabilities(identity);
```

and connect() is the first thing any session does. On a LOCKED device the
status is the bare word `INITIALIZED`. There is no version in it, no build and
no model, because a locked key does not tell you what it is.

`capabilities()` then answers from `version: null`, which is not a neutral
answer - it is a specific device, the oldest one:

```
INITIALIZED            version=null   transitV2=false  deriveReqPress=true   xwing=false
UNLOCKEDv3.0.5-testc   version=3.0.5  transitV2=true   deriveReqPress=false  xwing=true
```

And a device must be CONNECTED BEFORE IT CAN BE UNLOCKED. So the first
connect() of every session sees the locked status, by construction, on every
path - the app's login screen included. Nothing ever revised it.

`unlock()` had the answer the whole time. It resolves with the versioned
status, returns it to its caller and emits it as an event:

```js
progress('unlocked', { status: seen });
events.emit('unlocked', { status: seen });
return seen;
```

and then dropped it. Three uses of the right string, none of them the one that
mattered.

## What it cost, and why nobody saw it

Against a 3.0.5 key the library was speaking to a device it believed was
pre-3.0.5:

- **transit v1 framing** over v2 frames - which decrypt to noise, or fail their
  tag and vanish entirely, since `okcrypto_transit_open()` dispatches nothing
  on a bad tag;
- **derive opcodes 3 and 4** (`DERIVE_*_REQ_PRESS`), which 3.0.5 removed and
  deliberately left burned so an old client fails loudly;
- **a 64-byte X-Wing pair** read out of a 1216-byte device-custody answer.

All silent, and all of it presenting as a DEVICE defect rather than a host one.
"The first-party key is not stable" reads as a non-deterministic derivation,
which would be far worse than anything the suite was about.

**A full run HIDES it.** Each suite connects afresh; by the time the derive
suites run the device is already unlocked, so connect() sees a status with a
version in it and computes the right capabilities. The bug is only reachable
when a connection made while locked is then REUSED - which is what running two
suites in isolation does, and what the app itself does.

That is the second time in this file's history that a reader bug wore the
costume of a device defect, and the third overall for this suite.

## The fix

`session.observeStatus(statusText)` re-parses an identity from a status seen
outside connect(), and `unlock()` hands its status to it. It lives on the
session because that is where identity and capabilities are held, and so any
other path that sees a versioned status can do the same.

It only ever ADDS information, and the guard is fussier than it looks:

```js
if (!seen || !seen.version) return false;
```

`parseStatus('UNLOCKED')` - the bare marker unlock() resolves with when the
firmware sent no status line to match - returns version `''`, an EMPTY STRING,
not null. `!seen.version` catches both; `seen.version === null` would have let
the empty string through and replaced a known v3.0.5 with a device carrying no
release at all. The same bug, one call later, introduced by the fix for it.
`test/version.test.js` pins both spellings so that cannot come back.

## How it was found

By building the ENFORCING emulator (`OKEMU_ENFORCE_ORIGINS=1`, ok-rn@fc5f520)
and running `10b-thirdPartyOrigin` on its own to see the origin table refuse a
third-party rpId. The refusal worked on the first try. The failure was the
control derive beside it, and it had nothing to do with origins.

Worth keeping: the thing that caught it was the STABILITY assertion - deriving
the same origin twice and comparing - not the assertion the suite exists for.
