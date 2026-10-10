# OnlyKey Edge: blocks, sync and the testnet

Brad's picture of Edge in his words, and how the build meets it. Checked against the code on 2026-10-10. Budgets, exec and the phone's sheets: APP.md. The key's rules: the firmware whitepaper (ok-rn `android/okemu/plugins/edge/WHITEPAPER.md`).

**Brad's picture (2026-10-06, his words):**
- "we can call links transactions"
- "each transaction happens in a budget"
- "a group of budgets is a block"
- "each device before sync generates a block"
- "we use hash of a json"
- "we count up with htop always, totp is for expirations"
- "each transaction has a receipt"
- "each key is a fork, and can merge into the block chain"
- "budget or no go"

**Added 2026-10-07 (his words):**
- "we only need to verify the new stuff" (his original request, restated 2026-10-07)
- "i believe i wanted the block chain data to be in json"; on JSON blocks, not JSON transactions: "that is actually what i was wanted and what i was talking about"; "i dont want every transaction"
- Why the clean start: "1, blockchain json 2. test-mode split 3. v1 on the protocal/schema version"
- "maybe checkpoints can happen on a budget grant end, like it's the end of the block of transactions"

## 1. The words

| Brad's word | What it is in the build |
|---|---|
| **Transaction** (TX) | one budget use: a TX start announced to the key, the sign, then its receipt; one link, paid by a budget (Brad, 2026-10-06: "arm is now a transaction", "short hand is TX for transaction") |
| **Budget** | opened on the phone with Yes and a press: what may be used, how many times, until when; held, resumed, revoked or settled; it completes itself when its last use is receipted |
| **Receipt** | the result of one transaction, a link of its own (RECEIPT-CODES.md) |
| **Block** | the links between two seals; a seal is a checkpoint the key signs over its head, taken when a budget has ended; the links after the newest seal are the **open block** |
| **Fork** | one device's own chain: its own salt, device id and genesis |
| **Merge** | another device's log, brought by a computer, held on the phone until the person approves it; no press and no link on the key |
| **Nametag** | a device's own name for its fingerprint, signed with the owner key every device made from the same backup shares (Brad, 2026-10-08: "name is vague, lets call it nametag") |

## 2. How the picture is met

- **Each transaction happens in a budget.** The key links a sign or decrypt only when a live budget pays it. Anything else is refused, and Edge never asks for a press. An ordinary ssh or gpg press is not Edge and writes no link.
- **Count up:** a budget's uses are numbered 1, 2, 3 … up to its cap; a hash chain proves each, checkable without a secret (stronger than HOTP).
- **Expiry:** a lifetime runs on the key's own clock since power-on, which nothing outside can turn back; a reboot ends it (TOTP's job, with no clock to set).
- **Each transaction has a receipt, in order:** no TX start while a receipt is owed; each use takes exactly one receipt and is spent once.
- **A block per budget.** The key ends a budget with a grant-end link whose decision byte says how: 1 completed (its last use was receipted and nothing else is owed; Brad, 2026-10-10: "budgets should auto complete once fufilled"), 2 revoked, 3 settled. Expiry and a lock or reboot write no link. After the phone sees a budget end, its next sync asks the key for a checkpoint over the head it just verified and keeps it as a seal: that budget's block is closed.
- **Each key is a fork, and merges** into your other devices once you approve its log (§4).

## 2a. Verify only the new stuff (Brad's rule, 2026-10-07)

The phone's copy is untrusted, and its check must not grow with the chain. Each session:

1. **Sealed blocks are re-welded, not re-checked.** The phone hashes its stored links up to the newest seal and checks **the key's signature** on it, with the public key it reads **from the key this session** (never one from storage). An edit anywhere in a sealed block breaks the hash: red. Cost: hashing only.
2. **Only the open block gets the full checks** (openings, reveals, receipts, welds onto the sealed head).
3. **Anything that does not fit falls back to the full check from genesis:** no seal, the hash does not reach it, a gap, a red verdict, a copy changed under the same head.
4. **Nothing "verified" is stored.** Only the key's signature carries over, checked again every session.
5. **The key signs a checkpoint only when one is used:** the first check of a session, a check that was not clean, and a seal. A sync that checks only new links on a verified copy is anchored by the head it just read. (A checkpoint at every sync cost 0.4-1 s a sync on the Pixel, up to 4.5 s in a burst.)

This replaced "app start: one full check from genesis" (2026-10-06). Its condition still holds: an edit to the stored copy without the head moving turns red, because the signed hash no longer matches. Only the cost changed: on a Galaxy A13 the full check took 10.3 s of a 12.3 s sync, on the thread that answers Bluetooth (2026-10-07).

## 3. What a block looks like

**Blocks are the chain's data, in JSON** (Brad, 2026-10-07). The key is unchanged: it keeps its 64-byte links and signs a checkpoint over its head. A host writes each block - the links between two seals - as one canonical JSON document, and **the block's id is the SHA-256 of it**. Transactions are not JSON on the key ("i dont want every transaction").

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

Anyone can check a block with SHA-256 and the device's Edge public key (read from the key): the links re-encode and weld from `start` (its seq is the first link's) to `checkpoint.head`, the signature verifies, `prev` is the id of the block before, and the first block starts at genesis. Who made a block is its device id; that it was made with YOUR OnlyKey is the device's owner statement, which travels with its log (§4). Only a copy whole from its chain's start gives blocks; since the clean start every copy is.

## 4. Sync between your devices

Sync is the app's, never the key's: no press, no link (Brad, 2026-10-08: "pairing and sync is all app stuff, not firmware"; "if it has the private ecc key to sign the block, then i want the log"). Only a computer paired with the phone over Bluetooth can sync with it, inside that pairing's encrypted session (APP.md §1).

**One phone at a time** (Brad, 2026-10-08: "sync should only be 1 device at a time"). `onlykey-js edge sync [--status]` works with the one phone the computer is connected to. The computer relays: it keeps a copy of each device's chain in its Edge home and brings each phone the others' logs.

| Step | Messages | What moves |
|---|---|---|
| 1 | the key's own reads | the key's links into the computer's copy (no press); `--status` stops here |
| 2 | `GIVE` | only when the computer's copy has a gap: the phone's copy of its own chain fills it, checked against the key |
| 3 | `HAVE`, `LINKS`, `COMMIT` | only from a computer copy that verifies (a gap allowed): the phone's **own** links it lacks |
| 4 | `GIVE` past the end | the phone's seals, its owner statement, its budgets' opening words and its notes; with a checkpoint from the key, kept as that phone's log |
| 5 | `HAVE`, `LINKS`, `OFFER` | every **other** device's log the computer holds |

Each message is signed by the computer's own sync key with a fresh nonce; links go 40 to a message.

**Own links merge direct.** They are the phone's own key's, so they merge at once after a check. A link that differs from one the phone holds is a fork: nothing is taken and the computer is told. A merge that would leave the copy unverified takes nothing (`copy_unverified`).

**Other devices' logs are held** (Brad, 2026-10-08: "we should hold these blocks in the app until approved and merged"). A log is that device's links up to its key's signed checkpoint, its owner statement, its openings and its notes. The phone keeps it apart, merges nothing and shows no sheet; an offer older than the one held is not kept. A banner on the Edge tab says who wants to merge what - "nitro16 wants to merge a unknown backup device Pixel" (Brad, 2026-10-08: "the banner should say {computer} wants to merge a unknown backup device {device_name}"), "… wants to merge new blocks from <nametag>", "… sent a log not made with your OnlyKey" - and opens the **MergeSheet**.

**Sorted by your owner key** (`devices.classify`). The key signs its owner statement itself (Edge sub-op 0x06, no press, no link): device id, checkpoint key, seq and the nametag's hash, signed with the owner key all devices from one backup share.

| Class | Means | MergeSheet |
|---|---|---|
| mine-known | your owner key, a device you have | **Approve - merge** / **Decline** |
| mine-new | your owner key, a new fingerprint | "A device made with your OnlyKey appeared. Is it yours?" **Yes, it's mine - merge** / **No** (the alarm "Edge: someone else holds your OnlyKey"; the log kept as evidence) |
| forged | not your owner key, or not the key that signed the chain | never merged: **Keep as evidence** |

**Re-verified under its own key** (Brad, 2026-10-09: "the incoming data must be re-verified"): the checkpoint's signature by that device's key (`bad-checkpoint`), no head older than one merged before (`rollback`), no changed head at a seq merged before (`changed`), every weld up to the checkpoint (`tampered`). A log that fails is kept, never merged.

**Complete before it merges** (Brad, 2026-10-09: "dont use shortcut to validate syncd data, before mergering into another data store"; "a data store must contain all info about the usage of the credental, including the result"). `devices.completeness` checks what the phone would hold after the merge against the chain: every budget's opening words, proved against its grant-create link and the key's signature; every intent's text, matching its link; every owed use's result - a receipt whose message matches its hash, or a settle. A use still waiting, unreceipted or with an alarm receipt is not complete. Else "Not complete - nothing merged", with the reasons.

**After the merge** the phone keeps that device's links, the checkpoint merged up to, its openings, notes and seen times (its own clock), so its log reads the same everywhere (Brad, 2026-10-09: "all the data i see on the a13 should be just like on the pixel"). Its own view (ok-rn `deviceView`) is checked under its key from its last merged checkpoint; its budgets show as full cards in Past budgets, its links in Presses.

**Nametags.** The highest-seq signed statement names a device; older ones are its history, so one fingerprint has one name, never "unknown". A phone with no nametag signs its device name the first time one is needed (Brad, 2026-10-08: "use device name as default unless explicitly changed there in nametag input"). A key with a new chain (reset or restored) signs its nametag again. At most 64 characters.

**The Key Chain list is not part of Edge's sync** (Brad, 2026-10-08: "Move it out of Edge"). The phone refuses Key Chain parts in an Edge sync; the computer does not send them.

**Log recovery.** A copy is rebuilt backward from the key's HEAD: the check welds forward and back from every point the key stands behind - genesis, its live HEAD, every checkpoint its public key verifies - so a gap is only what none of them reaches. A missing range comes from any copy that holds it: the phone's from a computer (step 3), the computer's from the phone (step 2), another device's from whoever holds it. A merge adds only missing links, so a log or range that turns up later still merges, as long as it agrees with what is held. A range nobody holds stays a gap until **Accept loss of #A–#B** and a press write a LOSS link (APP.md §5).

## 5. Live and test chains - an Edge testnet (Brad, 2026-10-07; built)

**Brad's words:** "we should treat --test-mode as test net for cli for edge; the app has 'test mode', so that can be used for the trigger; so have it where we can separate live from test like how bitcoin does"; "for edge test mode, it can use different blockchains between"; "--test-mode where edge blockchain files are seperated from live and test (like how bitcoin does it) so it seperated, and everthing for test is throwaway"; on how: "technically we change the storageSlot then for testnet" - "firmware.start(testmode ? testStorageSlot : storageSlot)"; on starting: "auto start firmware should be on if test mode is not built into the app; if testing mode is built in, auto start is disabled, so the login screen will need to start the firmware if i click login or testing mode button".

- **A separate, throwaway soft key** (Brad chose this over two chains in one key): the same firmware on its own storage slot (`testStorageSlot` = the build's slot + `-test`), with its own flash and EEPROM, so its own private keys, salt, device id, genesis and chain. Live and test cannot mix; the firmware needs no change.
- **The trigger:** a build with testing mode does not start the soft key at launch. **Log in** starts it on the live slot, **Enter testing mode** on the testnet's. A release build starts on the live slot. A started firmware cannot change storage, so switching restarts the app.
- **Stored apart on the phone:** every Edge record under its net's prefix (`okrn.edge.` / `okrn.edge.test.`), and the Key Chain list too (`okrn.keychain.test.list`).
- **The computer:** `onlykey-js edge --test-mode …` has its own home (`~/.onlykey-js/edge-test`) and Key Chain file (`keychain-test.json`). Every Edge wire message names its net (none counts as live). The phone answers a message for the other chain with `net` before it reaches Edge (after the encrypted-session check), and the CLI refuses an answer from the other chain: "this phone is on the live chain - drop --test-mode" / "… on the testnet - add --test-mode".
- **Clearable** (Brad: "test-mode can help separate the storage side too, both phone and cli, so it can be cleared"): Testing tab → Testnet → **Clear testnet** restarts the app and clears at the next launch, before any soft key starts: the testnet's slot (refused natively for any other), every `okrn.edge.test.*` record and its Key Chain list. `onlykey-js edge --test-mode clear` removes the computer's testnet home and Key Chain file, and is refused without `--test-mode`. The live key is never touched.
- **Marked everywhere:** a TESTNET banner on every screen, TESTNET on the request and press sheets, "TESTNET · " on every Edge notification, and the CLI's first line ("edge: TESTNET - the test chain (…)"). Blocks carry `"net"`.
- **Automation:** scripts may approve and press testnet budgets; the live chain stays the person's.
