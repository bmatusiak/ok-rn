# edge: what it changes

The firmware half of OnlyKey Edge. The key records each budget use in a hash chain only it
extends, opens budgets only at a physical press, signs checkpoints over its chain, and keeps the
receipts its uses owe. The host library (`node-onlykey-lib/edge`) builds the requests and stores
and verifies the chain. Why it is built this way: `DESIGN.md`. Byte by byte:
[WHITEPAPER.md](WHITEPAPER.md).

**When it is in the build:** staged only when asked (`OKEMU_PLUGINS=edge`). Without it the
firmware is the base build, byte for byte. **Soft key and desktop emulator only:** the flash
region it uses (base + 0x1000) is the bootloader's on a Teensy.

## Hooks into the core

| # | File | Where | What |
|---|---|---|---|
| 1 | okcore.cpp | after `#include "onlykey.h"` | the plugin header |
| 2 | okcore.cpp | before the vendor switch's `default:` | `case OKEDGE: okplugin_edge_recv()` |
| 3 | okcore.cpp | `okcore_prime_user_confirmation()`, after the input mode is set | `okplugin_edge_primed()`: an Edge request always takes a press; a sign or decrypt a budget pays runs with none; one that is not its TX start's request is set to be refused |
| 4 | okcore.cpp | first line of `okcore_run_pending_op()` | `okplugin_edge_refused()`: a refused request ends there (nothing runs, no link, the red fade); else `okplugin_edge_decision(APPROVE)`, which links a budget use before it runs |
| 5 | okcore.cpp | before the 20 s "Timeout occured" message | `okplugin_edge_decision(TIMEOUT)`: drops a waiting Edge press |
| 6 | sketch/OnlyKey.ino | after `#include "onlykey.h"` | the plugin header |
| 7 | sketch/OnlyKey.ino | the wrong-challenge branch | `okplugin_edge_decision(DENY)`: drops a waiting Edge press |
| 8 | okcore.cpp | first line of `wipeflashdata()` | `okplugin_edge_wipe()` |

An ordinary press - approved, denied or timed out - writes no link.

## The OKEDGE message (0xF8), by sub-op

| Sub-op | Name | Press | Links | Reply |
|---|---|---|---|---|
| 01 | HEAD | - | - | seq, head, oldest held, live ids, held mask, owes (0 or 1), refused TX starts |
| 02 | PICKUP | - | - | the held links, each with its head and reveal |
| 03 | CHECKPOINT | - | - | seq · head, then the signature |
| 04 | PUBKEY | - | - | the Edge public key |
| 05 | PUBKEY_PQ | - | - | an ML-DSA-65 public key: 0 the checkpoint key, 1 the owner key (1,952 bytes) |
| 06 | STATEMENT | - | - | the owner statement: seq · nametag hash, the owner key, the signature |
| 10 | GRANT_CREATE | yes | grant-create | id, uses, G, seq, then a checkpoint |
| 11 | GRANT_LABEL | - | - | stages a derived identity's label for the next GRANT_CREATE |
| 12 | GRANT_REVOKE | - | grant-end (revoked) | status |
| 13 | GRANT_HOLD | - | grant-hold | status |
| 14 | GRANT_RESUME | yes | grant-resume | status |
| 20 | RECEIPT | - | receipt; grant-end (completed) when it pays a budget's last open use | seq · head |
| 21 | SETTLE | yes | grant-end (settled) for each live budget, then a receipt 0x8F | seq · head |
| 22 | TX_START | - | - | status |
| 34 | LOSS | yes | loss | seq · head |
| 7E | WIPE_DEBUG | - | - | status - DEBUG builds only |

0x15 is not handled (unknown sub-op). Text replies are `EDGE:xx`: `00` ok, `01` no PIN, `02` bad
scopes, `03` scope not allowed, `04` too many uses, `05` 4 budgets live, `06` sign failed, `07` no
such budget, `08` no receipt waiting, `09` not held, `0A` unknown request, `0B` stale head, `0C`
receipt owed, `0D` nothing to pay, `12` bad range, `1C` not the request its TX start was for.

## What it keeps

- **Flash:** one 208-byte record (`OKEDGEv1`), written to its two sectors in turn (base + 0x1000 and
  base + 0x1800): generation, seq, head, the owed use (seq + head) and whether it is owed, the
  latest link, the device salt and a pending continue. A record of another format, or with a bad
  check, is not read. Only the Edge region is ever written.
- **Backup:** a plugin section, version 1: seq, head, the owed uses, the device id - 55 to 199
  bytes. Never the salt.
- **RAM:** 4 live budgets (scopes, uses, seed, genesis, lifetime), the last 8 links for pickup,
  the TX start token and intent, the waiting press, staged labels, the refused-TX count. A lock or
  reboot clears it: every budget ends.

## Keys

- **The Edge key:** `HKDF(0x28 ‖ device salt, K132, "onlykey/edge/v1")`, P-256. Signs checkpoints
  only. The salt is drawn on first use and never leaves the device; a restore draws a new one.
- **The owner key:** `HKDF(K132, "onlykey/edge/owner/v1")`, no salt - the same on every device made
  from the same OnlyKey. Signs only the owner statement.
- **Their ML-DSA-65 twins:** seeds `HKDF(0x28 ‖ device salt, K132, "onlykey/edge/mldsa/v1")` and
  `HKDF(K132, "onlykey/edge/owner-mldsa/v1")`; key pairs from the firmware's mldsa-native build,
  regenerated for each signature. Each signs the same digest as its P-256 key; a host requires both.
- No other key is read or derived; nothing private is ever sent.

## What it never does

- Pays for anything but OKSIGN on slots 1-4, 101-116, 201-203, 221-223 and OKDECRYPT on 1-4,
  101-116: never FIDO2, config, backup, keys or PINs.
- Opens or resumes a budget, settles or accepts a loss without a physical press.
- Runs a use whose request is not the one its TX start announced: refused, no press, no link.
- Starts a use, opens a budget or resumes one while a receipt is owed.
- Clears a debt except by a receipt for that use or a pressed settle.
- Links an ordinary press or a refusal (refused TX starts are only counted).

## Tests

The plugin kit, `tests/kit.test.js`, on the desktop emulator (`onlykey-testing`, test
`01-protocol/38-softkey-plugins.test.js`; 24 pass, 0 fail, 1 skip on 2026-10-10):
HEAD and the Edge key on a fresh key · the owner statement · an ordinary press writes no link and
a budget use owes its receipt · a budget pays only started uses and a TX start pays only for its
own request (mismatch refused `1C`) · hold and resume · a settle takes a press and a restart keeps
the debt · a settle while a budget is live ends it first · a restore onto the same device
continues the log with a new device id · RSA, ECC and multi-packet signs under a budget · a
composite signature's second half needs an ordinary press · expiry · 1024 uses · LOSS · 0x15
refused · a derived-code budget covers one identity · the checkpoint · the agent service on the
emulator · a backup from another device. `tests/e2e.js` runs on the phone.

## Byte cost on a hard key's CPU

Measured 2026-10-10 with `tools/measure-size.sh` on a Raspberry Pi: the plugin alone, Teensy 1.6.5-r5
toolchain, `-Os -mcpu=cortex-m4 -mthumb`, board `__MK20DX256__` (Teensy 3.2), 3.1.0 libraries.
The SHA-256, uECC, HKDF, RNG, flash and press code it calls is already in the firmware.

| Kind | Bytes | Largest |
|---|---|---|
| Code (`.text`) | 7,716 | `okplugin_edge_recv` 2,340, `okplugin_edge_decision` 1,044, `ensure_identity` 496, `append_scoped` 440, `okplugin_edge_primed` 396 |
| Constants | 325 | tags, the magic, the status digits, the HKDF labels |
| RAM (`.bss`) | 2,761 | held links 1,088, budgets 720, the waiting press 412, the record 196, staged labels 136 |
| Flash | 208, double-buffered | the record above |

What a hard-key port could trim if room is short: the held links 8 → 4 (-544 RAM, a host picks up
more often); the record's latest link (64, only for pickup after a reboot).
