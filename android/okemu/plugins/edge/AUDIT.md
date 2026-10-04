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
| `01 HEAD` | `seq` u32 (0xFFFFFFFF = none) · `head` 32 · oldest pickable seq u32 · live budget ids 4×u32 · held mask (bit i = budget i on hold) · owed count · overflow · restoring (R26) |
| `02 PICKUP` `from`, `count` ≤ 8 | per link: the link; then its head + the self-press reveal (zeros if none) |
| `03 CHECKPOINT` (`EDGE:0E` while restoring: nothing is signed then, R26) | `seq` · `head`; then the Edge key's P-256 signature over `SHA256("OKEDGE-CKPT-v1" ‖ device_id ‖ seq ‖ head)` |
| `04 PUBKEY` | the Edge public key X‖Y; edge JS derives device_id from it |
| `05 VOUCH` | `seq` · `head` · the vouch tag = HMAC-SHA256(K_vouch, "OKEDGE-VOUCH-v1" ‖ seq ‖ head)[0..16], K_vouch = HKDF(K132, "onlykey/edge/vouch/v1"). No press. `EDGE:0E` while restoring (R26) |
| `10 GRANT_CREATE` [6] scope count · [7..22] scopes · [23..54] reason_hash · [55] flags · [56..57] lifetime (u16 LE minutes, 0 = 12 h, R15b) · [58..63] the first 6 bytes of the head the host verified | `EDGE:0E` while restoring, `EDGE:0C` while a ticket is owed (R10, R18, R26), `EDGE:0B` unless the head matches - checked again at the press (R27); else after a **press**: id · uses · `G` · the link's seq; then a CHECKPOINT over the grant-create link, whose subject commits to `G` |
| `12 GRANT_REVOKE` id | `EDGE:00` (a `grant-end` link) or `EDGE:07` |
| `13 GRANT_HOLD` id | `EDGE:00` (a `grant-hold` link; none if already held) or `EDGE:07`. No press: it only makes the key stricter (R15a) |
| `14 GRANT_RESUME` id · the verified head (32) | `EDGE:0E` / `EDGE:0C` / `EDGE:0B` as for GRANT_CREATE; else after a **press**, `EDGE:00` (a pressed `grant-resume` link) |
| `20 TICKET` ref_seq · code · msg_hash | `seq` · `head` · vouch tag after the ticket link, or `EDGE:08` (that use owes nothing). Any owed use, not only the latest (R16) |
| `21 WAIVE` | `EDGE:08` when nothing is owed; else after a **press**, `seq` · `head` · vouch tag after the waive link: a ticket `0x8F` with the press flag, grant id = the oldest waived, subject = `SHA256("OKEDGE-WAIVE-v1" ‖ the waived seqs ‖ overflow)` (R18) |
| `22 ARM` token = SHA256("OKEDGE-ARM-v1" ‖ head ‖ subject) (R13a) | `EDGE:00` arms ONE self-press for the ONE request whose subject (SHA-256 of exactly the bytes primed) and head make the same token; any other request uses the arm up and is pressed. `EDGE:0E` restoring, `EDGE:0B` not the current head, `EDGE:0C` a ticket is owed, `EDGE:0D` no live budget off hold with uses left (R13a). Any link clears it |
| `23 REPLAY` the link's first 47 bytes (R3: through byte 46, the scope) · the first 8 bytes of the head the copy stored after it | only while restoring (R26): `EDGE:00` when it is the next seq and welds to that head - a TENTATIVE head and debts move on, in RAM only (the record keeps the backup's state); `EDGE:0F` otherwise (where the copy forks); `EDGE:10` once the key wrote a link of its own, or when not restoring |
| `15 AGENT_ADD` agent key 32 | mcp-service.md 4.7a / firmware.md R15c: after a **press**, an `agent-add` link - op 15, decision approve, slot 0, the press flag, grant id 0, subject = SHA-256("OKEDGE-AGENT-v1" ‖ key) - and `seq` · `head` · tag. The key keeps no list of agents: the app does, and counts an agent only with this link in its verified copy. `EDGE:0E` while restoring; no press, no link |
| `34 LOSS` from u32 · to u32 | R24, ahead of E5 (the tab's red banner): after a **press**, a `loss` link - decision approve, slot 0, the press flag, grant id = from, subject = to (u32 LE) then the first 28 bytes of SHA-256(link to+1) when the key holds it (its latest, or the ring), else zeros - and `seq` · `head` · tag. It records the person's acceptance and pays no debt. `EDGE:0E` while restoring, `EDGE:12` (CHOSEN) when from > to or to is past the head |
| `24 REPLAY_DONE` seq u32 · vouch tag 16 · newest seq u32 (CHOSEN) | after a **press**: commits the tentative replay ONLY if the tag is the key's own for exactly the tentative (seq, head) (constant-time compare); otherwise throws it away and answers `EDGE:11`. Then, if anything past what is committed is lost (an unvouched replay: everything since the backup; or the copies held more), a pressed `loss` link: grant id = the first seq lost, subject = the newest (u32), then the same 28-byte hash of the next link when held (never, here: it is past the committed head), else zeros. Ends restoring. Reply `seq` · `head` · tag, or `EDGE:11` |

## What it stores
| Where | What |
|---|---|
| flash `base+0x1000`, `+0x1800` | one record, double-buffered (268 bytes, magic `OKEDGE07`; an `OKEDGE06` record is still read): magic, generation, `seq`, `head`, the owed count, `overflow`, restoring, replay closed, up to 4 owed uses (`seq`, `head[seq]`), the latest link, the last replayed seq, a 4-byte SHA-256 check |
| the device backup | the plugin section (`0xFB`, written last by the loader), version 2: `seq`, `head`, the owed count, `overflow` and the owed uses - 39 to 183 bytes. Debts travel with the backup: only a ticket or a waive pays them (R16). Version 1 (37 bytes, no debts) still restores. A restore takes them back and leaves the key **restoring** (R26): nothing automatic until the host has replayed its copy and the person pressed REPLAY_DONE, which writes the LOSS over what could not be replayed. Older firmware stops at `0xFB` with everything else restored - measured: v3.0.4 and base 3.1.0 (node-onlykey-emulator `test/restore-plugin-backup.js`) |
| RAM | the Edge public key and device_id; live budgets (seed, counters, scopes, on hold; ≤ 4, each ≤ 1024 uses - up to 1,024 SHA-256 runs at the press and per reveal); the arm (one self-press); the last 8 links with heads and reveals |

**The Edge key and K132:**
- The Edge key is derived from **K132** (the key's own derivation secret): HKDF, info `"onlykey/edge/v1"`.
- The firmware's ECC globals are saved before and restored after.
- The derived private key is wiped after each use and **never stored**.
- No generic sign request can reach it: it signs only checkpoints the key builds itself.

## What it does not do
- **It never lets a budget pay for** FIDO2, config mode, backup/restore, wipe, key loading, PIN changes, or the hardened derive / shared secret. Only OKSIGN on slots 1–4, 101–116 and agent codes 201–203 / 221–223, and OKDECRYPT on slots 1–4, 101–116 (R14).
- **It never opens or resumes a budget, or waives a debt, without a physical press.**
- **It never self-presses** without an ARM whose token matches this head and this request, under a held or expired budget, or while any ticket is owed (R13a, R15a, R15b, R18). A sign that skips ARM is pressed, and so is one that another program slips in after an ARM.
- **It never commits replayed history it cannot prove it wrote** (R26): a replay is tentative until the key's own vouch tag for that head is shown, and nothing is vouched or signed while restoring - so invented tickets or a "pressed" waive nobody pressed are thrown away.
- **Nothing but a ticket or a pressed WAIVE pays a debt** - not a deny, timeout, revoke, lock, reboot or restore (R16).
- **It never lets a budget on a derived code cover another identity** (R11a, 2026-10-02). The agent sign codes 201–203 / 221–223 are shared by every derived identity; a scope on them carries the first 16 bytes of ONE identity's 32-byte label, staged by `11 GRANT_LABEL {scope index, label}` (no press) and consumed by the next `GRANT_CREATE` (25 s, then cleared). A derived-code scope without a staged label is refused (`EDGE:03`). The grant subject ends with the full labels. A self-press and R16 coverage need op, slot and label to match - the request's label is its last 32 bytes (message ‖ identity). So a budget for the agent's identity never pays for, or makes owe, Brad's own logins on the same code. Stored slots are unchanged: there the slot is the key.
- **A budget-paid link names the scope that paid** (R3, 2026-10-03): byte 46, 1-based (`append_scoped`); 0 on every other link. Bytes 47-63 stay zero.
- **It never makes a direct press owe when no budget covers it** (R16, changed 2026-10-02). Which approved uses owe is decided by the key at decision time, from ARM and slot: an arm was waiting when the request was primed → owes, whatever slot, whether its token matched or not; no arm, but a live budget's scope covers this op and slot → owes; neither → owes nothing (the person pressed and saw it). A slot is covered from its budget's opening until the budget ends (revoke, expiry, lock/reboot), on hold or not, used up or not - hold stops paying, not owing. The key writes the answer into the link's flags, bit 4 `owes_ticket` (0x10) and bit 5 `armed` (0x20), and weld_in, REPLAY and the library's `keyDebts` read the debt from bit 4 - none of them could replay "was it ARMed" or "had the budget expired" afterwards.
- **It never writes** the 11 data sectors (0x3A800+) or the firmware hash range (0x6060–0x3A05F).
- **In config mode** `OKEDGE` is dropped like any message not on its allow-list. No self-press happens there either.

## Tests (side-loaded, they leave with the folder)
`tests/e2e.js` (ok-rn e2e, the Pixel soft key), through the app's own library stack (`app.edge`):
- `probe` and the genesis;
- a pressed sign is linked, with SHA-256 of what was submitted;
- a budget opened by the soft key's own press verifies with `grants.verifyBudgetOpening`;
- two ARMed self-presses, each ticketed, with their reveals checked against `G`; then nothing to arm;
- a pressed use on an uncovered slot owes nothing (bits 4 and 5 clear); under a held budget for that slot it owes (bit 4 set, bit 5 clear), and its ticket answers with the head;
- hold: nothing to arm; a pressed resume; then it arms again;
- revoke.

`tests/kit.test.js` (the emulator), 11 tests, each checked with the library or `node:crypto` (firmware.md verification row 5):
- `HEAD` and the Edge key;
- a direct press on an uncovered slot owes nothing and the library says "no ticket owed" (R16); under a held budget for that slot a pressed sign owes (bit 4 set, bit 5 clear); a timeout does not clear it; a late ticket pays it; a second is refused; R17's empty hook;
- a budget is signed through the chain; a sign without ARM is pressed; ARM -> use -> ticket -> ARM -> use -> ticket; ARM and GRANT_CREATE refused while owed; a stale head refused; nothing to arm when used up; R16's bits: a use primed while an arm waited carries bits 4 and 5 whether its token matched or not (the stale and the slipped-in request), an unarmed use on the covered slot bit 4 only, a self-press both;
- hold: nothing arms; a pressed use on the held budget's slot owes (bit 4 set, bit 5 clear); resume refused while owed, then taken with a press; the hold and resume links;
- five pressed uses on a covered slot: 4 owed + overflow; a restart keeps them; an unpressed WAIVE does nothing; a pressed one clears all, and the library reads "waived" / "waived, not listed";
- a hold/resume or GRANT_CREATE on a head the host did not verify is refused (R27);
- AGENT_ADD takes a press and links the agent key (op 15, the press flag, grant id 0, the lib's agentSubject); unpressed, nothing is linked (4.7a);
- a standalone LOSS takes a press and links the spec layout; a backwards range or one past the head is refused (`EDGE:12`); it is refused while restoring (R24);
- **the subject proof (R13a):** per op type - RSA sign (slot 2), ECC sign (slot 101), RSA decrypt (slot 1, five packets), a three-packet agent sign - a self-press goes through on a token the LIBRARY computed (`grants.requestSubject`), and the link's subject, which the firmware writes from `pend.subject`, equals the library's. An ARM for one request does not pay for another: that one is pressed, the arm is spent, and the agent's own request is pressed too; a stale head shows at the sign;
- a budget with a 1-minute lifetime: its opening link carries the lifetime; after it, HEAD drops it and nothing arms (R15b);
- a backup keeps the head and the debts; three restores from it (R26, row 5b): **invented links** - a made-up ticket paying the backup's debt and a made-up "pressed" waive - replay only tentatively (HEAD does not move), VOUCH, CHECKPOINT and ARM are refused while restoring, a human press writes onto the backup's head and closes replay, and a forged tag commits nothing (`EDGE:11`, LOSS since the backup, the debt still owed); **a power cut** mid-replay leaves the backup's state and restoring; **an older real vouch** commits only up to its own point, the LOSS names the rest; **the whole copy** with the newest vouch commits it all, heads and debts back, no LOSS;
- a checkpoint verifies, but only over its own head.

Not built yet: R19 (a composite pair under one ARM and one ticket - the spec asks the plan to confirm the call pattern first). **Waits (spec session, 2026-10-03):** the agent's commit key is its own derived key (D2), and derivation is classic only, so no composite key is in the daily loop. Today's behaviour is pinned by the kit test "a composite signature under a budget today": half 1 ARMed + paid + owes its ticket; half 2's ARM refused `EDGE:0C`, needs a physical press. Until then a composite sign under a budget takes a press for its second half.

## Byte costs (firmware.md §3.1: the running total for a hard-key port)

**Measured 2026-10-02** by compiling this plugin alone for the hard key's CPU: the Teensy 1.6.5-r5 toolchain (`arm-none-eabi-g++`, `-Os -mcpu=cortex-m4 -mthumb`, the firmware's flags), on the Pi, against the 3.1.0 libraries. This counts the plugin's own code. The 7 hooks add a few call sites in the core, and the SHA-256, uECC, HKDF, RNG, flash and press code it calls is already in the firmware.

| Kind | Bytes | What |
|---|---|---|
| **Code** (`.text`) | **6,710** | the whole plugin. Largest: the request handlers (`okplugin_edge_recv`, 1,708, with most handlers inlined), the press dispatcher (`okplugin_edge_decision`, 920, with the four press handlers inlined), the weld (`weld_in`, 396), the record (`state_decode` 300, `state_save` 260, `state_load` 152), restore 272, backup 168 |
| **Constants** (`.rodata`) | 265 | tags, magics, the status hex digits |
| **RAM** (`.bss`) | **2,397** | the 8 held links for PICKUP 1,088 (8 × 136), 4 live budgets 432 (4 × 108), the record's copy 256, the tentative replay 256 (R26), the press-gated request 208, the arm token 32, the Edge public key and device id 81, the pending decision 37, the arm 1 |
| **Flash** (the record) | 268, written double-buffered | see below |

**The board (firmware.md §3.1 check, 2026-10-02):** the same numbers with the production hard key's define, `__MK20DX256__` (Teensy 3.2, the default in `tools/measure-size.sh` now), as with `__MK66FX1M0__`: both are Cortex-M4, and the plugin calls the firmware rather than touching the board. Still to measure: the production STD sketch with and without the plugin linked in (needs a hard-key build with the plugin, which the builder does not do yet).

**By rule, as each landed** (code / RAM, measured the same way):
- R13a ARM token + R15b expiry + the R27 GRANT_CREATE layout (2026-10-02): **+232 code, +14 constants, +72 RAM** (the token 32, an expiry clock per budget 4 × 8, the lifetime in the press request 8). No flash: expiry is RAM-only, like the budgets it belongs to.
- R26 vouch + tentative replay (2026-10-02): **+572 code, +38 constants, +261 RAM** - the tentative state is a full copy of the record (256), above the spec's ~150 estimate; keeping only seq, head and the debt list (~185) would trim it. No flash: the tentative replay is RAM, by design (a power cut leaves the backup's state).

**The record, by rule** (268 bytes):
- the chain (R2-R5): magic 8, generation 4, seq 4, head 32, the latest link 64, check 4 = **116**;
- the debts (R16-R18): count 1, overflow 1, 4 owed × (seq 4 + head 32) = **146**;
- restore and replay (R26): restoring 1, replay closed 1, the last replayed seq 4 = **6**.

**What a port could trim, if room is short** (not done; each is a trade):
- held links 8 → 4 halves the largest RAM item (-544), at the cost of a host picking up more often;
- the record's last link (64) is only there so PICKUP still works after a reboot;
- the soft key gives each of the record's two copies its own 2 KB sector; a hard key needs only 2 × 268 bytes of power-safe storage, which phase 0 must find (no free sector today).
