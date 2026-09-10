# A shipped OnlyKey release needs thirteen fixes before it runs hosted

**Severity:** high for the version matrix — without these, v3.0.2 cannot be
unlocked at all, and the reason it gives is "the PIN may be wrong"
**Status:** fixed in the staged copy. Every one is upstream's OWN later fix,
copied to the release that predates it. Nothing was invented here.
**Applies to:** OnlyKey firmware v3.0.2 (`libraries@5d7ce7a`,
`OnlyKey-Firmware@7671d6f`) and, by measurement, every release back to v2.1.0

## What this is

The goal is a version matrix: build each released firmware into its own soft
key and run the suite against all of them, so `node-onlykey-lib`'s version
branches become measurements instead of transcriptions.

v3.0.2 compiled, booted and completed OKCONNECT on the first attempt, which
looked like the job was done. It was not. **It could not be unlocked**, and
every layer above that failed with a message naming the wrong cause.

It now passes **62 of 67** e2e tests, on a device the suite provisions itself.

## The one that cost the most: a 64-bit flash stride

`okcore_flashget_common()` and `okcore_flashset_common()` walk flash through an
`unsigned long *`:

```c
for (int z = 0; z <= len - 4; z = z + 4) { ... adr++; }
```

`unsigned long` is 4 bytes on the MK20DX256 and **8 on arm64**, so the address
advanced twice as fast as the byte buffer beside it. Every other word of every
field was read from, or written to, the wrong place. Nothing faults: the field
offsets are byte arithmetic and stay in range.

The PIN hash goes through those functions. So the device provisioned, reported
itself INITIALIZED, accepted every button press, evaluated the hash — and said
no:

```
GUESSED PROFILE 1 PIN       31 32 33 34 35 36 31
Guessed Hash/PublicKey:     7C 51 67 D6 76 E6 10 65 …
Stored PIN Hash/PublicKey:  D3 6A 49 6A AB 95 D1 9D …
```

**It is invisible on a 32-bit handset**, where the two strides agree by
accident. The bench device that has always worked is a 32-bit Galaxy A13; the
same firmware on an arm64 Pixel cannot be unlocked.

## The one that hid behind a timeout: a dropped reply

`send_transport_response()` calls `RawHID.send2(resp_buffer, 0)` and never
checks the result. A zero timeout means "give up at once if the four-packet TX
queue is full", and it returns 0 without sending — so **the answer is silently
dropped while the request is processed normally.**

On the device that queue drains in microseconds and the window is almost never
open. Hosted it drains only when the host reads, so two vendor requests in a row
lose the second answer, every time:

```
pref: "Successfully set derived key challenge mode"
--- writing slot 101 with type 0x41 ---
said: []
```

The key really was written. Thirteen suites failed downstream of that one lost
reply, all reporting "no CTAPHID reply", none naming the cause.

This is the only patch here that changes what a host observes, and it is
restoring the behaviour real hardware shows rather than changing it.

## The rest

| what | where | why it survives on the device |
|---|---|---|
| `HW_MODEL()` returns a pointer to a stack VLA | `okcore.cpp` | bare metal, one thread, no frame reuse before `hidprint` copies it |
| `byteprint(NULL, 32)` from `webcryptcheck()` | `okcore.cpp` | address 0 is the vector table, and readable |
| four `okeeprom_eeset_*(0)` calls passing a null POINTER | `okcore.cpp`, `OnlyKey.ino` | the same: byte 0 of the vector table is 0x00, so it stores the zero the author meant |
| two more of those in `wipe_slot()` | `okcore.cpp` | as above; two bytes, not one |
| `ctap_flash()` mode 2 falls off the end of a non-void function | `okcore.cpp` | GCC 4.8 returns whatever is in r0; a modern compiler emits no `ret` at all and **hangs every FIDO2 registration** |
| the same in `ctap_atomic_count()` and `send_stored_response()` | `device.cpp`, `ok_extension.cpp` | paths not yet hit |
| the FULLWIPE debug dump starts at address 0 | `okcore.cpp` | page zero is mapped on the device; unmapped here on purpose |
| `Profile_Offset` declared `int` and `uint8_t` in one file | `password.cpp` | the 2015 toolchain accepted the disagreement |

## Why nobody saw them

Every one is either accidentally correct on the MK20DX256 or gated behind
`#ifdef DEBUG`, which a release build does not compile. A shipped release
therefore never executes most of this code, and the developer builds that do
run on hardware where the accidents hold.

They surface here because a hosted build is 64-bit, has page zero unmapped, and
is compiled with DEBUG **on** — which the matrix requires, since a production
build cannot be given a PIN at all
(FINDING-provisioning-needs-a-debug-build.md).

## How they were found

Not by reading the diff. v3.0.2 to the working tree is 25,000 lines, nearly all
of it post-quantum feature work that must not be back-ported. Three narrow
passes did the work:

1. **grep the working tree for `OK_EMULATOR`** — only two gates exist.
2. **scan the STAGED tree for the defect shape**, not the instance: every
   `*_eeset_*` call whose first argument is a numeric literal. That found three
   sites reading the diff had missed.
3. **`git log` on `node-onlykey-emulator/emulator/scripts/stage.js`.** Commit
   `77d0b64` moved that project's patches upstream behind `OK_EMULATOR`, so the
   commit before it holds the complete original list — including the missing
   returns and the `HW_MODEL` VLA, which neither of the first two passes would
   have found.

Then `scripts/version-probe.js` said which releases carry each pattern, and
caught that v2.1.0 has neither the `wipe_slot` pair nor the hmac one before
either was ever built.

## What it genuinely cannot do, and how the library now says so

**v3.0.2 passes 67 of 67.** Two things it cannot do are not defects in the
release, and neither is patched here - a real v3.0.2 key behaves this way, and
an emulator that hid it would be worse than useless.

### The touch-free derive: a check added in this release, reading a stale cache

The split is exactly one release wide:

| firmware | touch-free derive |
|---|---|
| v2.1.0 - v3.0.1 | **no gate at all.** `ok_extension.cpp` sets `additional_data[0]` for the REQ_PRESS variants and carries straight on |
| v3.0.2 | the check was **added**, against `derived_key_challenge_mode` - a RAM cache of an EEPROM byte that the raw-HID pipeline zeroes on every `done_process_packets()`. By the time the FIDO2 path reads it, it is always zero |
| after v3.0.2 | the same check, reloading the byte from EEPROM first, so the preference works |

So v3.0.2 refuses a setting it is holding. The device answers
"Successfully set derived key challenge mode" and then rejects every touch-free
derive with `CTAP2_ERR_EXTENSION_NOT_SUPPORTED`, which reads as "this firmware
does not have the feature". It has it. Nothing reloaded it.

`capabilities().touchFreeDerive` now reports `always`, `broken` or
`preference`, and the vault names the firmware rather than telling somebody to
enable a setting that cannot take effect.

### X-Wing: a feature that arrived later

`KEYTYPE_XWING` appears nowhere in `libraries@5d7ce7a`. An older device does not
refuse the request - it has no branch for the type, so `pubsize` is never set
and it answers with a **perfectly well-formed status line and whatever was in
the key area**. Measured: the derive returned successfully and the caller got 64
bytes that are not a key.

So `capabilities().xwingDerive` is checked before the request is sent. A device
that cannot answer is never asked.

## The bug that hid all of it

When the firmware refuses a derive it returns an error code and calls
`wipedata()`, which starts a TIMER rather than clearing anything. A poll landing
in that window gets what is left of the previous response.

Measured on v3.0.2, five attempts at a derive the firmware was refusing
outright: payloads of 76, 84 and 86 bytes, each with a different 65-byte
"public key", each returned to the caller as a real one. The vault sealed blobs
under them. The only symptom anywhere was a complaint about key framing several
layers up, in a function that had done nothing wrong.

The length is not a guard - 76 and 86 both look reasonable, and the value is
stable per label because the stale buffer is. Only the status can tell an answer
from a leftover, so `derive()` now requires one.
