# edge: the soft-key firmware plugin (design, E3)

The firmware half of OnlyKey Edge, as a plugin: soft key (ok-rn) and the desktop emulator only, never a hard key. The host half is `node-onlykey-lib/edge` (E1); its byte formats (`src/edge/codes.js`, `chain.js`, `grants.js`, `tickets.js`) are the contract, and every byte here must produce the same links, welds and signatures as the lib and its Python vectors.

**Owner's design (2026-10-02):** Edge is a provable blockchain.
- The **device chain** records every decision the key makes.
- Each **budget** is its own `bmatusiak/provable` series. Its genesis is started by a **physical press** and **signed by the key**, and the signature commits to the device chain's head before it, so budgets sit in the chain like blocks.

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
- **Empty hook (R17):** a use arriving while the previous one has no ticket gets `prev_no_ticket`.

## 4. Budgets: provable series, signed at the press
- **GRANT_CREATE** `{scopes (1–4 × op, slot, cap), reason_hash, ticket_required}`:
  1. Validate: unlocked, not config mode, ≤ 4 live, Σcap ≤ 255 (owner, 2026-10-02: "1 budget max chain is 255").
  2. Draw a 32-byte seed (`RNG2`, core:7051) and compute `G = H^n(seed)`.
  3. Wait for a **physical press** via `okcore_prime_user_confirmation(OKEDGE, …)`, with an `OKEDGE` branch in `okcore_run_pending_op`, anchored on the unique `    } else if (packet_buffer_details[0] == OKHMAC) {`. No press means no budget.
  4. On the press:
     - link `grant-create`;
     - sign the budget genesis digest (`grants.budgetGenesisDigest`: device, budget id, G, uses, scopes, reason hash, the head before the link);
     - reply `(grant_id, uses, G, signature)`.
- **Self-press (R13):**
  - **Where:** a hook right after `user_input_mode = okcore_user_input_mode_for_slot(slot);` (core:6978, unique).
  - **Condition:** a live budget has a scope for this op and slot with room, the key is unlocked and not in config mode, and (R18) the previous use has its ticket.
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
| `20 TICKET` | `ref_seq` u32 · `code` u8 · `msg_hash` 32 | `"OK"` (R16 rules) |

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

**Edge's entry, about 60 bytes:**
- what it carries: `seq` · `head` · device_id · live budget ids;
- what stays out:
  - **the ring:** 3 KB is too big, and hosts hold copies and refill it;
  - **seeds:** a budget ends with the key's session.

**On restore, Edge firmware:**
- **The identity carries over:** the Edge key and device_id come from K132, which is in the backup, so the restored key is the same Edge identity.
- **It links `restore` first**, recording the backup's `(seq, head)`. History after the backup is gone, so hosts see the head go back; the `restore` link states that gap for the person to accept (like LOSS, R24) instead of hiding it.

**Proven, not assumed:** the plugin's kit tests make a backup with a plugin section on a plugin build, restore it onto the **v3.0.4 emulator build**, and check every slot, key and label came back, plus the success message.

**Held, candidate finding (nothing sent):** both 3.1.0 and v3.0.4 write the end-of-records `0xFC` at `offset+1` (core:6632), leaving `large_temp[offset]` = the first IV byte. If that byte is FF/FE/FD, the walk runs on into the encryption trailer. The trailing `0xFB` section ends the walk before that point.


## 7. Build order (each step: the plugin's own kit + e2e tests, then commit)
1. **Storage + identity + `HEAD`/`READ`/`CKPT_PUBKEY`.** Links for OKSIGN/OKDECRYPT approve/deny/timeout. The lib verifies the chain it reads.
2. **Budgets:** `GRANT_CREATE` with the press and the signed genesis, self-press, `LAST_REVEAL`, `GRANT_LIST`/`GRANT_REVOKE`, `grant-end` at boot.
3. **`TICKET`** and the R17/R18 rules. Then E3b: apk-signer under a budget, over Bluetooth (Part D).
4. **`CHECKPOINT`.** The lib's device calls and `capabilities().edge` (L4/L5). The Edge tab moves off the fake key.
