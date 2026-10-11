# OnlyKey Edge: the firmware

**A whitepaper on the Edge firmware plugin.** 2026-10-10, for the v1 firmware (the first release) with hybrid P-256 + ML-DSA-65 signatures (ok-rn after `c906e1b`).
**Code:** `ok-rn/android/okemu/plugins/edge/src/okplugin_edge.cpp` (cited as `cpp:LINE`), `okplugin_edge.h` (`h:LINE`), `plugin.js`. Every line number is as of that change.
**Rules:** [`SPEC.md`](SPEC.md) (R-numbers), [`BLOCKS.md`](BLOCKS.md), [`RECEIPT-CODES.md`](RECEIPT-CODES.md).
**Host side, for cross-reference:** `node-onlykey-lib/edge/plugin/index.js` (the wire calls) and `node-onlykey-lib/edge/src/` (`chain.js`, `grants.js`, `receipts.js`, `codes.js`).

The code is the source of truth here. Where the code and the spec disagree, §14 names both.

## Contents

1. Abstract
2. How to use it
3. Where it runs
4. Vocabulary
5. State and storage
6. Identity
7. The chain
8. Budgets
9. A transaction end to end
10. Backup, restore and continue
11. The wire
12. Security properties and threat model
13. Known limits and open items
14. Code vs spec
15. Appendix: file and function map

---

## 1. Abstract

OnlyKey Edge lets an AI agent use an OnlyKey without handing it the key. The rule is **budget or no go**. The person opens a **budget** on the phone: Yes in the app, then a press on the key. The budget says what may be used (an operation and a slot, and for derived keys one identity), how many times, and for how long. Inside it, the key presses for the agent, one use at a time. Outside it, Edge pays for nothing and writes nothing.

Every Edge record is a 64-byte **link** in a SHA-256 hash chain. The key keeps the head. Each budget use owes a **receipt**: a one-byte result code and a message hash, filed before the next use may start. The key signs **checkpoints** over its head with a P-256 key no ordinary sign request can reach. It also signs an **owner statement** that lets your other devices tell a log "made with our key". Hosts keep the full chain and verify it against those signatures.

The firmware is deliberately small. It is a **notary** (`cpp:1-21`): the smallest firmware addition that works, because a device can only hold so much logic. It records facts it saw itself and decides the few things a host cannot be trusted to decide. Everything else (storing the chain, verifying it, pairing receipts, sync, screens, JSON blocks) is `node-onlykey-lib/edge` and the app's.

## 2. How to use it

Three parties appear below. The **agent** is the program on a computer that wants to use the key. The **app** is whatever the person approves requests in: a phone app, or a desktop app holding the key. The **key** is the OnlyKey, hard or soft. "Press the key" means its button; on a soft key, that is the on-screen key button. Every Edge press has a 25-second window. A press that misses it is a no: nothing opens and nothing is linked.

Each step names the wire request behind it (§11), so a reimplementation can follow the same order.

### 2.1 Approve a budget

1. **Review the budget the app presents.** It must show:
   - which keys are used: each scope as operation + slot, and for a derived identity its label;
   - how many uses each key may make;
   - how long the budget lives (0 = 12 hours);
   - the agent's description of the budget's task. The key gets only its hash.

   If anything is not what you expect, decline. Nothing reaches the key.
2. **Press the app's approve button.** This passes the request to the firmware: one `GRANT_LABEL` per derived identity, then `GRANT_CREATE`. The key refuses at once if:
   - a receipt is owed (`EDGE:0C`);
   - the app's copy is not the key's latest head (`EDGE:0B`);
   - a scope is not allowed (`EDGE:02`, `03`, `04`).

   Otherwise it waits for the press.
3. **Press the key to confirm.** The key checks the debt and the head again and opens the budget. It writes the grant-create link and signs a checkpoint over it. The budget is live until it expires, is ended, or the key locks or reboots.

### 2.2 A budget use (the agent; no person)

1. The agent reads `HEAD`: seq, head, live budgets, owed count.
2. The agent sends `TX_START` with the token over that head, the exact request and its intent. The key refuses while a receipt is owed (`0C`) or when no budget can pay (`0D`).
3. The agent sends the sign or decrypt, unchanged. If it is the announced request and a budget pays, the key runs it with no press. Before releasing the result, it writes the self-press link. If it is not the announced request, the key refuses it (`EDGE:1C`) and nothing runs.
4. The agent picks up the link (`PICKUP`) for its copy of the chain.
5. **The agent files the receipt** (`RECEIPT`): a result code and the hash of its message. The receipt is welded onto the chain. Until it is filed, the budget pays for nothing more.
6. When that was the budget's last use, the key ends the budget itself: a grant-end link marked completed. Nothing for the agent or the app to do.

If the announced request arrives after its budget can no longer pay, the key spends the TX start. It treats the request as an ordinary one: the person's own press decides, and no link is written.

### 2.3 Hold, resume or end a budget

- **Hold:** press the app's hold button. No key press is needed, since a hold only makes the key stricter (`GRANT_HOLD`). The budget pays for nothing until it is resumed.
- **Resume:**
  1. Review the held budget in the app.
  2. Press the app's resume button (`GRANT_RESUME`). The key refuses while a receipt is owed (`0C`) or on a stale head (`0B`).
  3. Press the key to confirm.
- **End:** press the app's end button (`GRANT_REVOKE`). No key press is needed. A debt the budget made stays owed.

### 2.4 Settle a budget nobody will finish (settle)

For when the agent cannot file its receipts: the power was cut mid-use, a signer failed mid-stream, or the agent is no longer allowed to use the key.

1. Review the owed uses the app lists: which use, when, and what it was for.
2. Press the app's settle button (`SETTLE`). If nothing is owed, the key refuses (`EDGE:08`).
3. Press the key to confirm. The key first ends every live budget, each with its grant-end link, then writes one receipt marked "needs review" (code `0x8F`) that names every settled use.
4. Nothing pays any more. To go on, the agent asks for a new budget, and you approve it as in §2.1.

### 2.5 Accept lost links (loss)

1. Review the range the app names: the links no copy anywhere holds.
2. Press the app's accept button (`LOSS {from, to}`). The key refuses a range past its head (`EDGE:12`).
3. Press the key to confirm. The key writes a loss link. It records the acceptance and pays no debt.

### 2.6 Restore a backup

1. Restore the backup onto the key as usual. The Edge section brings the seq, the head and the owed uses with it, but not the salt.
2. Nothing more to press. On the first Edge request, the key draws a new salt, so it has a new device id. Its first link is the continue link, which names the chain it came from. Debts carried over are still owed, and are paid by a receipt or a settle.

### 2.7 Show which devices are yours (no press)

The app asks the key for an owner statement (`STATEMENT`), with the hash of the device's nametag. The key signs it with its owner key, which every device made from the same OnlyKey secret shares. Another device's log that carries a statement under the same owner key was made with your OnlyKey. Nothing is linked and nothing is pressed.

## 3. Where it runs

Edge is a **firmware plugin for the soft key**: the OnlyKey 3.1.0 firmware compiled into the ok-rn Android app (and the desktop emulator). It is staged only when asked (`OKEMU_PLUGINS=edge`). Without it the firmware is the base build, byte for byte ([AUDIT.md](AUDIT.md)). `plugin.js` declares `minBase: '3.1.0'`, `backup: true` and eight hooks into the core:

| # | File | Anchor | What the plugin does there |
|---|---|---|---|
| 1 | `okcore.cpp` | after `#include "onlykey.h"` | includes the plugin header |
| 2 | `okcore.cpp` | before the vendor switch's `default:` | `case OKEDGE: okplugin_edge_recv()` |
| 3 | `okcore.cpp` | after `user_input_mode = okcore_user_input_mode_for_slot(slot)` | `okplugin_edge_primed()`: forces a press for Edge's own requests; sets "no press" for a sign/decrypt a budget pays, or one it will refuse |
| 4 | `okcore.cpp` | first line of `okcore_run_pending_op()` | `okplugin_edge_refused()`: a refused request ends there (nothing runs, `fadeoff(1)`); else `okplugin_edge_decision(APPROVE)` |
| 5 | `okcore.cpp` | before the 20 s "Timeout occured" message | `okplugin_edge_decision(TIMEOUT)` |
| 6 | `sketch/OnlyKey.ino` | after `#include "onlykey.h"` | includes the plugin header |
| 7 | `sketch/OnlyKey.ino` | the wrong-challenge branch | `okplugin_edge_decision(OKEDGE_DECISION_DENY)` |
| 8 | `okcore.cpp` | first line of `wipeflashdata()` | `okplugin_edge_wipe()` |

Hooks 5 and 7 only drop an Edge request that was waiting for its press. Neither writes a link (§9.6).

**Why not a hard key today.**

- **Place.** The plugin's flash region is `base + 0x1000`, computed as `factorysectoradr - 0x4800` (`cpp:84`). The code says: "Soft key and desktop emulator only: the flash it uses (base+0x1000) is the bootloader's on a real Teensy, and file-backed and unused on the emulators" (`cpp:26-27`). On a hard key there is no free flash sector today (SPEC.md).
- **Size.** The plugin adds no crypto of its own: SHA-256, uECC, HKDF, RNG, flash and the press flow are the firmware's. It calls only `uECC_compute_public_key` and `uECC_sign`, never a verify, so Edge does not need uECC's verify in a hard-key build. The measured size is in §13. Any port is for the firmware maintainers to decide.

What the soft key means for trust is in §12.3: the key is a process on the phone, so the phone's OS is part of what is trusted.

## 4. Vocabulary

The terms of BLOCKS.md, mapped to the code.

| Term | What it is | In the code |
|---|---|---|
| **Transaction** (TX) | one budget use: announced (TX start), signed, then receipted. One link | `OKEDGE_TX_START` (`h:29`), `okplugin_edge_primed` (`cpp:1013`), the self-press link (`cpp:1102`) |
| **TX start** | the agent tells the key the exact request it is about to make | `started`, `tx_token`, `tx_intent` (`cpp:180-197`) |
| **Budget** | opened with a press; scopes, caps, lifetime; hold, resume, end | `struct budget` (`cpp:149-158`), `grant_create` / `grant_pressed` (`cpp:839`, `cpp:893`). The code calls it a "grant" |
| **Receipt** | the result of one transaction: code + message hash | `OKEDGE_RECEIPT` (`cpp:1332-1357`), op 8 |
| **Settle** | a pressed receipt that clears the debt | `settle_pressed` (`cpp:950`), op 8 with code 0x8F |
| **Block** | the links since the last seal, sealed by a signed checkpoint | the key only signs the checkpoint (`checkpoint`, `cpp:573`); blocks as JSON are the host's |
| **Fork** | one device's own chain | the per-device salt (R28, `cpp:422-431`) |
| **Merge** | a sync of another device's log | not on the key: the app and the lib (R30) |
| **Nametag** | a device's own name or tag for its fingerprint | signed in the owner statement (`statement`, `cpp:601`) |

Other words used below: **link** (64 bytes, §7), **head** (the running hash), **seq** (link number from 0), **owed / debt** (a use waiting for its receipt), **the press** (a physical press: on the soft key, the keypad in ok-rn).

## 5. State and storage

### 5.1 The record (flash, v1)

One record, magic `OKEDGEv1`, 208 bytes, double-buffered in two 2 KB sectors: `base+0x1000` and `base+0x1800` (`cpp:84-86`, `cpp:88-104`).

| Off | Size | Field | Meaning |
|---|---|---|---|
| 0 | 8 | magic `OKEDGEv1` | the first release (`cpp:104`) |
| 8 | 4 | `gen` | generation; the newer valid copy wins |
| 12 | 4 | `seq` | the latest link's seq; `0xFFFFFFFF` = no link yet |
| 16 | 32 | `head` | head[seq]; the genesis while empty |
| 48 | 1 | `owes` | 1 = the use in `owed` owes a receipt; 0 = nothing owed |
| 49 | 3 | zeros | unused |
| 52 | 36 | `owed` | the owed use: seq u32, head[seq] 32 |
| 88 | 64 | `last_link` | the latest link, so a crash never loses it |
| 152 | 1 | `salted` | this device has its salt (R28) |
| 153 | 1 | `cont` | 1 = a continue link is owed (a backup was restored here) |
| 154 | 32 | `salt` | the per-device salt, never in a backup |
| 186 | 16 | `cont_id` | the device id of the chain the continue names |
| 202 | 2 | padding | zeros |
| 204 | 4 | check | first 4 bytes of SHA-256 over bytes 0-203 |

**Double buffering** (`cpp:353-358`). Every save bumps `gen` and writes the *other* sector: odd `gen` to B, even to A. `okcore_flashsector` erases the sector, then writes. At load (`cpp:370-387`) each copy is decoded. A bad magic or a bad check means a torn write, and the other copy wins. The check is a torn-write detector, not a MAC: anyone who can write the flash file can recompute it (§12.3).

**When it is saved.** Every link saves before anything else happens (`weld_in`, `cpp:669-672`). The approve hook runs first in `okcore_run_pending_op()`, so a self-press link is on flash before the signature is released (R4). Drawing the salt (`cpp:548`), the genesis (`cpp:561`) and a restore (`cpp:1215`) also save.

**The other two sectors.** `base+0x2000` and `base+0x2800` are unused. Nothing reads, writes or erases them.

### 5.2 The clean start (v1)

v1 is the first release of the protocol and schemas. Nothing older is read. At load, if neither sector decodes as `OKEDGEv1` (`cpp:378-383`):

- the state starts empty: no salt, no link. Nothing is erased: a record of another format is simply not read.

The next Edge request draws a new salt, so a new Edge key, a new device id and a new genesis. Nothing outside the Edge region is touched; every private key stays (R31).


### 5.3 RAM only

These die with the process. On the soft key a lock or reboot is a new process, so they end on lock.

| What | Code | Why RAM |
|---|---|---|
| Edge public key, device id | `ident` (`cpp:135-139`) | recomputed from K132 and the salt |
| Live budgets (≤ 4): scopes, counters, seed, genesis, hold, opened, lifetime | `budgets[]` (`cpp:149-158`) | R15: a budget ends with the session; its seed is never stored |
| Staged derive labels for the next GRANT_CREATE | `staged` (`cpp:164-169`) | consumed, or cleared after 25 s |
| The TX start: started flag, token, intent | `cpp:180-197` | one use; any link clears it |
| Refused TX starts since power-up | `refused_tx` (`cpp:204`) | a refusal writes no link (flooding and flash wear) |
| The last 8 links, each with its head and a self-press's reveal | `held[8]` (`cpp:212-218`) | for PICKUP; the latest is re-held at boot from `last_link` (`cpp:385`) |
| The waiting sign/decrypt | `pend` (`cpp:221-231`) | |
| The waiting press-gated Edge request | `press` (`cpp:237-257`) | one at a time |

### 5.4 What survives a restart

The chain (seq, head, latest link), the debt, the salt and a pending continue. Not: budgets, a TX start, staged labels, the refusal count, held links other than the latest, or a request waiting for its press.

## 6. Identity

**K132** is the key's own derivation secret (the slot-132 ECC key), made at PIN setup and carried in the backup. Without it there is no Edge: every Edge request answers `EDGE:01` (`cpp:1222`). The firmware's ECC globals are saved before K132 is loaded and put back after, because a pending sign may be using them (`edge_secret_salted`, `cpp:397-412`). Each derived private key lives only on the stack and is zeroed after use.

**The Edge key** (the checkpoint key, `cpp:422-431`) is a P-256 private key:

```
Edge key = HKDF-SHA256(salt = 0x28 || device salt (32), IKM = K132, info = "onlykey/edge/v1", L = 32)
```

`okcrypto_hkdf_info` takes a 33-byte salt; `0x28` is a flag byte ("R28"). It signs only checkpoints the key builds itself (§7.5).

**The ML-DSA-65 twins.** Every P-256 signature Edge makes has an ML-DSA-65 signature beside it over the same digest (FIPS 204, pure, empty context), made with the firmware's own mldsa-native build (`utility/mldsa_native.c`, the code `okpqc` uses). Their keys are derived the same way and never stored:

```
checkpoint ML-DSA seed = HKDF-SHA256(salt = 0x28 || device salt, IKM = K132, info = "onlykey/edge/mldsa/v1", L = 32)
owner ML-DSA seed      = HKDF-SHA256(salt = 33 zero bytes,       IKM = K132, info = "onlykey/edge/owner-mldsa/v1", L = 32)
key pair               = ML-DSA-65 KeyGen_internal(seed): public key 1,952 bytes, signature 3,309 bytes
```

Each signing regenerates the key pair from its seed: the expanded secret key goes to `ctap_buffer` and is wiped after, and the public key and signature go to `large_resp_buffer` (3,392 bytes), so the plugin adds no RAM (`mldsa_keypair`, `mldsa_sign_reply`). A host requires both signatures: the pair holds while either algorithm holds, so a forged P-256 signature alone does not make a checkpoint or an owner statement.

**The device salt** (R28, `cpp:542-549`) is 32 bytes from the hardware RNG (`RNG2`), drawn the first time an Edge request finds none (and K132 exists). It lives only in the record. It is never in the backup section (`cpp:1168-1183`), every restore throws the old one away and draws a new one (§10.2), and the app keeps the whole flash file out of Android backup and device transfer (`data_extraction_rules.xml`, per `cpp:117-119`). So every restored key is a device of its own: its own Edge key, device id and chain, never a second writer of another chain. Only the Edge key takes the salt. Every derived identity (SSH, PGP) is K132's alone and stays the same (`cpp:416-420`).

**Device id and genesis** (`cpp:493-502`, `cpp:558-562`):

```
device_id = SHA256("OKEDGE-DEVICE-v1" || Edge public key X||Y)[0..16]
head[-1]  = SHA256("OKEDGE-GENESIS-v1" || device_id)
```

The key does not send its device id. Hosts compute it from `PUBKEY` the same way (`chain.deviceIdOf`).

**The owner key** (R29, `cpp:587-623`) is the one Edge secret that does **not** take the salt:

```
owner key = HKDF-SHA256(salt = 33 zero bytes, IKM = K132, info = "onlykey/edge/owner/v1", L = 32)
```

The code passes a NULL salt, which `okcrypto_hkdf_info` turns into 33 zero bytes (firmware `okcrypto.cpp`). So the owner key is the same on every device made from the same backup, and no salt has to leave its device for them to recognise each other (§7.6). It is computed only inside `statement()` and signs only the owner statement.

**No firmware request reaches these keys.** The firmware's own HKDF derives use the fixed info strings `onlykey/derive/ecc/v2`, `onlykey/agent/v2` and `onlykey/xwing/seed/v3` (3.1.0 `okcrypto.cpp`), never Edge's, and no host input chooses an info string.

## 7. The chain

### 7.1 The link

Every link is 64 bytes, one HID report (R3; built by `append_scoped`, `cpp:691-707`).

```
 0      4    5    6    7    8                        40         44     46    47               63
 +------+----+----+----+----+------------------------+----------+------+-----+----------------+---+
 | seq  | op |dec |slot|flag|  subject (32)          | grant_id | step |scope|  intent (16)   | v |
 | u32LE| u8 | u8 | u8 | u8 |                        | u32 LE   |u16 LE| u8  |                |u8 |
 +------+----+----+----+----+------------------------+----------+------+-----+----------------+---+
```

- `op` (`cpp:55-64`): 1 sign, 2 decrypt, 6 grant-create, 7 grant-end, 8 receipt, 11 loss, 13 grant-hold, 14 grant-resume, 16 continue. Op 15 (agent-add) is retired and never reused; `codes.js` keeps the number so a chain that holds one still reads. No other op is written.
- `decision`: 1 approve, 4 self-press; for a receipt, the receipt code.
- `flags` (`cpp:67-69`): bit0 press observed (0x01), bit1 budget spent (0x02), bit4 owes receipt (0x10). No other bit is set.
- `grant_id`: the budget id; for a receipt, the seq it answers; other links reuse it (§7.3).
- `scope` (byte 46): which scope paid, 1-based, on a self-press; the scope **count** on a grant-create; 0 elsewhere.
- `intent` (47-62): the use's intent on a self-press started with one (R13b); zeros otherwise.
- `v` (byte 63): the link format, `1` on every link (`cpp:696`, `h:36`).

### 7.2 The weld

There is one weld function, `weld_in` (`cpp:645-674`). Every link goes through it.

```
head[n] = SHA256("OKEDGE-LINK-v1" || head[n-1] || link[n])
```

After the hash, `weld_in` applies the debt rule, reading only the link:

- a sign/decrypt with decision approve or self-press and bit 4 set **owes**: it becomes the owed use, with its seq and head (`cpp:651-656`). Nothing starts while one is owed, so the slot is always free when a use arrives;
- a receipt with code `0x8F`, the press flag, and a subject equal to the settle subject over the owed seq is a **settle**: it clears the debt (`cpp:657-659`);
- any other receipt pays its `ref_seq` if that is the owed use (`cpp:660-663`).

Then it stores seq, head and the link, clears any TX start, saves the record and holds the link for pickup (`cpp:665-672`).

### 7.3 The links the firmware writes

Every link carries byte 63 = 1. Nothing else is ever written.

| Link | op | decision | slot | flags | subject | grant_id | step | byte 46 | Code |
|---|---|---|---|---|---|---|---|---|---|
| self-press | 1/2 | 4 | the slot | 0x12 (bits 1, 4) | SHA256(request bytes) | budget id | use number | scope paid | `cpp:1102` |
| grant-create | 6 | 1 | 0 | 0x01 | grant subject (§8.2) | budget id | 0 | scope count | `cpp:921` |
| grant-end | 7 | how it ended: 1 completed, 2 revoked, 3 settled | 0 | 0 | zeros | budget id | 0 | 0 | `cpp:1289` |
| grant-hold | 13 | 1 | 0 | 0 | zeros | budget id | 0 | 0 | `cpp:1312` |
| grant-resume | 14 | 1 | 0 | 0x01 | zeros | budget id | 0 | 0 | `cpp:940` |
| receipt | 8 | code | 0 | 0 | receipt subject (§9.4) | ref seq | 0 | 0 | `cpp:1353` |
| settle | 8 | 0x8F | 0 | 0x01 | settle subject (§9.5) | oldest settled | 0 | 0 | `cpp:960` |
| loss | 11 | 1 | 0 | 0x01 | `to` u32 ‖ 28 bytes (§10.4) | `from` | 0 | 0 | `cpp:998` |
| continue | 16 | 1 | 0 | 0 | continue subject (§10.3) | 1 if a debt is carried | 0 | 0 | `cpp:530` |

The self-press link's bytes 47-62 hold the intent when the TX start named one.

### 7.4 Hash labels

Every label that goes into the chain or a signature is `-v1` (SPEC.md). Receipt labels say RECEIPT, never TICKET (`cpp:1347`).

| Label | Use | Code |
|---|---|---|
| `OKEDGE-GENESIS-v1` | head[-1] | `cpp:529`, `cpp:560` |
| `OKEDGE-LINK-v1` | the weld | `cpp:648` |
| `OKEDGE-DEVICE-v1` | device id | `cpp:499` |
| `OKEDGE-CKPT-v1` | checkpoint digest | `cpp:576` |
| `OKEDGE-STATEMENT-v1` | owner statement digest | `cpp:611` |
| `OKEDGE-GRANT-v1` | grant-create subject | `cpp:905` |
| `OKEDGE-TX-v1` | TX start token | `cpp:1034` |
| `OKEDGE-RECEIPT-v1` | receipt subject | `cpp:1347` |
| `OKEDGE-SETTLE-v1` | settle subject | `cpp:629` |
| `OKEDGE-CONTINUE-v1` | continue subject | `cpp:521` |
| `OKEDGE-INTENT-v1` | the intent hash. The **host** computes it (`grants.intentOf`); the key receives only the 16 bytes | named at `cpp:190` |
| `OKEDGE-NAMETAG-v1` | the nametag hash. The **host** computes it (`grants.nametagHash`); the key receives only the 32 bytes | not in the firmware |

HKDF info strings: `onlykey/edge/v1` (`cpp:427`) and `onlykey/edge/owner/v1` (`cpp:612`).

Untagged hashes: the budget series `H^n` (`hash_times`, `cpp:289`), SHA-256 of link `to+1` inside a LOSS subject (`cpp:984`), and the record check (`cpp:329`).

**Press-prompt digests** are not in the chain. They are the 32 bytes handed to `okcore_prime_user_confirmation` while a press waits: SHA256(reason ‖ G ‖ scopes) for a budget (`cpp:882`), `OKEDGE-RESUME` ‖ id (`cpp:1328`), `OKEDGE-SETTLE` ‖ head (`cpp:1363`), `OKEDGE-LOSS` ‖ from ‖ to ‖ head (`cpp:1393`). They carry no version because nothing stores them.

The library computes every chain label the same way (`chain.js`, `grants.js`, `receipts.js`; checked by reading both).

### 7.5 The checkpoint

The key's chain signature (R7, `cpp:573-585`):

```
digest = SHA256("OKEDGE-CKPT-v1" || device_id (16) || seq (u32 LE) || head (32))
sig    = P-256 ECDSA (uECC_sign) with the Edge key over the 32-byte digest, r||s (64)
```

```
sig_pq = ML-DSA-65 with the checkpoint ML-DSA key over the same 32-byte digest (3,309 bytes)
```

The reply is `seq · head`, then the P-256 signature, then the ML-DSA-65 signature in 52 reports (2 + 52 reports). S is not normalised (`chain.js`, `verifyCheckpoint` with `lowS: false`). `CHECKPOINT` needs no press, and any host on the wire can ask for one: the key only ever signs its own current (seq, head). Opening a budget is answered with a checkpoint over its grant-create link (`cpp:928`), so the budget's genesis is signed through the chain.

### 7.6 The owner statement

A device that holds the private ECC key to sign the block is one whose log is wanted. Each device gives its own name for its device fingerprint in the block: its **nametag**. `STATEMENT` (0x06, `cpp:601-623`) takes the nametag hash and signs a statement about the key itself:

```
nametag hash = SHA256("OKEDGE-NAMETAG-v1" || nametag)                       (host: grants.nametagHash)
digest       = SHA256("OKEDGE-STATEMENT-v1" || device_id (16) || Edge public key X||Y (64)
                      || SHA256(checkpoint ML-DSA public key) (32) || seq (u32 LE) || nametag hash (32))
sig          = P-256 ECDSA (uECC_sign) with the owner key over the digest, r||s (64)
sig_pq       = ML-DSA-65 with the owner ML-DSA key over the same digest (3,309 bytes)
```

`seq` is the key's current seq, `0xFFFFFFFF` before the first link. No press and no link: it writes nothing. The reply is `seq · nametag hash`, then the owner public key X‖Y, then the P-256 signature, then the ML-DSA-65 signature (3 + 52 reports). The owner ML-DSA public key comes from `PUBKEY_PQ` with `which = 1`. Another device of yours checks the statement with `grants.verifyStatement` against **its own** two owner public keys: it verifies only if the same OnlyKey secret made both, and only with both signatures. The statement names both checkpoint keys, so a forged ML-DSA key cannot be put beside a real P-256 one. The nametag is a label: the signature proves the key, not the words.

## 8. Budgets

**Who asks is the host's business.** A budget request reaches the key from whatever host speaks to it. The app accepts requests only from a Bluetooth-paired computer it has approved; the key never sees an agent identity and keeps no agent list (R15c is retired). The person's Yes and the key's press are what open a budget.

### 8.1 Opening one: GRANT_CREATE (0x10)

Request layout (`cpp:839-884`; R27):

| Bytes | Field |
|---|---|
| [6] | scope count, 1-4 |
| [7..22] | up to 4 scopes: op u8, slot u8, cap u16 LE |
| [23..54] | reason hash: SHA-256 of the reason text the person reads |
| [55] | flags (read by nothing) |
| [56..57] | lifetime, u16 LE minutes; 0 = 12 hours |
| [58..63] | the first 6 bytes of the head the host verified its copy up to |

The key checks, in order: it takes and clears any staged labels; refuses while a receipt is owed (`EDGE:0C`); refuses unless the 6 head bytes match its head (`EDGE:0B`); checks the scope count (`EDGE:02`); checks each scope is allowed, has cap ≥ 1, and (on a derived code) has a fresh staged label (`EDGE:03`); checks the caps add up to ≤ 1024 (`EDGE:04`). Then it draws a 32-byte seed from `RNG2`, computes `G = H^n(seed)` (n = the sum of the caps, up to 1,024 SHA-256 runs), and waits for the press (`press_wait`, `cpp:812-816`).

**What a budget may pay for** (R14, `scope_allowed`, `cpp:716-721`):

| op | slots |
|---|---|
| sign (1) | stored slots 1-4 and 101-116; agent sign codes 201-203 and 221-223 |
| decrypt (2) | stored slots 1-4 and 101-116 |
| anything else | never: FIDO2, config, backup, keys, PINs, the hardened derive and shared secret |

**Derived identities** (R11a, `cpp:141-174`, `cpp:819-828`). The codes 201-203 and 221-223 are shared by every derived identity of a curve; the 32-byte derive label picks which one signs. A scope there must name one identity. The host stages the label with `GRANT_LABEL {scope index [6], label 32 [7..38]}` (0x11, no press, no link). The next GRANT_CREATE consumes it, and 25 s without one clears it. The scope keeps the first 16 bytes. A request matches only if its last 32 bytes (message ‖ label) start with them (`cpp:1028-1029`, `cpp:745-749`). The grant subject commits to all 32. So a budget for one identity never pays for another identity's logins on the same code.

### 8.2 The press

On the press, `grant_pressed` (`cpp:893-929`) checks again that nothing is owed, that the head has not moved (a link written while the key waited would otherwise open the budget on a history the host never checked), and that a budget slot is free (`EDGE:05`; an expired budget's slot counts as free). Then:

```
id      = seq of the grant-create link + 1          (never 0)
subject = SHA256("OKEDGE-GRANT-v1" || scope count || scopes || reason_hash || G
                 || lifetime (u16 LE) || the full 32-byte labels of derived-code scopes, in order)
```

It records `opened = millis()` and the lifetime, writes the grant-create link, and replies `id u32 · uses u16 · G 32 · seq u32` (42 bytes), then a checkpoint over that link (two reports). A host checks the opening on its own with `grants.verifyBudgetOpening`: the subject commits to G, the weld reaches the signed head, and the signature verifies.

### 8.3 Uses, caps and the hash series

Each budget is its own hash series (`cpp:23-24`). Use *i* reveals `v_i = H^(n-i)(seed)` (`cpp:1100`). Anyone can check `H^i(v_i) == G`, and nobody without the seed can make the next value (a SHA-256 preimage). The key enforces each scope's cap and the budget's total (`budget_for`, `cpp:752-766`). The reveal is held beside the link for PICKUP. The firmware sends no MAC; `HMAC(v_i, subject)` is the host's to compute where a proof wants it (R13).

### 8.4 Lifetime, hold, resume, revoke

- **Lifetime** (R15b, `cpp:723-734`). Minutes from the press, by the key's own clock (`millis()` since boot); 0 = 720 minutes. The check is wrap-safe. A reboot ends every budget anyway, so the clock never resets inside a budget's life. An expired budget pays nothing, HEAD stops listing it, and its slot is free. No link is written.
- **Hold** (R15a, 0x13, `cpp:1304-1316`). `id [6..9]`. No press: it only makes the key stricter. A held budget pays nothing and no TX start succeeds under it. One grant-hold link; holding a held budget links nothing.
- **Resume** (0x14, `cpp:1317-1331`, `cpp:932-943`). `id [6..9] · the full 32-byte verified head [10..41]`. Refused while owed (`EDGE:0C`) or on a stale head (`EDGE:0B`), checked on arrival and again at the press. Needs a press. A grant-resume link, only if the budget was on hold.
- **Revoke** (0x12, `cpp:1285-1292`). `id [6..9]`. No press, allowed while owed. The budget is zeroed and a grant-end link is written. Debts it made stay owed.

**What ends a budget:** being fulfilled (linked, completed), revoke (linked), a settle (every live budget, linked, before the settle; §9.5), expiry (not linked), lock or reboot (RAM lost, not linked), a restore (`cpp:1212`), the continue link (`cpp:523`), a wipe (`cpp:1146`). A fulfilled budget, every use made and receipted, ends itself at that last receipt (`complete_fulfilled`, `cpp:801`): no host step, so a spent budget never sits live until it expires. Every grant-end link's decision byte says how the budget ended: `1` completed, `2` revoked, `3` settled (ended early, incomplete; the settle receipt after it names the open uses).

## 9. A transaction end to end

### 9.1 The flow

```
 agent (host)                                  the key (plugin)
 ------------                                  ----------------
 HEAD ---------------------------------------> seq, head, budgets, owed
 TX_START {token 32, intent 16} -------------> refuse if owed (0C) or no budget
                                               could pay (0D): count it
                                <------------- EDGE:00   (started = 1)
 OKSIGN / OKDECRYPT (unchanged wire) --------> primed: subject = SHA256(bytes primed)
                                               token == SHA256("OKEDGE-TX-v1" || MY head
                                                               || subject || intent) ?
                                                 no  -> refuse EDGE:1C, TX start used up
                                                 yes, a budget pays -> no press
                                                 yes, none can pay  -> TX start spent;
                                                                       ordinary press
                                               run_pending_op:
                                                 refused()? -> fade, nothing runs
                                                 decision(APPROVE): reveal v_i,
                                                 self-press link welded + SAVED (R4)
                                <------------- the signature / plaintext
 PICKUP {seq, 1} ----------------------------> link, then head + reveal
 RECEIPT {ref seq, code, msg hash} ----------> receipt link: the debt is paid
                                <------------- seq . head
                                               (that head goes into the next TX start)
```

### 9.2 TX start (0x22)

`TX_START {token [6..37], intent [38..53]}` (`cpp:1367-1384`). The token is the host's `grants.txToken`:

```
token   = SHA256("OKEDGE-TX-v1" || head || subject || intent)
subject = SHA-256 of exactly the bytes the agent will submit
intent  = first 16 bytes of SHA256("OKEDGE-INTENT-v1" || intent text), or 16 zeros
```

The key refuses the start while anything is owed (`EDGE:0C`) or when no budget is alive, off hold and with uses left (`EDGE:0D`). Each refusal bumps the refusal count (`refuse_tx`, `cpp:206-209`). Otherwise it stores the token and intent and sets `started`. It does not check the token here: that happens at the sign, against the key's own head. One hash checks both that nothing happened in between and that the request is the one announced (R13a). Head plus subject (64 bytes) would not fit a report; the token does.

### 9.3 The sign or decrypt

`okplugin_edge_primed` (`cpp:1013-1066`) runs when the firmware primes an OKSIGN or OKDECRYPT. It records the opcode and slot, hashes exactly the bytes handed to `okcore_prime_user_confirmation` into `pend.subject`, and, on a derived code, takes the label prefix from the last 32 bytes. Then:

1. **Started, token does not match** (another program slipped in, or a stale head): refused, `EDGE:1C`. The TX start is used up, the refusal count goes up, and the press mode is set to "none" so the core reaches `okplugin_edge_refused()` at once (`cpp:1035-1048`).
2. **A budget pays** (`budget_for`: started, unlocked, out of config mode, nothing owed, alive, not held, room in a matching scope): press mode "none". The firmware's own no-press path runs it (`cpp:1053-1055`).
3. **Started, the token matched, but no budget can pay now** (expired, held or ended in between): the TX start is spent, and the request is an ordinary one: the person's press decides, and an ordinary press writes no link (`cpp:1056-1064`). This case is not refused: **budget or no go** means only that nothing goes on the chain without a budget behind it (SPEC.md R13a).
4. **Not started:** nothing changes. It is an ordinary ssh/gpg request and the person presses as on any OnlyKey.

`okplugin_edge_refused()` runs first in `okcore_run_pending_op` (`cpp:1116-1135`). It refuses case 1 with `EDGE:1C`. It re-checks case 2: a request primed to be paid, with no press, that a budget can no longer pay is refused with `EDGE:0D`, because it must never run without a press and without a link. A refused request runs nothing and writes no link.

`okplugin_edge_decision(APPROVE)` (`cpp:1075-1108`) then writes the self-press link **before** the operation runs: `used++`, the scope's `used++`, the reveal, the intent (if any) into bytes 47-62, flags `owes receipt | budget spent`, `grant_id` = budget id, step = the use number, byte 46 = the scope that paid. The link is saved and held. Only then does the core sign or decrypt (R4).

### 9.4 Receipts (0x20)

`RECEIPT {ref_seq u32 [6..9], code u8 [10], msg_hash 32 [11..42]}` (`cpp:1332-1357`). No press. Accepted for the owed use; otherwise `EDGE:08`. The key builds:

```
subject = SHA256("OKEDGE-RECEIPT-v1" || ref_seq (u32 LE) || head[ref_seq] || code || msg_hash)
```

`head[ref_seq]` comes from the key's own record of the owed use, so a receipt is bound to the use it answers. The message text never reaches the key. The code is stored as given; hosts read it against RECEIPT-CODES.md. The weld pays the debt. If that was the last open use of a budget whose uses are all made, the key ends the budget at once: a grant-end link marked completed. The reply is `seq · head` (36 bytes) after both: the head the agent puts in its next TX start.

### 9.5 Settle (0x21)

The way out for a debt nobody will receipt (R18, `cpp:1358-1366`, `cpp:950-962`). Refused if nothing is owed (`EDGE:08`, on arrival and again at the press). Needs a press (the person's Yes in ok-rn first). Written as a receipt with code `0x8F` NEEDS_REVIEW and the press flag:

```
subject  = SHA256("OKEDGE-SETTLE-v1" || the owed seq (u32 LE))
grant_id = the owed seq
```

**A settle settles the budget** (`settle_pressed`, `cpp:950`; `end_budget`, `cpp:789`). At the press, before the settle link, the key ends every live budget, held or not: its RAM is cleared and a grant-end link names it, the same link a revoke writes. A debt cleared by a press never leaves a budget that goes on paying; the agent's next TX start finds nothing to pay (`EDGE:0D`) and must ask for a new budget, which takes its own press. Ending the budget is more secure than letting it be used again.

The reply is `seq · head`. An agent cannot forge a settle through RECEIPT: the key writes RECEIPT links with flags 0, and the weld counts a settle only with the press flag (`cpp:659`).

### 9.6 What owes, and what is linked

Only budget uses owe a receipt (R16, `cpp:1093-1106`). While one is owed nothing automatic happens: no TX start, no self-press, no GRANT_CREATE, no GRANT_RESUME (R18, `owes`, `cpp:133`). An ordinary ssh/gpg press, approved, denied or timed out, writes **no link** (`cpp:1108`, R1; the press is the person's own safeguard, as on any OnlyKey). No press is unattended unless an approved budget pays for it and it is logged on the chain (`cpp:1093`).

So **at most one use is ever owed**: a self-press needs nothing owed, and it makes exactly one. A restore carries the backup's debt, which came from the same rule. The key keeps that one use, not a list.

### 9.7 Refusals and the refusal count

HEAD byte 60 is the number of TX starts refused since power-up (RAM only, stops at 255): starts refused at TX_START (`0C`, `0D`) and a mismatch at the sign (`1C`) (`cpp:206-209`, `cpp:1044`). A refusal writes no link, because any host could flood the chain and wear the flash. The count is the key's own evidence, and the phone's watcher alarms when it rises (`cpp:199-203`).

## 10. Backup, restore and continue

### 10.1 The backup section (version 1)

The loader writes one plugin section, `0xFB`, last in the encrypted backup; older firmware stops there with everything else restored ([DESIGN.md](DESIGN.md) §6, `AUDIT.md`). Edge's entry (`okplugin_edge_backup`, `cpp:1168-1183`):

| Bytes | Field |
|---|---|
| [0] | version `1` |
| [1..4] | seq |
| [5..36] | head |
| [37] | owes: 0 or 1 |
| [38..73] | the owed use (seq u32, head 32), when owes is 1 |
| then 16 | the chain's device id |

54 bytes, or 90 with a debt. Nothing is written before the first link, or without K132. **The salt is never here.** The debt travels with the backup, because only a receipt or a settle may pay it: a restore must not be a way to forgive it. Budgets do not travel; their seeds were never stored.

`okplugin_edge_restore` (`cpp:1191-1216`) accepts only version 1 with owes 0 or 1 and a length that covers the owed use and the device id. Anything else is ignored, and the key keeps what it has.

### 10.2 Every restore draws a new salt

The log cannot be reset, just as a blockchain cannot. So every restore, onto another phone or onto the phone that made the backup, makes the restored key a device of its own (`cpp:1198-1215`):

- it keeps only the record's generation counter, so the restored record wins at the next boot;
- it clears the salt and the identity, so the next Edge request draws a **new salt**: a new Edge key, device id and genesis;
- the backup's seq, head and debt become the record, and a continue is owed from the backup's device id;
- held links, budgets and any TX start are cleared.

The restored key never writes a second history under the old device id. The device's own record is overwritten: links it wrote after the backup now exist only in host copies, which still weld onto the head the continue names (R26 log recovery, in the lib).

### 10.3 R28: the continue link

On the first Edge request after a restore, `ensure_identity` draws the salt and writes the continue link (`cpp:552-557`, `write_continue`, `cpp:516-532`):

```
subject = SHA256("OKEDGE-CONTINUE-v1" || old device_id (16) || old seq (u32 LE) || old head (32)
                 || the carried debt's seq (u32 LE), when there is one)
```

It takes the **next** seq after the chain it continues (so a carried debt's seq never meets one of the new chain's) and is welded onto the **new** genesis. It has decision approve and flags 0 (the restore already needed the person), and `grant_id` = 1 when a debt is carried, else 0. The debt stays owed and is paid by receipt or settle on the new chain. Live budgets end. Hosts start the new chain's copy at the continue's seq (`chain.chainStart`) and keep the old copy, with its checkpoint key, beside it.

### 10.4 LOSS (0x34)

`LOSS {from u32 [6..9], to u32 [10..13]}`, with a press (R24, `cpp:1385-1396`, `cpp:995-1000`). Refused for an empty chain, a backwards range or one past the head (`EDGE:12`). The person accepts `#from..#to` as unrecoverable. The subject is `to` (u32 LE), then the first 28 bytes of SHA-256 of link `to+1` when the key itself still holds that link (its latest, or one in the held ring), else zeros (`loss_subject`, `cpp:971-986`). The link after a gap cannot prove its own bytes later; the key vouches for it from its own memory, never from the host. A LOSS pays no debt. The reply is `seq · head`.

## 11. The wire

`OKEDGE` = `TYPE_INIT | 0x78` = **0xF8** (`h:14`). Request: `[4]` = 0xF8, `[5]` = sub-op, `[6..]` = arguments, little-endian. Replies are 64-byte binary reports (`reply`, `cpp:297-302`, zero-padded) or the text `EDGE:xx` (two hex digits, nothing else, `cpp:283-287`; the firmware keeps its return strings minimal). The key answers only while initialized, unlocked and not in config mode; otherwise it says nothing (`cpp:1221`, R8). Without K132 every request answers `EDGE:01` (`cpp:1222`).

A pressed request waits for the core's own confirmation, which gives up at 20 s (hook 5); the plugin also drops a waiting press after 25 s (`PRESS_MS`, `cpp:79`, `cpp:1223`, `cpp:1078`). One press-gated request waits at a time; a new one replaces it.

Every case in the switch (`okplugin_edge_recv`, `cpp:1220-1401`):

| Sub-op | Name | Request `[6..]` | Press | Link | Reply | Refusals |
|---|---|---|---|---|---|---|
| 0x01 | HEAD | - | no | no | 62 bytes, below | - |
| 0x02 | PICKUP | from u32 · count u8 (capped at 8) | no | no | per link: the link, then head 32 ‖ reveal 32 (zeros if none) | `09` if any is not held; count 0 sends nothing |
| 0x03 | CHECKPOINT | - | no | no | `seq · head`, the P-256 signature, the ML-DSA-65 signature (2 + 52 reports) | `06` |
| 0x04 | PUBKEY | - | no | no | the Edge public key X‖Y | - |
| 0x05 | PUBKEY_PQ | which u8 (0 checkpoint, 1 owner) | no | no | the ML-DSA-65 public key, 1,952 bytes (31 reports) | `06` |
| 0x06 | STATEMENT | nametag hash 32 | no | no | `seq · nametag hash`, the owner public key, the P-256 signature, the ML-DSA-65 signature (3 + 52 reports) | `06` |
| 0x10 | GRANT_CREATE | §8.1 | **yes** | grant-create | `id · uses · G · seq`, then a checkpoint (3 + 52 reports) | `0C 0B 02 03 04`; at the press `0C 0B 05` |
| 0x11 | GRANT_LABEL | scope index u8 · label 32 | no | no | `EDGE:00` | `02` (index ≥ 4) |
| 0x12 | GRANT_REVOKE | id u32 | no | grant-end | `EDGE:00` | `07` |
| 0x13 | GRANT_HOLD | id u32 | no | grant-hold (if not held) | `EDGE:00` | `07` |
| 0x14 | GRANT_RESUME | id u32 · verified head 32 | **yes** | grant-resume (if held) | `EDGE:00` | `07 0C 0B`, again at the press |
| 0x20 | RECEIPT | ref seq u32 · code u8 · msg hash 32 | no | receipt | `seq · head` | `08` |
| 0x21 | SETTLE | - | **yes** | receipt 0x8F | `seq · head` | `08`, again at the press |
| 0x22 | TX_START | token 32 · intent 16 | no | no | `EDGE:00` | `0C 0D` (counted) |
| 0x34 | LOSS | from u32 · to u32 | **yes** | loss | `seq · head` | `12` |
| 0x7E | WIPE_DEBUG | - | **no** | no | `EDGE:00` | **DEBUG builds only** (`cpp:1293-1303`): erases the Edge region; a production build has no such case |
| other | | | | | `EDGE:0A` | includes 0x15, the retired AGENT_ADD |

**0x15** (the retired AGENT_ADD) falls to `default:`, so it is answered as an unknown request, with no press and no link. The number is never reused (`h:29`).

A pressed request that fails at the press, or a press with no K132, answers `EDGE:xx` like any refusal. `EDGE:1C` and the run-time `EDGE:0D` come from `okplugin_edge_refused()` at an OKSIGN or OKDECRYPT, not from an OKEDGE request (§9.3).

**HEAD reply** (62 bytes, `cpp:1227-1249`):

| Bytes | Field |
|---|---|
| [0..3] | seq (`0xFFFFFFFF` = empty) |
| [4..35] | head (the genesis while empty) |
| [36..39] | oldest seq still held for PICKUP (`0xFFFFFFFF` = none) |
| [40..55] | 4 live budget ids (0 = none or expired) |
| [56] | held mask: bit i = budget i on hold |
| [57] | owes: 0 or 1 |
| [58] | reserved, 0 |
| [59] | reserved, 0 |
| [60] | refused TX starts since power-up |
| [61] | reserved, 0 |

**Status codes** (`h:39-54`; words in `codes.STATUS`):

| Code | Name | Sent by |
|---|---|---|
| 00 | ok | GRANT_LABEL, REVOKE, HOLD, RESUME, TX_START, WIPE_DEBUG |
| 01 | need PIN | any request without K132; a press without K132 |
| 02 | bad scopes | GRANT_CREATE, GRANT_LABEL |
| 03 | scope not allowed | GRANT_CREATE |
| 04 | too many uses | GRANT_CREATE |
| 05 | four budgets live | GRANT_CREATE at the press |
| 06 | sign failed | CHECKPOINT (and after a budget opens), STATEMENT |
| 07 | no such budget | REVOKE, HOLD, RESUME |
| 08 | nothing owed | RECEIPT, SETTLE |
| 09 | not held | PICKUP |
| 0A | unknown request | `default:` |
| 0B | stale head | GRANT_CREATE, GRANT_RESUME |
| 0C | receipt owed | GRANT_CREATE, GRANT_RESUME, TX_START |
| 0D | nothing to pay | TX_START; a budget-primed request that can no longer pay |
| 12 | bad range | LOSS |
| 1C | TX mismatch | a request that is not the one its TX start was for |


## 12. Security properties and threat model

### 12.1 What is trusted

- **The key's signature, read this session.** A host trusts a copy only as far as the welds reach a head the key stands behind: the genesis, the live HEAD, or a checkpoint whose signature verifies under the Edge public key **read from the key this session**, never one from storage (R27; BLOCKS.md). Nothing "verified" is stored.
- **The key's own facts.** The subject of a self-press is SHA-256 of the bytes the firmware itself primed (`cpp:1026`). The head a receipt answers comes from the key's own record of the owed use (`cpp:1349`). A LOSS vouches for link `to+1` from the key's own memory (`cpp:971-986`). A statement names only the key's own device id, checkpoint key and seq (`cpp:603-610`).
- **The press.** Opening or resuming a budget, settling and accepting a loss need a physical press within the core's wait. On the soft key the press is the keypad in ok-rn.

### 12.2 Attacker on the wire

Any host that speaks to the unlocked key: the agent's computer, or another program on it. Which computers may speak is the app's check (the Bluetooth pairing); the key sees only bytes.

**Cannot:**
- self-press outside a budget, or without a TX start that matches the exact bytes it then submits, over the key's current head (§9.3);
- use a budget for another op, slot or derived identity, past a scope's cap or the budget's total, after its lifetime, or while it is held (§8);
- make a reveal the key has not made (a SHA-256 preimage), or forge a checkpoint or an owner statement (neither key leaves the key, and no firmware request derives them, §6);
- open, resume, settle or accept a loss without a press;
- forge a settle through RECEIPT (flags forced 0, `cpp:1353`);
- forgive a debt: only a receipt or a pressed settle pays one; not a deny, timeout, revoke, lock, reboot or restore (R16; the backup carries the debt and the continue link commits to it);
- grow the chain without a press beyond its budgets: the only links written without a press are budget uses, their receipts, holds, revokes, and the one continue after a restore;
- make Edge ask for a press. The one path that ends in a press prompt is an announced request whose budget lapsed before the sign: it is then the firmware's ordinary request, the person decides, and nothing is linked (§9.3 case 3).

**Can:**
- lie in a receipt. A receipt proves the agent made the claim, not that it is true (RECEIPT-CODES.md);
- hold or revoke budgets (stricter only), refuse to file receipts (which blocks itself), skip PICKUP (the gap shows in `seq`; the key holds only the last 8 links);
- ask for heads, checkpoints, the public key and owner statements at any time, a statement over any nametag hash (the nametag is a label, §7.6); flood TX starts (counted in HEAD byte 60, no link);
- on a **DEBUG** build, erase the whole Edge region, history and debt included, with `WIPE_DEBUG` and **no press** (§12.6).

### 12.3 The phone

The soft key is the OnlyKey firmware running as a process inside ok-rn. Its flash is a file in the app's storage, and its "physical press" is the app's keypad. So:

- ok-rn shows the Yes sheet and takes the press. Malware that controls the app or the phone's OS could approve, and could read K132 from the soft key's memory. The fix for this limit is a trusted display on Edge hardware (not built).
- The record's check bytes are not a MAC. Anyone who can write the flash file can rewrite seq, head or the debt and recompute them. What still holds: every checkpoint already in another copy pins history up to its head, so a rollback contradicts what the others recorded.
- The salt is kept out of Android backup and device transfer by the app, not by the firmware (`cpp:117-119`).

### 12.4 Someone holding a backup

With the backup and its passphrase they hold K132: the derived identities and the owner key. So a device they make from it signs owner statements your devices accept as "made with our key". That is the owner by definition (R29); an unknown device of yours raises the app's LEAK alarm (R30). They do not get the salt: the restored key has a new Edge key and device id, and its continue link carries the debt.

### 12.5 Not on the key

- **Copies and their check.** Storing and verifying copies before a budget is the host's (R27); the key checks only 6 head bytes on GRANT_CREATE and 32 on GRANT_RESUME.
- **Who asks.** The Bluetooth-paired computer, checked by the app; the key never sees an agent identity (R15c retired).
- **Sync and merge** are the app's and the lib's (R30): pairing and sync are app functions, not firmware; the app checks a synced log is complete before merging it.
- **Receipt messages, intent text and nametag text**, and pairing receipts with uses (`receipts.pairReceipts`).
- **The clasp sheet** that names the identity (R11a), and **blocks as JSON** (BLOCKS.md).

### 12.6 Debug-only paths

`WIPE_DEBUG` (0x7E) is the only `#ifdef DEBUG` path in the plugin (`cpp:1293-1303`). `DEBUG` is a `#define` in the firmware's own `onlykey.h`, which the plugin includes; it is not a compiler flag. A production staging (`OKEMU_PRODUCTION=1`, which `release.js` sets) comments it out (`ok-rn/android/okemu/scripts/stage.js:469-493`), and `ok-rn/tools/release-guards.js` guards a release against it, per its header (not reviewed further). In a production build the case does not exist and 0x7E falls to `EDGE:0A`. One more DEBUG-only effect: the firmware's HKDF prints its 33-byte salt to the debug console (`okcrypto_hkdf_info`), so a DEBUG build shows the Edge device salt there.

## 13. Known limits and open items

| Item | State |
|---|---|
| **Hard-key fit.** No free flash sector; the region it uses is the bootloader's on a Teensy (`cpp:26-27`) | open; for the firmware maintainers to decide ([FIRMWARE-RFC.md](https://github.com/bm-ok/onlykey-edge/blob/main/edge/FIRMWARE-RFC.md)) |
| **Size.** Measured 2026-10-10 for a Teensy 3.2: code 7,284 bytes, constants 275, RAM 2,761; the record 208 bytes, twice | [AUDIT.md](AUDIT.md) |
| **Quantum-safe signatures** (hybrid P-256 + ML-DSA-65 on checkpoints and owner statements) | built. Hashes and ML-DSA-65 are quantum-safe; a host keeps the ML-DSA half of its newest checkpoint as the anchor of its copy |
| **The key seals a block itself** (grant-end and checkpoint in one step) | not built; the phone asks for a checkpoint after a budget ends ([BLOCKS.md](BLOCKS.md)) |
| **Composite pairs** (R19) | not built; the second half is an ordinary press |
| **One owed use.** The key keeps one owed use, not a list; the record is 208 bytes; HEAD bytes 58, 59 and 61 are reserved, 0 | built |
| **Agent sign codes in budgets** (201-203, 221-223) | built (R11a) |

## 14. Code vs spec

[SPEC.md](SPEC.md) describes this code as of the hybrid-signature change (ok-rn after `c906e1b`); no difference between them is known. When code and spec disagree, the code is the truth and the spec is fixed.

## 15. Appendix: file and function map

`okplugin_edge.cpp`, in file order, as of the hybrid-signature change.

| Function | What it does | Line |
|---|---|---|
| `owes` | is a use owed? | 131 |
| `derived_code` | 201-203 / 221-223 | 172 |
| `refuse_tx` | count a refused TX start, answer the status | 206 |
| `put32` / `get32` / `put16` / `get16` | little-endian helpers | 261-268 |
| `H` | SHA-256 over a tag and up to three byte strings | 271 |
| `status` | sends `EDGE:xx` | 283 |
| `hash_times` | H^n, the budget series | 289 |
| `reply` | one 64-byte binary report | 297 |
| `reply_seq_head` | `seq · head` | 305 |
| `state_encode` / `state_decode` | the v1 record and its check | 314 / 333 |
| `state_save` | gen++, write the other sector | 353 |
| `hold` | put a link (+ head, reveal) in the held ring | 360 |
| `state_load` | pick the newer valid copy; the clean start | 370 |
| `edge_secret_salted` | HKDF from K132 with a salt and info, ECC globals saved and restored | 397 |
| `edge_key_with` / `edge_private_key` | the Edge private key (R28 salt) | 422 / 431 |
| `mldsa_keypair` | an ML-DSA-65 key pair from its derived seed (checkpoint or owner) | 445 |
| `mldsa_pubkey_reply` | PUBKEY_PQ: the ML-DSA-65 public key | 467 |
| `mldsa_sign_reply` | the ML-DSA-65 signature over a digest | 476 |
| `identity_of` | public key and device id | 493 |
| `write_continue` | R28 continue link onto a new genesis | 516 |
| `ensure_identity` | load, salt, identity, continue, genesis | 535 |
| `checkpoint` | sign (seq, head); two reports | 573 |
| `statement` | the owner statement; three reports | 601 |
| `settle_subject` | R18 subject | 628 |
| `weld_in` | THE weld and the debt rule | 645 |
| `append` / `append_scoped` | build a link at the next seq | 677 / 691 |
| `scope_allowed` | R14 | 716 |
| `alive` | live and not expired (R15b) | 732 |
| `budgets_may_pay` | unlocked, not config, nothing owed | 737 |
| `head_is` | R27 head prefix check | 742 |
| `scope_matches` | op, slot, label (R11a) | 745 |
| `budget_for` | the budget and scope that pay | 752 |
| `any_budget_payable` | for TX_START | 769 |
| `live_budget` |  | 775 |
| `end_budget` | a grant-end link (completed, revoked, settled); the budget cleared | 789 |
| `complete_fulfilled` | after a receipt: end every budget whose uses are all made and paid | 801 |
| `press_drop` / `press_wait` | the press-gated request | 807 / 812 |
| `grant_label` | stage a label | 819 |
| `grant_create` | check, seed, G, wait for the press | 839 |
| `grant_pressed` | open: link, reply, checkpoint | 893 |
| `resume_pressed` | resume link | 932 |
| `settle_pressed` | settle link | 950 |
| `loss_subject` | `to` + 28 bytes of link `to+1` | 971 |
| `loss_pressed` | LOSS link | 995 |
| `okplugin_edge_primed` | hook 3: subject, token check, budget, refusals | 1013 |
| `okplugin_edge_decision` | hooks 4-6: Edge presses, the self-press link | 1075 |
| `okplugin_edge_refused` | hook 4: refuse before anything runs | 1116 |
| `okplugin_edge_wipe` | hook 7, and WIPE_DEBUG | 1142 |
| `okplugin_edge_backup` | the v1 backup section | 1168 |
| `okplugin_edge_restore` | new salt, continue owed | 1191 |
| `okplugin_edge_recv` | hook 2: the OKEDGE dispatcher | 1220 |

**Other files:** `okplugin_edge.h` (sub-ops `h:17-35`, status codes `h:39-54`, the public hook functions `h:62-73`); `plugin.js` (the eight hooks, `backup: true`); `tools/measure-size.sh` (the size measurement); `tests/kit.test.js` and `tests/e2e.js` (the plugin's tests; not run or read for this paper). Host counterparts: `edge/plugin/index.js` (the `SUB` table and how each reply is read), `chain.js` (link, weld, genesis, continue subject, verify, checkpoint), `grants.js` (series, grant subject, TX token, intent, verifyBudgetOpening, nametag and statement), `receipts.js` (receipt and settle subjects, the debt replay), `codes.js` (op, decision, flag, tag, receipt and status numbers).
