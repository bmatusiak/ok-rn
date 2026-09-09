# Production firmware crashes in webcryptcheck on every getAssertion

## What happens

Built with the DEBUG gate off, the firmware takes SIGSEGV on a NULL read the
first time a WebAuthn assertion is requested:

```
F libc : Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0
         in tid 5293 (okemu-firmware)
  #01 webcryptcheck+224
  #02 (inlined)
  #03 ctap_filter_invalid_credentials(CTAP_getAssertion*)+428
  #04 ctap_get_assertion(CborEncoder*, unsigned char*, int)+380
  #05 ctap_request+508
  #06 ctaphid_handle_packet+640
```

The firmware thread dies, so the device stops answering entirely - the e2e
suite does not fail, it hangs, because there is nothing left to time out
against.

## Why

`add_existing_user_info()` calls webcryptcheck with two null pointers
(`libraries/fido2/ctap.cpp:1141`):

```c
if (!webcryptcheck(NULL, NULL)) {
```

and `webcryptcheck` (`libraries/fido2/device.cpp:83`) returns before touching
either of them, but ONLY on a DEBUG build:

```c
    #ifdef DEBUG
    Serial.println("Ctap buffer:");
    byteprint(ctap_buffer, 12);
    ...
    byteprint(_appid, 32);
    return 2;                    // Trust all origins for debug firmware
    #endif

    appid_match1 = memcmp(stored_apprpid, rpid, 12);
    appid_match2 = memcmp(stored_appid, _appid, 32);      // <-- _appid is NULL
    ...
    } else if (buffer[0]==0xFF && buffer[1]==0xFF && ...) // <-- buffer is NULL
```

The `return 2` is inside the `#ifdef`. With DEBUG defined the function never
reaches the comparisons; with it undefined, execution falls straight into
`memcmp(stored_appid, NULL, 32)`.

There are two null dereferences on that path, not one. `buffer[0]` on the next
branch would fault the same way for any caller that got past the first.

## Why nobody has seen it

The early `return 2` means **the production path of this function has never
run** in any build anyone here has exercised. Every test, every manual session
and the whole emulator have used the DEBUG build, and on that build the
function is three prints and a constant.

`byteprint` already carries a null guard for the same call:

```c
// Callers hand this null freely - webcryptcheck() does byteprint(_appid, 32)
// on a path where ctap_filter_invalid_credentials() passed no appid at all.
if (!bytes) return;
```

So the null was known and guarded in the DEBUG print, and not in the code that
uses the pointer for its actual purpose.

## Scope

This is an UPSTREAM FIRMWARE bug, not an emulator artifact. Nothing about
running hosted is involved: the crash is a null dereference in portable C++ on
a path selected by a preprocessor define. Real hardware running a production
build would fault at the same instruction.

The reachable path is `ctap_get_assertion` -> `ctap_filter_invalid_credentials`
-> `add_existing_user_info`, which is the ordinary allowList walk. That is not
an edge case; it is what happens when a site asks the key to sign in.

## Measured, not inferred

- `OKEMU_PRODUCTION=1 node scripts/stage.js` removes `#define DEBUG` and
  `#define DEBUG_CTAP_VERBOSE` from the staged `onlykey.h`.
- The resulting `libokemu.so` contains `UNLOCKEDv3.0.4-prod` and none of the
  DEBUG-only strings (`no longer a terminator`, `OKCONNECT MESSAGE RECEIVED`),
  so the gate really is off.
- Everything before the CTAP assertion passes on that build: boot, OKCONNECT,
  button mapping, PIN unlock, label read, slot write and read-back, CTAPHID
  channel allocation, authenticatorGetInfo.
- The device reports itself as `UNLOCKEDv3.0.4-prodc`, which is the version
  detection working against a production build.
- The crash is at the first getAssertion.

## Not fixed here

A fix has to decide what webcryptcheck should RETURN when it is handed no
appid, and that is a behaviour change to firmware this project treats as
read-only. Returning 0 ("not a trusted webcrypt origin - nothing was supplied
to check") is the honest answer and is what a guard would naturally do, but it
makes the production build take a different branch in `add_existing_user_info`
than the debug build does. That divergence already exists by design - the debug
build trusts all origins - but choosing it is not this project's call to make
silently.

The staging flag is in place, so the moment a decision exists the measurement
can be repeated in one command.
