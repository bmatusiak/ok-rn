# The library sent an origin no released firmware treats as first-party

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
    if ((appid_match1 == 0 || appid_match2 == 0)
        && !(is_bit_set(derived_key_challenge_mode, 1))) {
        return 2;
    } else if (buffer[0]==0xFF && buffer[1]==0xFF && buffer[2]==0xFF
               && buffer[3]==0xFF && buffer[4]==OKCONNECT
               && is_bit_set(derived_key_challenge_mode, 2)) {
        return 1;
    }
    else return 0;
```

**Quote the whole function, because the first version of this finding stopped
at the first branch and drew the wrong conclusion from it.** There are three
answers, not two:

| | when | what it gets |
|---|---|---|
| `2` | the rpId matches `stored_apprpid`, or the appid hash matches a stored one | the full extension, with no device setting required |
| `1` | ANY other origin, for the `0xFFFFFFFF` OKCONNECT bootstrap alone, when bit 2 of `derived_key_challenge_mode` is set | third-party derived keys |
| `0` | otherwise | nothing at all |

The `1` branch is THIRD-PARTY MODE and it is a feature, not a leak. A site
sends its own hostname as the rpId, `okcrypto_hkdf()` folds that origin into
the derivation, and the site gets keys from the user's slot that no other site
can ask for. `derived_key_challenge_mode` is written by setting 21, accepted
only in config mode or on first use: bit 1 turns OFF the first-party fast path,
bit 2 enables this bootstrap, bit 3 allows per-site derives without a touch.

It is present in every release from v2.1.0 onward. Only v0.2-beta.8 lacks it,
with a one-argument `webcryptcheck` that returns 1 or 0 and has no modes.

**For why `_appid` is NULL on the whole CTAP2 route - and therefore why the
rpid string comparison is the ONLY one that can ever succeed there - see
`FINDING-production-firmware-crashes-in-webcryptcheck.md`.** That finding is
older and more complete on the mechanism: it establishes the null, the three
call sites that pass it, and the crash that guarding it revealed. This file
does not restate it.

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
it - derived passwords, the vault, age identities - went unanswered through
this library. That included the app's Crypto tab against a real production key.

The third-party branch would not have rescued it either: it accepts only the
`0xFFFFFFFF` OKCONNECT bootstrap, and only on a device whose owner has set
that EEPROM bit in config mode. The app is not a third-party site. It is the
OnlyKey app, and it should be asking as first-party.

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

## Fixed: the library asks as first-party, which needs no per-version table

The user's instruction was to make it work and to make the origin settable
somewhere, as an array, since they have no control over what the firmware
accepts. That was first built as a per-release `rpIds` column in
`ok-versions.json`, threaded through the staging step and `buildInfo` into the
plugin config.

**It was then removed, because the measurement says there is nothing to
switch.** `stored_apprpid` is byte-identical `apps.crp.to` at every pin -
v0.2-beta.8 (2019), v2.1.0, v2.1.1, v2.1.2, v3.0.0, v3.0.1, v3.0.2, v3.0.3,
v3.0.4 and HEAD. It has never once moved. `onlyagent.app` is an ADDITION at
HEAD only (`libraries@a5b731f`, 2026-07-08), matched by appid hash, and has
never shipped. `localhost` exists solely as the comment
`//Todo add localhost support`. Nine rows carrying the same value are not a
setting, they are the library default written out nine times, and the user
said so: *"i see what you mean by it being redundent in ok-versions.json"* and
*"if we fix it propely.. i wont need the rpids in the ok-version.json"*.

What the fix is, therefore:

- `RP_ID` in `src/protocol/ctap.js` is `apps.crp.to` - the FIRST-PARTY origin,
  the one that answers 2 without depending on any device setting - and
  `RP_IDS` lists both known origins in compatibility order so the newer one
  stays reachable.
- A host overrides it with `plugins.config = { okcrypto: { rpIds: [...] } }`.
  That is the settable lever, and it belongs to the CALLER rather than to a
  firmware pin file: third-party mode is a per-site choice made at runtime, not
  a property of which release was staged.
- `ok-rn` sets nothing. The app is the OnlyKey app and asks as first-party,
  against the soft key and a real key alike.

`vendorOrigin` survives as a capability but is no longer a version threshold:
it asks whether `RP_ID` is first-party to this firmware. That reads true
everywhere today. It is kept because it is the thing that broke - if `RP_ID`
moves again, the suites that need the vendor path skip by name rather than
failing thirty tests later with no indication of why.

## What the old open question asked, and why it dissolved

It asked whether the library should speak `apps.crp.to` to a firmware that
does not know `onlyagent.app`, accepting that the two derive different keys -
or leave the vendor path unavailable on released firmware. The trade looked
severe: unavailable meant no derived passwords, no vault and no age identities
against any OnlyKey a user owns today.

It dissolved twice over.

**First on measurement.** Both origins are first-party to exactly one build,
the development line, and only one of them is first-party to anything a user
owns. There is no timeline to switch on.

**Then on what the mechanism is for.** The question assumed that two origins
deriving two different keys is a defect to be worked around. It is the
product. `okcrypto_hkdf()` folds the origin into the derivation precisely so
that a third-party site gets keys nobody else can ask for, and the firmware
has a whole mode built around that. Asking "which origin should we send" is
asking which keyspace to land in, and for the OnlyKey app the answer is the
first-party one.

What survives is narrower than a design question. **Changing the origin for an
identity that already exists loses it**, with no error at any layer - it
appears much later as a file that will not open. Here that window is anything
derived while the library sent `onlyagent.app` to a debug build. Nothing
shipped in that window and the emulator's flash is disposable, so it costs
nothing, but it is the failure mode this change could still cause and it is
recorded for that reason.

## Still open: should the app offer third-party mode at all

Not decided here, because nothing in the app needs it yet. The door exists -
`plugins.config = { okcrypto: { rpIds: [...] } }` takes any hostname - and it
is deliberately the only door: a per-release table was tried and removed,
because which firmware was staged has nothing to do with which site is asking.
Using it would also need the device configured for it, which is setting 21 in
config mode, and that is a user's decision about their own key rather than a
build option.

## Measured

`node tools/matrix.js v3.0.4 v3.0.2` with the production default: v3.0.4
bailed after `ctapFlow` on all three runs with the error above. The same test
shows `✓` thirteen times across `sweep.txt`, every one a debug build. The
source quotes are from `git show 5d7ce7a:fido2/device.cpp` and
`git show 5d7ce7a:fido2/ok_extension.cpp`, which is v3.0.2 as released.
