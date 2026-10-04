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

Each call happens after the public key was computed and before it is sent; it
changes nothing the firmware sends, stores or decides.

## What leaves the firmware

A 72-byte header plus the public key (`src/okplugin_key_chain.cpp`): version,
transport (`outputmode`), code, keytype, the 32-byte label hash from the
request, the rpId hash (FIDO path), the public key length and bytes. **Never**
`ecc_private_key`, a seed, a shared secret or the label text (the firmware never
has it).

It goes to `okemu_plugin_event()`, declared weak: the soft key's JNI layer
provides it (onPluginEvent → `src/keyChainRecorder.ts`); a build without a
provider reports nothing.

## Storage

None. `stateless: true`: the soft key's storage slot is not named after this
plugin, so adding or removing it does not move the soft key to an empty slot.
No backup part.

## Not a use

No Edge link, ticket or budget is touched. A firmware derive link (hard keys
too) is a later spec proposal.
