# edge: the soft-key firmware plugin (design, E3)

The firmware half of OnlyKey Edge, as a plugin: soft key (ok-rn) and the desktop emulator only, never a hard key. The host half is `node-onlykey-lib/edge` (E1); its byte formats (`src/edge/codes.js`, `chain.js`, `grants.js`, `receipts.js`) are the contract, and every byte here must produce the same links, welds and signatures as the lib and its Python vectors.

**Owner's design (2026-10-02):** Edge is a provable blockchain.
- The **device chain** records every decision the key makes.
- Each **budget** is its own `bmatusiak/provable` series. Its genesis is started by a **physical press** and **signed by the key**, and the signature commits to the device chain's head before it, so budgets sit in the chain like blocks.

## 0. Minimal firmware: the key is a notary (owner, 2026-10-02) - this section wins
"The idea is for the smallest minimal firmware addition, because a device can only hold so much logic." So **edge JS (`node-onlykey-lib/edge`) does the work, and the key adds only what a host cannot be trusted with**, the way openpgp.js builds a packet and the key signs it.

**Why the key cannot just sign what edge JS hands it.** The host asking is the agent's own machine, the thing being watched. If the key signed host-built links, a compromised agent could leave a use out, describe it as something else, or keep two histories. So the key **notarises from facts it saw itself**, and holds the one thing that pins history down: the head.

**The firmware keeps (the whole addition):**

| What | Where | Bytes |
|---|---|---|
| `seq`, `head` | flash, double-buffered | 36 |
| whether the latest link is a use still owed a receipt, and whether it was a self-press | flash | 2 |
| the latest link (so a crash never loses it) | flash | 64 |
| live budgets: seed, counters, scopes | **RAM only** (a lock or reboot ends them, R15) | ~70 each, ≤ 4 |
| the last 8 links (+ a self-press's reveal) for pickup | **RAM only** | ~1 KB |

**The firmware does:**
1. **The weld at each sign/decrypt decision**, built from what it did: SHA-256 of the message it was asked to approve, op, slot, the decision (approve, deny, timeout, self-press), and the budget step. One hash, one link.
2. **The budget decision.** Self-press only inside a live budget's scope with room, while unlocked and out of config mode. It reveals `v_i` and `HMAC(v_i, subject)`.
3. **Two signatures with the Edge key (K132 → HKDF), never reachable by a generic sign:**
   - the **budget genesis**, over fields it computes itself, made only at a **physical press**;
   - **checkpoints** over `(seq, head)`.
4. **The debts** (the spec change, onlykey-edge `c7c30dd`; R16 changed again 2026-10-02): an approved use owes a receipt when a TX start was waiting at its prime (any slot, token matched or not), or when a live budget - held or not, used up or not - covers its op and slot. A direct press on an uncovered slot owes nothing. The key decides at decision time and writes it into the link (flags bit 4 `owes_receipt`, bit 5 `started`), because a replay cannot know afterwards whether a TX start waited or a budget had expired; weld_in, REPLAY and the library's `keyDebts` read bit 4. The key keeps the latest 4 owed uses (`seq`, `head[seq]`) and an `overflow` flag in flash, links a RECEIPT for any of them, and while anything is owed there is no self-press, TX start, GRANT_CREATE or GRANT_RESUME (R18). A pressed WAIVE clears them all.
5. **The start** (R13a): a self-press needs `TX start {head}` over the current head first, one per use; any link clears it. A sign that skips TX start is pressed.
6. **Hold** (R15a): a held budget pays for nothing and starts nothing; resuming takes a press.
7. **Restore, then replay** (R26, onlykey-edge `0dda6ac`): a restore leaves the key *restoring* - nothing automatic - until the host has replayed its newest copy (each link only if it is the next seq and welds to the head the copy stored) and the person presses REPLAY_DONE, which writes the LOSS over only what could not be replayed. It replaced the LOSS written straight away at the first unlock after a restore.
8. **No budget from an unverified copy** (R27): GRANT_CREATE and GRANT_RESUME carry the head the host verified its copy up to, checked on arrival and again at the press. The full check is the library's (`copy.verifyCopy`).

**Edge JS does everything else:**
- builds budget requests;
- stores the chain (phone, Worker, MCP);
- verifies, and detects gaps and rollback;
- pairs receipts;
- tracks budget spend from the links themselves;
- holds the copies and assembles the backup entry;
- runs every screen.

If a host never picks a link up, the head still counts it, so the omission shows as a gap: detected, never hidden.

**Wire (replaces §5 from step 3 on):**

| Sub-op | Request | Reply |
|---|---|---|
| `01 HEAD` | – | `seq` u32 · `head` 32 · `oldest` u32 (oldest pickable seq) · live budget ids 4×u32 |
| `02 PICKUP` | `from` u32 · `count` u8 ≤ 8 | per link: the link; then its head, and `v_i` + `mac` when it is a self-press |
| `03 CHECKPOINT` | – | `seq` u32 · `head` 32; then the signature |
| `04 PUBKEY` | – | the Edge public key X‖Y |
| `10 GRANT_CREATE` | scopes · reason_hash · flags | after the press: id u32 · uses u16 · `G` 32 · the link's seq u32; then a `CHECKPOINT` over the grant-create link |
| `12 GRANT_REVOKE` | id u32 | text |
| `20 RECEIPT` | ref_seq u32 · code u8 · msg_hash 32 | text |

**Leaves the firmware** (steps 1–2 built them; step 3 removes them):
- the 3 KB flash ring and `READ`: replaced by `PICKUP` from RAM, plus the latest link in flash;
- `GRANT_LIST`: edge JS reads live budgets and spend from the chain;
- `LAST_REVEAL`: folded into `PICKUP`.

**Safe cuts, applied (owner, 2026-10-02: "lets do the safe cuts"):**
1. **One signature.** `G` is in the grant-create link's subject, `SHA256("OKEDGE-GRANT-v1" ‖ scopes ‖ reason_hash ‖ G)`. Opening a budget answers with a checkpoint over that link, so the genesis is signed through the chain. There is no separate budget-genesis digest.
2. **Live budgets come from `HEAD`** (RAM). No stored ids, and no boot-time `grant-end` links: a lock or reboot ends them, and `HEAD` shows it.
3. **No wipe link.** A wipe makes a new K132, so a new device id and genesis: every host sees a new key.
4. **No device id in `HEAD`.** Edge JS computes `SHA256("OKEDGE-DEVICE-v1" ‖ pubkey)[0..16]`.
5. ~~**A receipt is the very next link after its use**~~ - reversed by the spec change: a human press owes too, and nothing on that path files a receipt at once, so the key stores the owed heads again (R16 says so: "brings back the stored use heads that the soft-key plugin's ... cut removed").

The flash record is now 264 bytes (`OKEDGE06`; it was 120 with the cut).

**Not cut, by choice:**
- the 8 held links (a second host can still pick up);
- the latest link in flash (a crash loses nothing);
- deny/timeout links (evidence);
- the provable series;
- the scope checks (R14).

**Build order from here:**
- **Step 3:** slim to this section, and add `RECEIPT` (R16/R18) and `CHECKPOINT`.
- **Step 4:**
  - the lib's device calls (`edge.head/pickup/checkpoint/pubkey/grant/revoke/receipt`, L4) and `capabilities().edge` (L5);
  - the Edge tab off the fake key;
  - the plugin's e2e test on the Pixel soft key;
  - the kit test on Windows, the VM and the Pi.

Sections 1–7 below record the survey and steps 1–2 as built; where they differ from this section, this section wins.

Facts below were surveyed on the staged 3.1.0 tree (`.stage/libraries/onlykey/okcore.cpp` = "core", `okcrypto.cpp` = "crypto", `sketch/OnlyKey.ino` = "ino"); line numbers are from that survey.

## 1. Identity and the Edge key
- **The device has no per-device id.** The chip UID is the same constant on every soft key and emulator (`ok_hal.cpp:164-167`), and the factory sector is blank.
- **The Edge key:** P-256, derived from the key's own secret: `K132` (`okcore_flashget_ECC(132)`), then HKDF with info `"onlykey/edge/v1"` (`okcrypto_hkdf_info`, crypto:1591). It never comes from the agent path, so the same label can't yield the same key.
- **device_id** = the first 16 bytes of `SHA256("OKEDGE-DEVICE-v1" || edge_pubkey)`.
  - Its genesis therefore changes when the key is wiped (K132 is regenerated at PIN setup), and a wiped key starts a fresh chain, as R9 asks.
  - Readable with `CKPT_PUBKEY`.
- The key signs **checkpoints** (R7) and **budget geneses** (owner) with this key, using raw P-256 over a 32-byte digest (`uECC_sign`, uECC.c:1355). The private key is wiped from RAM after each use.

## 2. Storage
| Where | What | Why |
|---|---|---|
| flash **0x1000–0x57FF** (9 × 2 KB sectors, all 0xFF) | the plugin's own region | nothing reads it; outside `fw_hash` (0x6060–0x3A05F, re-hashed every soft-key boot); outside the 11 data sectors (0x3A800+); the host's factory reset fills it with 0xFF |
| RAM only | live budgets' **seeds** | a lock or reboot is `CPU_RESTART` = a new process (ok-rn and the emulator), so the seeds die with the budget, as R15 requires |

Region layout (sectors from 0x1000):
- **0x1000, 0x1800: state, double-buffered.** Each sector holds a record: magic `OKEDGE01`, generation, `seq`, `head`, device_id, and the ids of budgets live at the last write. The newer valid record wins, and a write goes to the other sector. A crash mid-write therefore leaves the previous state. R4: `(seq, head)` is persisted **before** a result is released.
- **0x2000–0x37FF: the ring.** 32 slots × 96 bytes (link + head), with slot = `seq % 32`, written read-modify-write per sector (`okcore_flashsector`, core:2931).
- **Unused (reserve):** 0x3800–0x57FF.

**The desktop emulator on Linux** maps flash from 0, else from 0x1000, else from 0x10000 (`DE ok_hal.cpp:294-340`).
- From 0x1000 (what `scripts/setup-permissions.sh` sets up), this range is mapped.
- From 0x10000 it is not. But the key's own key material at 0x5BB0 isn't mapped then either, so crypto already crashes: the emulator is only good for HID work in that state (its own warning says so).
- So Edge needs exactly what crypto needs. The plugin still refuses (`unsupported`) rather than touching memory it can't own.
- Android and Windows map the whole range.

**Wipe:** a hook at `void wipeflashdata() {` (unique; every firmware wipe path calls it) erases the region. The chain then restarts with a `wipe` link (R9).

## 3. The device chain (R1–R9)
- **Link format, welds and genesis:** exactly `node-onlykey-lib/edge/chain.js` (`head[-1] = SHA256("OKEDGE-GENESIS-v1" || device_id)`).
- **Decision points** (each a unique anchor):

| Decision | Hook |
|---|---|
| approve (pressed or self-press) | inside `void okcore_run_pending_op() {` (core:5531), which covers every confirmed operation |
| deny (wrong challenge) | ino:789 `} else if (CRYPTO_AUTH) { //Wrong challenge was entered` |
| timeout | core:5605-5614, the `hidprint("Timeout occured while waiting for confirmation on OnlyKey");` line |

- **v1 records** OKSIGN and OKDECRYPT on slots 1–4 and 101–116. FIDO2 and HMAC are linked in a later step.
- **Empty hook (R17):** a use arriving while the previous one has no receipt gets `prev_no_receipt`.

## 4. Budgets: provable series, signed at the press
- **GRANT_CREATE** `{scopes (1–4 × op, slot, cap), reason_hash, receipt_required}`:
  1. Validate: unlocked, not config mode, ≤ 4 live, Σcap ≤ 255 (owner, 2026-10-02: "1 budget max chain is 255").
  2. Draw a 32-byte seed (`RNG2`, core:7051) and compute `G = H^n(seed)`.
  3. Wait for a **physical press** via `okcore_prime_user_confirmation(OKEDGE, …)`, with an `OKEDGE` branch in `okcore_run_pending_op`, anchored on the unique `    } else if (packet_buffer_details[0] == OKHMAC) {`. No press means no budget.
  4. On the press:
     - link `grant-create`;
     - sign the budget genesis digest (`grants.budgetGenesisDigest`: device, budget id, G, uses, scopes, reason hash, the head before the link);
     - reply `(grant_id, uses, G, signature)`.
- **Self-press (R13):**
  - **Where:** a hook right after `user_input_mode = okcore_user_input_mode_for_slot(slot);` (core:6978, unique).
  - **Condition:** a live budget has a scope for this op and slot with room, the key is unlocked and not in config mode, and (R18) the previous use has its receipt. *(Built, after the spec change: started (R13a), the budget not on hold (R15a), and nothing owed at all (R18).)*
  - **Effect:** it forces `USER_INPUT_NONE`. The existing branch then runs the operation without a press (`CRYPTO_AUTH = 4`, `pending_op_no_press`). The approve hook links it as `self-press` with the budget and step.
  - **Reveal:** the key keeps the last reveal `(grant_id, step, v_i, mac = HMAC(v_i, subject))` for the host to read with `LAST_REVEAL`.
- **End:** `GRANT_REVOKE` links `grant-end` and wipes the seed. A lock or reboot loses the seeds, and the next boot links `grant-end` for every budget the state record says was live.
- **Never in a budget (R14):** FIDO2, config mode, backup/restore, wipe, key loading, PIN changes, derive / shared secret. The self-press hook only acts on OKSIGN/OKDECRYPT to slots 1–4 and 101–116.
- Config mode clears `unlocked` without a reboot (ino:849-856), so every use re-checks both flags.

## 5. Wire: `OKEDGE` = `TYPE_INIT | 0x78` (0xF8)
- **Request:** `recv_buffer[4]` = 0xF8, `[5]` = sub-op, `[6…]` = arguments (little-endian).
- **Replies:** 64-byte binary reports through `send_transport_response(buf, 64, false, false)` (core:2565); errors are `hidprint("Error …")`.
- **When it's accepted:** only while unlocked (ino:478-480). `OKEDGE` is **not** on the config-mode allow-list (core:335), so config mode drops it.

| Sub-op | Request | Reply |
|---|---|---|
| `01 HEAD` | – | `seq` u32 (0xFFFFFFFF = empty) · `head` 32 · `ringFrom` u32 · device_id 16 |
| `02 READ` | `from` u32 · `count` u8 (≤ 8) | per link two reports: the 64-byte link, then its 32-byte head |
| `03 CHECKPOINT` | – | `seq` u32 · `head` 32; then the 64-byte signature over `("OKEDGE-CKPT-v1" ‖ device_id ‖ seq ‖ head)` |
| `04 CKPT_PUBKEY` | – | the Edge public key, X‖Y (64) |
| `05 LAST_REVEAL` | – | `grant_id` u32 · `step` u16 · `v_i` 32 · then `mac` 32 |
| `10 GRANT_CREATE` | scopes · reason_hash 32 · flags | after the press: `grant_id` u32 · `uses` u16 · `G` 32; then the 64-byte genesis signature |
| `11 GRANT_LIST` | – | one report per live budget: id, uses, used, scopes |
| `12 GRANT_REVOKE` | `grant_id` u32 | `"OK"` |
| `20 RECEIPT` | `ref_seq` u32 · `code` u8 · `msg_hash` 32 | `"OK"` (R16 rules) |

Peers, receipts and LOSS (R20–R24) come after E3b.

## 6. Backup and restore (owner, 2026-10-02)
**The owner's rule, for every plugin:** a plugin backs up its important bits, and production hard keys on older firmware are never affected. Hard keys have no plugins, so a backup made **by** a hard key never changes. The case to protect is a soft-key backup restored **onto** an older hard key (v3.0.4, the compatibility target).

**How restore walks a backup** (format survey on the staged 3.1.0 tree and on `.stage-src/v3.0.4`; the two match line for line):
- The firmware decrypts the backup, then walks its records: `0xFF` slot fields, `0xFE` keys / authenticator state / resident keys, `0xFD` legacy U2F.
- **Any other first byte ends the walk** (`} else { break; }`, 3.1.0 core:6846, v3.0.4 core:6976-6978). Everything before it is already applied, and the firmware still reports "Successfully loaded backup" (core:6850 / :6981).
- A precedent already exists: 3.1.0 backups carry field 30, which v3.0.4 does not know and ignores.

**So: one plugin section, last in the backup (option A2).**
- It starts with `0xFB` (no firmware uses that byte), after the last `0xFE` record. Older firmware stops there with everything else restored.
- Then one entry per plugin: name length (u8) · name · data length (u16 LE) · data.
- A plugin-aware restore hands each entry to its plugin, and skips, by length, a plugin it doesn't have.
- **It is inside the backup's encryption and its digest**, so the same backup key protects it and the host's integrity check covers it.
- It is written by a generic plugin-backup hook (the loader's, not Edge's), placed right after the resident-key loop in `backup()` (core:6262). It is read in a new `else if (*ptr == 0xFB)` branch before that `break`, with explicit length checks against the received size.

**Size:**
- A backup is capped at 18,000 bytes (the backup array and the restore buffer, both versions); a full key is about 16.7 KB.
- So all plugins together get a **fixed budget of 512 bytes**, and the hook refuses to write past 18,000 bytes. Past that cap v3.0.4 would reject the whole restore.

**Edge's entry (built, 2026-10-02): version 2, `seq`, `head`, the owed count, `overflow` and up to 4 owed uses - 39 to 183 bytes. Debts travel with the backup, so a restore never pays them (R16). Version 1 (37 bytes: `seq`, `head`) still restores. Live budget ids are RAM-only and end at a restore anyway. The plan before it:**
- what it carries: `seq` · `head` · device_id · live budget ids;
- what stays out:
  - **the ring:** 3 KB is too big, and hosts hold copies and refill it;
  - **seeds:** a budget ends with the key's session.

**On restore, Edge firmware:**
- **The identity carries over:** the Edge key and device_id come from K132, which is in the backup, so the restored key is the same Edge identity.
- **It links `restore` first**, recording the backup's `(seq, head)`. History after the backup is gone, so hosts see the head go back; the `restore` link states that gap for the person to accept (like LOSS, R24) instead of hiding it.

**Proven:** the edge kit test takes a backup on the plugin build and restores it (the key comes back at the backup's head and links a LOSS). That backup is node-onlykey-emulator's fixture `test/fixtures/plugin-backup-3.1.0-edge.json`, and `test/restore-plugin-backup.js` restores it on **v3.0.4** and **base 3.1.0**: each set its label, settings and backup key, stopped at `0xFB`, and said "Successfully loaded backup" - no error, no restart. A 3.1.0 backup holding post-quantum keys is a different matter (held finding: v3.0.4 stops at the first PQ key with "format incorrect").

**Held, candidate finding (nothing sent):** both 3.1.0 and v3.0.4 write the end-of-records `0xFC` at `offset+1` (core:6632), leaving `large_temp[offset]` = the first IV byte. If that byte is FF/FE/FD, the walk runs on into the encryption trailer. The trailing `0xFB` section ends the walk before that point.


## 7. Build order (each step: the plugin's own kit + e2e tests, then commit)
1. **Storage + identity + `HEAD`/`READ`/`CKPT_PUBKEY`.** Links for OKSIGN/OKDECRYPT approve/deny/timeout. The lib verifies the chain it reads.
2. **Budgets:** `GRANT_CREATE` with the press and the signed genesis, self-press, `LAST_REVEAL`, `GRANT_LIST`/`GRANT_REVOKE`, `grant-end` at boot.
3. **`RECEIPT`** and the R17/R18 rules; after the spec change also TX start, GRANT_HOLD/RESUME, the 4 owed uses and WAIVE (built 2026-10-02; R19 composite pairs still open). Then E3b: apk-signer under a budget, over Bluetooth (Part D).
4. **`CHECKPOINT`.** The lib's device calls and `capabilities().edge` (L4/L5). The Edge tab moves off the fake key.
