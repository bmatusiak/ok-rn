# OnlyKey Edge: blocks, sync and the testnet

The model behind Edge, and how the build meets it. Checked against the code on 2026-10-10. Budgets, exec and the phone's sheets: APP.md. The key's rules: the firmware whitepaper (ok-rn `android/okemu/plugins/edge/WHITEPAPER.md`).

**The picture:**
- Links are called transactions.
- Each transaction happens in a budget.
- A group of budgets is a block.
- Each device generates a block before it syncs.
- A block is identified by the hash of a JSON document.
- Uses always count up, as with HOTP; time, as with TOTP, is only for expiry.
- Each transaction has a receipt.
- Each key is a fork, and can merge into the chain.
- Budget or no go.

**Further principles:**
- Only new data is verified.
- The chain's data is kept as JSON blocks, not as one JSON document per transaction.
- The chain starts clean for three things: JSON blocks, the split between live and test, and version 1 of the protocol and schema.
- A checkpoint is taken when a budget grant ends, as the end of that block of transactions.

## 1. The words

| Term | What it is in the build |
|---|---|
| **Transaction** (TX) | one budget use: a TX start announced to the key, the sign, then its receipt; one link, paid by a budget |
| **Budget** | opened on the phone with Yes and a press: what may be used, how many times, until when; held, resumed, revoked or settled; it completes itself when its last use is receipted |
| **Receipt** | the result of one transaction, a link of its own (RECEIPT-CODES.md) |
| **Block** | the links between two seals; a seal is a checkpoint the key signs over its head, taken when a budget has ended; the links after the newest seal are the **open block** |
| **Fork** | one device's own chain: its own salt, device id and genesis |
| **Merge** | another device's log, brought by a computer, held on the phone until the person approves it; no press and no link on the key |
| **Nametag** | a device's own name for its fingerprint, signed with the owner key every device made from the same backup shares |

## 2. How the picture is met

- **Each transaction happens in a budget.** The key links a sign or decrypt only when a live budget pays it. Anything else is refused, and Edge never asks for a press. An ordinary ssh or gpg press is not Edge and writes no link.
- **Count up:** a budget's uses are numbered 1, 2, 3 … up to its cap; a hash chain proves each, checkable without a secret (stronger than HOTP).
- **Expiry:** a lifetime runs on the key's own clock since power-on, which nothing outside can turn back; a reboot ends it (TOTP's job, with no clock to set).
- **Each transaction has a receipt, in order:** no TX start while a receipt is owed; each use takes exactly one receipt and is spent once.
- **A block per budget.** The key ends a budget with a grant-end link whose decision byte says how: 1 completed (its last use was receipted and nothing else is owed; a fulfilled budget completes itself), 2 revoked, 3 settled. Expiry and a lock or reboot write no link. After the phone sees a budget end, its next sync asks the key for a checkpoint over the head it just verified and keeps it as a seal: that budget's block is closed.
- **Each key is a fork, and merges** into your other devices once you approve its log (§4).

## 2a. Verify only the new stuff

The phone's copy is untrusted, and its check must not grow with the chain. Each session:

1. **Sealed blocks are re-welded, not re-checked.** The phone hashes its stored links up to the newest seal and checks **the key's P-256 signature** on it (older seals keep only that half), with the public key it reads **from the key this session** (never one from storage). An edit anywhere in a sealed block breaks the hash: red. Cost: hashing only.
2. **Only the open block gets the full checks** (openings, reveals, receipts, welds onto the sealed head).
3. **Anything that does not fit falls back to the full check from genesis:** no seal, the hash does not reach it, a gap, a red verdict, a copy changed under the same head.
4. **Nothing "verified" is stored.** Only the key's signatures carry over, checked again every session. The copy is verified only when it welds up to the newest checkpoint and both of that checkpoint's signatures (P-256 and ML-DSA-65) verify: one hybrid anchor per copy.
5. **The key signs a checkpoint only when one is used:** the first check of a session, a check that was not clean, and a seal. A sync that checks only new links on a verified copy is anchored by the head it just read. (A checkpoint at every sync costs 0.4-1 s per sync on a phone, up to 4.5 s in a burst.)

The condition of a full check from genesis at app start holds here too: an edit to the stored copy without the head moving turns red, because the signed hash no longer matches. Only the cost differs: on a phone the full check takes 10.3 s of a 12.3 s sync, on the thread that answers Bluetooth.

## 3. What a block looks like

**Blocks are the chain's data, in JSON.** The key is unchanged: it keeps its 64-byte links and signs a checkpoint over its head. A host writes each block - the links between two seals - as one canonical JSON document, and **the block's id is the SHA-256 of it**. Transactions are not JSON on the key, and are not written as JSON one by one: the block is the JSON unit.

- **Canonical JSON:** RFC 8785 kept to a strict subset - objects with ASCII keys (sorted), arrays, safe integers, printable-ASCII strings, true/false/null; anything else is refused. Within it, RFC 8785 equals Python's `json.dumps(sort_keys=True, separators=(",", ":"))`.
- **Each link is written as its fields** (the 64-byte layout), so it reads plainly and re-encodes to the exact bytes; a link whose bytes its fields cannot carry is refused. `op` is the op's name in lower case (`sign`, `grant_create`, `grant_end`, `receipt`, `loss` …).
- **The same everywhere:** `vectors/make_block_vectors.py` (Python stdlib) writes `vectors/block-v1.json`; node-onlykey-lib must match its bytes and id.
- Built in node-onlykey-lib `edge/src/block.js` (`canonical`, `buildBlock`, `blocksFrom`, `blockId`, `verifyBlock`); shown by `onlykey-js edge blocks [--json]` from the computer's copy and the seals the phone gave it; exported from the Edge tab (Edge Management → Blocks → **Export blocks**).

```json
{ "v": 1, "net": "live", "device": "<device id, hex>", "prev": "<previous block's id> | null",
  "start": { "seq": 0, "head": "<the head before the first link: genesis or the previous seal>" },
  "links": [ { "seq": 1, "op": "sign", "decision": 4, "slot": 201, "flags": 16, "subject": "<hex>",
               "grant": 12, "step": 1, "scope": 1, "intent": "<hex> | null", "v": 1 } ],
  "checkpoint": { "seq": 4, "head": "<hex>", "sig": "<the key's signature, hex>" } }
```

Anyone can check a block with SHA-256 and the device's Edge public key (read from the key): the links re-encode and weld from `start` (its seq is the first link's) to `checkpoint.head`, the signature verifies, `prev` is the id of the block before, and the first block starts at genesis. Who made a block is its device id; that it was made with YOUR OnlyKey is the device's owner statement, which travels with its log (§4). Only a copy whole from its chain's start gives blocks; with the clean start every copy is.

## 4. Sync between your devices

Sync is the app's, never the key's: no press, no link. Pairing and sync are app functions, not firmware. A device made from the same backup signs an owner statement that verifies under the owner key, so it is one of the user's own devices and its log is kept. Only a computer paired with the phone over Bluetooth can sync with it, inside that pairing's encrypted session (APP.md §1).

**One phone at a time.** `onlykey-js edge sync [--status]` works with the one phone the computer is connected to. The computer relays: it keeps a copy of each device's chain in its Edge home and brings each phone the others' logs.

| Step | Messages | What moves |
|---|---|---|
| 1 | the key's own reads | the key's links into the computer's copy (no press); `--status` stops here |
| 2 | `GIVE` | only when the computer's copy has a gap: the phone's copy of its own chain fills it, checked against the key |
| 3 | `HAVE`, `LINKS`, `COMMIT` | only from a computer copy that verifies (a gap allowed): the phone's **own** links it lacks |
| 4 | `GIVE` past the end | the phone's seals, its owner statement, its budgets' opening words and its notes; with a checkpoint from the key, kept as that phone's log |
| 5 | `HAVE`, `LINKS`, `OFFER` | every **other** device's log the computer holds |

Each message is signed by the computer's own sync key with a fresh nonce; links go 40 to a message.

**Own links merge direct.** They are the phone's own key's, so they merge at once after a check. A link that differs from one the phone holds is a fork: nothing is taken and the computer is told. A merge that would leave the copy unverified takes nothing (`copy_unverified`).

**Other devices' logs are held** in the app until approved and merged. A log is that device's links up to its key's signed checkpoint, its owner statement, its openings and its notes. The phone keeps it apart, merges nothing and shows no sheet; an offer older than the one held is not kept. A banner on the Edge tab says who wants to merge what - "{computer} wants to merge a unknown backup device {device_name}", "… wants to merge new blocks from <nametag>", "… sent a log not made with your OnlyKey" - and opens the **MergeSheet**.

**Sorted by your owner key** (`devices.classify`). The key signs its owner statement itself (Edge sub-op 0x06, no press, no link): device id, checkpoint key, seq and the nametag's hash, signed with the owner key all devices from one backup share.

| Class | Means | MergeSheet |
|---|---|---|
| mine-known | your owner key, a device you have | **Approve - merge** / **Decline** |
| mine-new | your owner key, a new fingerprint | "A device made with your OnlyKey appeared. Is it yours?" **Yes, it's mine - merge** / **No** (the alarm "Edge: someone else holds your OnlyKey"; the log kept as evidence) |
| forged | not your owner key, or not the key that signed the chain | never merged: **Keep as evidence** |

**Re-verified under its own key:** incoming data is verified again before it merges: the checkpoint's signature by that device's key (`bad-checkpoint`), no head older than one merged before (`rollback`), no changed head at a seq merged before (`changed`), every weld up to the checkpoint (`tampered`). A log that fails is kept, never merged.

**Complete before it merges.** Synced data is validated without shortcuts before it merges into another store, and a store holds everything about each use of the credential, including its result. `devices.completeness` checks what the phone would hold after the merge against the chain: every budget's opening words, proved against its grant-create link and the key's signature; every intent's text, matching its link; every owed use's result - a receipt whose message matches its hash, or a settle. A use still waiting, unreceipted or with an alarm receipt is not complete. Else "Not complete - nothing merged", with the reasons.

**After the merge** the phone keeps that device's links, the checkpoint merged up to, its openings, notes and seen times (its own clock), so its log reads the same on every device. Its own view (ok-rn `deviceView`) is checked under its key from its last merged checkpoint; its budgets show as full cards in Past budgets, its links in Presses.

**Nametags.** The highest-seq signed statement names a device; older ones are its history, so one fingerprint has one name, never "unknown". A phone with no nametag signs its device name the first time one is needed; the device name is the default until a nametag is entered in the nametag input. A key with a new chain (reset or restored) signs its nametag again. At most 64 characters.

**The Key Chain list is not part of Edge's sync.** The phone refuses Key Chain parts in an Edge sync; the computer does not send them.

**Log recovery.** A copy is rebuilt backward from the key's HEAD: the check welds forward and back from every point the key stands behind - genesis, its live HEAD, every checkpoint its public key verifies - so a gap is only what none of them reaches. A missing range comes from any copy that holds it: the phone's from a computer (step 3), the computer's from the phone (step 2), another device's from whoever holds it. A merge adds only missing links, so a log or range that turns up later still merges, as long as it agrees with what is held. A range nobody holds stays a gap until **Accept loss of #A–#B** and a press write a LOSS link (APP.md §5).

## 5. Live and test chains - an Edge testnet (built)

The CLI's `--test-mode` is Edge's testnet, and the app's testing mode is its trigger, so live and test are kept apart the way Bitcoin keeps its testnet apart. Edge test mode uses its own chain: its files are separate from the live ones, and everything on the testnet is throwaway. The testnet runs on its own storage slot: `firmware.start(testmode ? testStorageSlot : storageSlot)`. A build without testing mode starts the firmware at launch; in a build with testing mode the login screen starts it from the login or testing-mode button.

- **A separate, throwaway soft key** (rather than two chains in one key): the same firmware on its own storage slot (`testStorageSlot` = the build's slot + `-test`), with its own flash and EEPROM, so its own private keys, salt, device id, genesis and chain. Live and test cannot mix; the firmware needs no change.
- **The trigger:** a build with testing mode does not start the soft key at launch. **Log in** starts it on the live slot, **Enter testing mode** on the testnet's. A release build starts on the live slot. A started firmware cannot change storage, so switching restarts the app.
- **Stored apart on the phone:** every Edge record under its net's prefix (`okrn.edge.` / `okrn.edge.test.`), and the Key Chain list too (`okrn.keychain.test.list`).
- **The computer:** `onlykey-js edge --test-mode …` has its own home (`~/.onlykey-js/edge-test`) and Key Chain file (`keychain-test.json`). Every Edge wire message names its net (none counts as live). The phone answers a message for the other chain with `net` before it reaches Edge (after the encrypted-session check), and the CLI refuses an answer from the other chain: "this phone is on the live chain - drop --test-mode" / "… on the testnet - add --test-mode".
- **Clearable:** the testnet's storage is separate on both the phone and the CLI, so it can be cleared. Testing tab → Testnet → **Clear testnet** restarts the app and clears at the next launch, before any soft key starts: the testnet's slot (refused natively for any other), every `okrn.edge.test.*` record and its Key Chain list. `onlykey-js edge --test-mode clear` removes the computer's testnet home and Key Chain file, and is refused without `--test-mode`. The live key is never touched.
- **Marked everywhere:** a TESTNET banner on every screen, TESTNET on the request and press sheets, "TESTNET · " on every Edge notification, and the CLI's first line ("edge: TESTNET - the test chain (…)"). Blocks carry `"net"`.
- **Automation:** scripts may approve and press testnet budgets; the live chain stays the person's.
