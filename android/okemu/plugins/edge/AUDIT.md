# edge: what it changes

The minimal firmware half of OnlyKey Edge: **the key is a notary** (`DESIGN.md` §0). Edge JS (`node-onlykey-lib/edge`) does the work. The key adds only:
- the weld at each sign/decrypt decision;
- the budget decision and its reveal;
- one signature, the checkpoint;
- the ticket link.

**When it's in the build:**
- **Staged only when asked:** `OKEMU_PLUGINS=edge`. Without it the firmware is the base build, byte for byte.
- **Soft key and desktop emulator only. Never a hard key:** the flash it uses is the bootloader's area on a real device.

## Hooks (each anchor occurs exactly once; 3.1.0 soft key and desktop emulator alike)
1. `okcore.cpp`, after `#include "onlykey.h"`: the plugin header.
2. `okcore.cpp`, before the vendor switch's own `default:`: `case OKEDGE:` → `okplugin_edge_recv()`.
3. `okcore.cpp`, `okcore_prime_user_confirmation()`, after the input-mode lookup: `okplugin_edge_primed()`.
   - **It CAN change the confirmation:**
     - for `OKEDGE` (opening a budget) it forces a **press**;
     - for an OKSIGN/OKDECRYPT a live budget pays for, it sets **no press**, and the firmware's own no-press path runs it.
   - Otherwise it only records what is waiting, and SHA-256 of what was submitted.
4. `okcore.cpp`, first line of `okcore_run_pending_op()`: the APPROVE or SELF-PRESS link, written **before** the operation runs (R4); or, after an `OKEDGE` press, the budget opens.
5. `okcore.cpp`, `fadeoffafter20sec()`, before the timeout message: the TIMEOUT link.
6. `sketch/OnlyKey.ino`, the wrong-challenge branch: the DENY link.
7. `okcore.cpp`, first line of `wipeflashdata()`: erase the plugin's record, and end live budgets.

## New message
`OKEDGE` = `TYPE_INIT | 0x78` (`0xF8`), sub-op in `recv_buffer[5]`.
- **When it answers:** only while initialized, unlocked and not in config mode, on a key with a PIN set (it needs K132).
- **Its text replies** are `EDGE:xx` codes only (`okplugin_edge.h`).

| Sub-op | Reply |
|---|---|
| `01 HEAD` | `seq` u32 (0xFFFFFFFF = none) · `head` 32 · oldest pickable seq u32 · live budget ids 4×u32 · held mask (bit i = budget i on hold) · owed count · overflow |
| `02 PICKUP` `from`, `count` ≤ 8 | per link: the link; then its head + the self-press reveal (zeros if none) |
| `03 CHECKPOINT` | `seq` · `head`; then the Edge key's P-256 signature over `SHA256("OKEDGE-CKPT-v1" ‖ device_id ‖ seq ‖ head)` |
| `04 PUBKEY` | the Edge public key X‖Y; edge JS derives device_id from it |
| `10 GRANT_CREATE` scopes · reason_hash | `EDGE:0C` while a ticket is owed (R10, R18); else after a **press**: id · uses · `G` · the link's seq; then a CHECKPOINT over the grant-create link, whose subject commits to `G` |
| `12 GRANT_REVOKE` id | `EDGE:00` (a `grant-end` link) or `EDGE:07` |
| `13 GRANT_HOLD` id | `EDGE:00` (a `grant-hold` link; none if already held) or `EDGE:07`. No press: it only makes the key stricter (R15a) |
| `14 GRANT_RESUME` id | `EDGE:0C` while a ticket is owed; else after a **press**, `EDGE:00` (a pressed `grant-resume` link) |
| `20 TICKET` ref_seq · code · msg_hash | `seq` · `head` after the ticket link, or `EDGE:08` (that use owes nothing). Any owed use, not only the latest (R16) |
| `21 WAIVE` | `EDGE:08` when nothing is owed; else after a **press**, `seq` · `head` after the waive link: a ticket `0x8F` with the press flag, grant id = the oldest waived, subject = `SHA256("OKEDGE-WAIVE-v1" ‖ the waived seqs ‖ overflow)` (R18) |
| `22 ARM` head | `EDGE:00` arms ONE self-press; `EDGE:0B` not the current head, `EDGE:0C` a ticket is owed, `EDGE:0D` no live budget off hold with uses left (R13a). Any link clears it |

## What it stores
| Where | What |
|---|---|
| flash `base+0x1000`, `+0x1800` | one record, double-buffered (264 bytes, magic `OKEDGE06`): magic, generation, `seq`, `head`, the owed count, `overflow`, the restored flag, up to 4 owed uses (`seq`, `head[seq]`), the latest link, a 4-byte SHA-256 check |
| the device backup | the plugin section (`0xFB`, written last by the loader), version 2: `seq`, `head`, the owed count, `overflow` and the owed uses - 39 to 183 bytes. Debts travel with the backup: only a ticket or a waive pays them (R16). Version 1 (37 bytes, no debts) still restores. A restore takes them back and the next link is a LOSS (R24). Older firmware stops at `0xFB` with everything else restored - measured: v3.0.4 and base 3.1.0 (node-onlykey-emulator `test/restore-plugin-backup.js`) |
| RAM | the Edge public key and device_id; live budgets (seed, counters, scopes, on hold; ≤ 4, each ≤ 255 uses); the arm (one self-press); the last 8 links with heads and reveals |

**The Edge key and K132:**
- The Edge key is derived from **K132** (the key's own derivation secret): HKDF, info `"onlykey/edge/v1"`.
- The firmware's ECC globals are saved before and restored after.
- The derived private key is wiped after each use and **never stored**.
- No generic sign request can reach it: it signs only checkpoints the key builds itself.

## What it does not do
- **It never lets a budget pay for** FIDO2, config mode, backup/restore, wipe, key loading, PIN changes, or the hardened derive / shared secret. Only OKSIGN on slots 1–4, 101–116 and agent codes 201–203 / 221–223, and OKDECRYPT on slots 1–4, 101–116 (R14).
- **It never opens or resumes a budget, or waives a debt, without a physical press.**
- **It never self-presses** without an ARM over the current head, under a held budget, or while any ticket is owed (R13a, R15a, R18). A sign that skips ARM is pressed.
- **Nothing but a ticket or a pressed WAIVE pays a debt** - not a deny, timeout, revoke, lock, reboot or restore (R16).
- **It never writes** the 11 data sectors (0x3A800+) or the firmware hash range (0x6060–0x3A05F).
- **In config mode** `OKEDGE` is dropped like any message not on its allow-list. No self-press happens there either.

## Tests (side-loaded, they leave with the folder)
`tests/e2e.js` (ok-rn e2e, the Pixel soft key), through the app's own library stack (`app.edge`):
- `probe` and the genesis;
- a pressed sign is linked, with SHA-256 of what was submitted;
- a budget opened by the soft key's own press verifies with `grants.verifyBudgetOpening`;
- two ARMed self-presses, each ticketed, with their reveals checked against `G`; then nothing to arm;
- a pressed use owes, and its ticket answers with the head;
- hold: nothing to arm; a pressed resume; then it arms again;
- revoke.

`tests/kit.test.js` (the emulator), 7 tests, each checked with the library or `node:crypto` (firmware.md verification row 5):
- `HEAD` and the Edge key;
- a pressed sign owes a ticket; a timeout does not clear it; a late ticket pays it; a second is refused; R17's empty hook;
- a budget is signed through the chain; a sign without ARM is pressed; ARM -> use -> ticket -> ARM -> use -> ticket; ARM and GRANT_CREATE refused while owed; a stale head refused; nothing to arm when used up;
- hold: nothing arms; resume refused while owed, then taken with a press; the hold and resume links;
- five pressed uses: 4 owed + overflow; a restart keeps them; an unpressed WAIVE does nothing; a pressed one clears all, and the library reads "waived" / "waived, not listed";
- a backup keeps the head and the debts; a restore brings them back and links a LOSS;
- a checkpoint verifies, but only over its own head.

Not built yet: R19 (a composite pair under one ARM and one ticket - the spec asks the plan to confirm the call pattern first). Until then a composite sign under a budget takes a press for its second half.
