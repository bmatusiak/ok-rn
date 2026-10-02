# edge: what it changes (step 1)

OnlyKey Edge on the soft key: every sign/decrypt decision becomes a link in a SHA-256 chain whose head the key keeps. Design and reasons: `DESIGN.md`.

- **Staged only when asked:** `OKEMU_PLUGINS=edge`. Without it the firmware is the base build, byte for byte.
- **Soft key and desktop emulator only. Never a hard key:** its storage is flash the real device uses for its bootloader.

## Hooks (each anchor occurs exactly once; 3.1.0 soft key and desktop emulator alike)
1. `okcore.cpp`, after `#include "onlykey.h"`: the plugin header.
2. `okcore.cpp`, before the vendor switch's own `default:`: `case OKEDGE:` → `okplugin_edge_recv()`.
3. `okcore.cpp`, `okcore_prime_user_confirmation()`, after the input-mode lookup: `okplugin_edge_primed()`. It records which OKSIGN/OKDECRYPT is waiting, and SHA-256 of what was submitted. It changes nothing in step 1.
4. `okcore.cpp`, first line of `okcore_run_pending_op()`: the APPROVE link, written before the operation runs (R4).
5. `okcore.cpp`, `fadeoffafter20sec()`, before the timeout message: the TIMEOUT link.
6. `sketch/OnlyKey.ino`, the wrong-challenge branch: the DENY link.
7. `okcore.cpp`, first line of `wipeflashdata()`: erase the plugin's storage. The next chain starts with a `wipe` link.

## New message
`OKEDGE` = `TYPE_INIT | 0x78` (`0xF8`), sub-op in `recv_buffer[5]`. It is answered only while initialized, unlocked and not in config mode, and only on a key with a PIN set (it needs K132).

| Sub-op | Reply |
|---|---|
| `01 HEAD` | `seq` u32 LE (0xFFFFFFFF = no link yet) · `head` 32 · `ringFrom` u32 · device_id 16 |
| `02 READ` `from` u32, `count` u8 ≤ 8 | per link: the 64-byte link, then a report with its 32-byte head |
| `04 CKPT_PUBKEY` | the Edge public key, X‖Y (64) |

## What it stores
| Where | What |
|---|---|
| flash `base+0x1000`, `+0x1800` | state, double-buffered (160 bytes each): magic, generation, `seq`, `head`, device_id, the Edge public key, flags, a 4-byte SHA-256 check |
| flash `base+0x2000`–`+0x2FFF` | the ring: the last 32 links, each with its head (96 bytes) |

It reads **K132** (the key's own derivation secret) to derive the Edge key, HKDF info `"onlykey/edge/v1"`. The firmware's ECC globals are saved before and restored after, and the derived private key is wiped. The private key is never stored; only its public key and the device_id (16 bytes of `SHA256("OKEDGE-DEVICE-v1" ‖ pubkey)`) are.

## What it does not do (step 1)
- No budgets, no self-press, no tickets, no signatures yet (steps 2–4). It **never** skips or changes a confirmation: hooks 3–6 only record.
- It does not touch the 11 data sectors (0x3A800+) or the firmware hash range (0x6060–0x3A05F).
- Config mode drops `OKEDGE` like any message not on its allow-list.

## Tests (side-loaded, they leave with the folder)
- `tests/kit.test.js` (the emulator): `HEAD` on a fresh key, the device_id from the public key, a pressed sign and a timed-out one become links, and `READ` + the lib's `chain.verify` reach the key's head.
