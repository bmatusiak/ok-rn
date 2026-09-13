# Production firmware: webcryptcheck crashes, and cannot authorise onlyagent.app

Two findings, one function. The first is a null dereference that kills the
firmware thread. Guarding it reveals the second, which is the more important
one: the origin check the production build is supposed to perform cannot see an
origin on the CTAP2 path at all.

Both were found by staging a DEBUG-off build (`OKEMU_PRODUCTION=1`) and running
the e2e suite against it - the first time that has ever been done.

## 1. The crash

```
F libc : Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0
         in tid 5293 (okemu-firmware)
  #01 webcryptcheck+224
  #03 ctap_filter_invalid_credentials(CTAP_getAssertion*)+428
  #04 ctap_get_assertion(CborEncoder*, unsigned char*, int)+380
  #05 ctap_request+508
  #06 ctaphid_handle_packet+640
```

The firmware thread dies, so the suite does not fail - it HANGS, because there
is nothing left to time out against.

`webcryptcheck` (`libraries/fido2/device.cpp:83`) returns before touching its
arguments, but only on a DEBUG build:

```c
    #ifdef DEBUG
    ...
    byteprint(_appid, 32);
    return 2;                 // Trust all origins for debug firmware
    #endif

    appid_match1 = memcmp(stored_apprpid, rpid, 12);
    appid_match2 = memcmp(stored_appid, _appid, 32);        // _appid is NULL
    int appid_match3 = memcmp(stored_appid_oa, _appid, 32); // NULL again
    ...
    } else if (buffer[0]==0xFF && ...)                      // buffer is NULL
```

The `return 2` is INSIDE the `#ifdef`. With DEBUG defined the function is three
prints and a constant; with it undefined, execution falls into the comparisons.

Three call sites pass nulls:

| Caller | Passes |
|---|---|
| `ctap.cpp:1141` `add_existing_user_info()` | `webcryptcheck(NULL, NULL)` |
| `extensions.cpp:113` `extend_fido2()` | `_appid = NULL` |
| `extensions.cpp:125` `extend_fido2()` | `_appid = NULL` |

`byteprint` already carries a guard for the same pointer, with a comment saying
callers hand it null freely. So the null was known and guarded in the debug
print, and not in the code that uses the pointer for its purpose.

**The production path of this function had never run**, anywhere. That is the
whole reason it survived.

## 2. onlyagent.app cannot be authorised over CTAP2

With the crash guarded, the suite completes and nine derive tests fail
identically:

```
the device answered the derive with no data (status CTAP2_ERR_EXTENSION_NOT_SUPPORTED)
```

That status reads like "this firmware has no such feature". It means the origin
check said no.

`webcryptcheck` has three ways to say yes, and only one of them works without
`_appid`:

| Check | Reads | Available on CTAP2? |
|---|---|---|
| `appid_match1` vs `"apps.crp.to\x02"` | `ctap_buffer+4` | yes |
| `appid_match2` vs `stored_appid` | `_appid` | **no - it is NULL** |
| `appid_match3` vs SHA256("onlyagent.app") | `_appid` | **no - it is NULL** |

`extend_fido2()` - the entire CTAP2 route - passes `NULL` for `_appid` on both
of its branches. So on a production build the only origin a CTAP2 request can
prove is `apps.crp.to`, via the rpid read out of `ctap_buffer`.

**ok-rn pins `onlyagent.app`.** Its SHA-256 is exactly `stored_appid_oa`:

```
sha256("onlyagent.app") = b8aae59c19de592adbf1ca0a15c0031588988b6144faa7c2e1c43034c166d583
stored_appid_oa         = b8aae59c19de592adbf1ca0a15c0031588988b6144faa7c2e1c43034c166d583
```

so the firmware plainly intends to accept it - there is a constant for it and a
comment naming it "OnlyAgent origin". The value simply never arrives at the
comparison. The origin is present in the CTAP2 request; `extend_fido2` does not
thread it through.

This is not caused by the guard. Without the guard the same path crashes;
with it, the same path is refused. Either way `onlyagent.app` cannot derive on
a production build.

## What was staged, and why per-comparison

Decided with the user. `OKEMU_PRODUCTION=1` guards each comparison rather than
returning early:

```c
appid_match1 = memcmp (stored_apprpid, rpid, 12);
appid_match2 = (_appid == NULL) ? 1 : memcmp (stored_appid, _appid, 32);
int appid_match3 = (_appid == NULL) ? 1 : memcmp (stored_appid_oa, _appid, 32);
...
} else if (buffer != NULL && buffer[0]==0xFF && ...)
```

A blanket `if (!_appid || !buffer) return 0;` was written first and is wrong: it
also skips the rpid check, which reads `ctap_buffer` and needs neither pointer.
That is the ONLY check the CTAP2 path can satisfy, so skipping it would refuse
`apps.crp.to` as well - turning one broken origin into two.

A non-zero memcmp result means "no match", which is the honest answer for a
pointer that is not there. Nothing is trusted that was not proven.

Upstream this belongs in `libraries/fido2/device.cpp` unconditionally, and the
real repair is in `extensions.cpp`: pass the appid the CTAP2 request already
carries. Neither is done here - that tree is read-only for this project, and
threading a new argument through is changing what the firmware does, not making
it run.

## Measured

Staged with `OKEMU_PRODUCTION=1`; the built `libokemu.so` contains
`UNLOCKEDv3.0.4-prod` and none of the DEBUG-only strings, so the gate really is
off.

| | debug build | production build |
|---|---|---|
| e2e result | 53 pass, 0 fail | 44 pass, 9 fail |
| reported version | `UNLOCKEDv3.0.4-testc` | `UNLOCKEDv3.0.4-prodc` |
| SEREMU traffic | present | absent |
| PIN unlock | console or buttons | buttons only |
| derive / vault / age | pass | refused, all nine |

Everything else passes on both: boot, OKCONNECT, button mapping, PIN unlock,
label read, slot write and read-back, CTAPHID channel, authenticatorGetInfo,
presence ceremonies, keystroke capture and decode, and composite signing
including the challenge.

The nine failures are one bug, not nine.

## The guard is applied on BOTH builds now, because of one release

This finding, and the patch it produced, both rested on a sentence that turned
out to be true of every release but the oldest:

> On a DEBUG build the function returns 2 - "trust all origins for debug
> firmware" - BEFORE reaching any comparison, so the nulls never matter.

**v0.2-beta.8's `webcryptcheck` takes one argument and its `#ifdef DEBUG`
block is EMPTY.** There is no early return to reach, so it runs the
comparisons on a debug build too, and `extend_fido2()` hands it NULL on the
whole CTAP2 route. Measured from the tombstone:

```
#00 __memcmp_aarch64+16
#01 webcryptcheck+356
#03 ctap_filter_invalid_credentials(CTAP_getAssertion*)
#04 ctap_get_assertion   #05 ctap_request   #06 ctaphid_handle_packet
```

The effect was backwards from what a debug build is for: the beta's PRODUCTION
build survived, because `DEBUG_OFF_PATCHES` guarded it, while its DEBUG build
died in `ctapFlow` - and that release is the one still being diagnosed.

So the `appid_match2` guard moved out of `DEBUG_OFF_PATCHES` into the
always-applied `PATCHES` as `APPID_NULL_GUARD`. Where the early return exists
the guard is unreachable and costs nothing; the literal was already checked to
exist verbatim at every pin. The beta's debug build goes from crashing to 73
passed, and the working tree is unchanged at 107.

An earlier attempt gave the beta its own copy and declared the shared literal
in `absentPatterns`. `stage.js` refused it outright - *"DOES contain a pattern
its release declares absent"* - which is that check doing exactly its job, and
it pushed the fix to where the wrong assumption actually lived.
