# key_chain plugin — audit

Soft key and emulators only. Reports every derived **public** key the soft key
answers, so ok-rn can keep it in the phone's Key Chain list (spec session +
Brad, 2026-10-03). Remove the folder and it is gone.

## What it changes

| # | File | Where | Inserted |
|---|---|---|---|
| 1 | okcrypto.cpp | after `#include "onlykey.h"` | the plugin header |
| 2 | okcrypto.cpp | after the OKGETPUBKEY agent derivation v1 (`okcrypto_derive_key(buffer[6], buffer + 7, 0)`) | one call: code 132 |
| 3 | okcrypto.cpp | after the v2 derivation (`... RESERVED_KEY_DERIVATION)`) | one call: code 232 |
| 4 | okcrypto.cpp | after the derived X-Wing recipient (`okcrypto_xwing_derive_getpubkey(buffer + 7, ...)`) | one call: code 128, X-Wing |
| 5 | ok_extension.cpp | after `#include "onlykey.h"` | the plugin header |
| 6 | ok_extension.cpp | after the FIDO derive copies its public key into the reply | one call: code 128, the request's keytype, the rpId hash |
| 7 | ok_extension.cpp | after the FIDO derived X-Wing recipient | one call: code 128, X-Wing, the rpId hash |
| 8 | okcore.cpp | after `#include "onlykey.h"` | the plugin header |
| 9 | okcore.cpp | in `okcore_prime_user_confirmation()`, after `user_input_mode = okcore_user_input_mode_for_slot(slot);` | one call: the press record |
| 10 | ok_extension.cpp | in `web_agent_derive_gate()`, after `device_set_status(CTAPHID_STATUS_UPNEEDED);` | one call: the derive's press record (press or code) |
| 11 | ok_extension.cpp | in `web_agent_derive_gate()`, before `if (but == -2) {` | one call: the derive's wait ended |

Each derive call happens after the public key was computed and before it is
sent; the press record is made as a sign or decrypt starts waiting for its
press, or a slot-128 shared-secret derive starts (and ends) waiting for its
confirmation. None changes anything the firmware sends, stores or decides.

**Soft key only, by design** (Brad, 2026-10-10: "a hardkey is secure, it will
never expose this hook, its a softkey only thing"). The soft key's app is a
display between the requester and the key; the press record lets it present
what the firmware was handed, beside the press button. The requester (the
host) gets nothing from it and has no way to reach the press.

## What leaves the firmware

A 72-byte header plus the public key (`src/okplugin_key_chain.cpp`): version,
transport (`outputmode`), code, keytype, the 32-byte label hash from the
request, the rpId hash (FIDO path), the public key length and bytes. **Never**
`ecc_private_key`, a seed, a shared secret or the label text (the firmware never
has it).

The press record, event `press`, 69 bytes (`okplugin_key_chain_primed`):
version, transport, opcode, slot, a label flag, the SHA-256 of exactly the bytes
handed to the press wait, and on a derived code (201-203, 221-223) the request's
32-byte label hash. Public data only - the request's own bytes, hashed - never
the message itself or any key.

The derive's press record (`okplugin_key_chain_derive_wait`), event `press`,
70 bytes: the same layout with opcode 0xE4 (OKCONNECT), slot 128, the label
flag set, the SHA-256 of the bytes the gate's challenge code is computed from
(the label hash, then the input public key), the label hash, and one more byte:
the confirmation asked (1 a press, 0 the 3-digit code). The code itself is not
sent; the app computes it from the hash as the firmware does. Its end
(`okplugin_key_chain_derive_done`), event `press_end`, 2 bytes: version and the
test's result.

Both go to `okemu_plugin_event()`, declared weak: the soft key's JNI layer
provides it (onPluginEvent → `src/keyChainRecorder.ts` for derives,
`src/pressAsk.ts` → `src/ui/PressSheet.tsx` for presses); a build without a
provider reports nothing.

## Storage

None. `stateless: true`: the soft key's storage slot is not named after this
plugin, so adding or removing it does not move the soft key to an empty slot.
No backup part.

## Not a use

No Edge link, receipt or budget is touched. A firmware derive link (hard keys
too) is a later spec proposal.
