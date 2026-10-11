# edge: why it is built this way

What the plugin does, byte by byte: `AUDIT.md` and the whitepaper
([WHITEPAPER.md](WHITEPAPER.md)). This file holds only the reasons.

## 1. The key is a notary

The host - the library and the app - does the work: it stores the chain, verifies it, pairs uses
with their receipts, syncs devices and draws the screens. The key does only what a host cannot be
trusted to do, from facts it sees itself:

- **the weld.** Every Edge record is hashed onto the previous head, so one head pins the whole
  history, and a host that drops or edits a link is caught by the next checkpoint;
- **the budget decision.** Only the key decides that a sign or decrypt runs without a press, and
  only inside a budget the person opened with a press;
- **one signature.** A checkpoint over (seq, head) with a key no other request reaches, so a host
  can prove its copy is the key's;
- **the debt.** The key itself remembers the use that owes a receipt, so a host cannot quietly
  skip it. Nothing starts while it is owed, so there is only ever one.

Everything else stays off the key: the smallest firmware addition, because a hard key has little
room left.

## 2. Why a budget is a hash series

A budget of n uses commits to `G = H^n(seed)` at the press; use i reveals `v_i = H^(n-i)(seed)`.
Anyone can check a use against G, nobody without the seed can make the next value, and the key
needs to keep only the seed in RAM - no list of allowed uses. The seed dies with the budget.

## 3. Why a TX start

A use runs without a press, so the key must know it is the request the agent meant. The agent
announces it first: a token over the key's own head, the exact bytes it will submit and its
intent. The key checks it when the request arrives. Another program that slips in, or a request
after the chain moved, does not match and is refused - never pressed, never linked. One hash
checks both "nothing happened in between" and "this is the request announced", and it fits in
one report.

## 4. Why only budget uses are linked

A press is the person's own decision, as on any OnlyKey; Edge adds nothing to it. Linking
ordinary presses would let any host fill the chain and wear the flash, and would make a press
look like an Edge record. So the chain holds Edge's own records only: budgets opened and ended,
holds and resumes, uses, receipts, settles, losses, continues.

## 5. Why a budget ends itself, and why a settle ends it

A budget whose uses are all made and receipted is finished; ending it on the key means no host
has to remember to, and a spent budget never sits live until it expires. A settle clears a debt
nobody will receipt; if the budget went on paying after it, a press would let an agent past its
receipts - so a settle ends every live budget, and more work takes a new budget and a new press.
The end link says which happened: completed, revoked or settled.

## 5a. Why two signatures

Hashes stay safe against a quantum computer; P-256 signatures do not. So each signature Edge
makes - a checkpoint, an owner statement - has an ML-DSA-65 signature beside it over the same
digest, and a host requires both: if either algorithm holds, the pair holds. ML-DSA-65 because the
3.1.0 firmware already carries it (the composite PGP slots), so the plugin adds only the calls.
The keys are derived like the P-256 ones, so nothing new is stored, and a restore makes new ones.

A host keeps the ML-DSA half only for the newest checkpoint of its copy. The links below it are
welded by hashes up to that head, so one hybrid checkpoint authenticates the whole copy; older
checkpoints keep their P-256 signature, which is small. This keeps a sync message about 20 KB.

## 6. Why a restore is a new device

A backup restored anywhere - another phone, or the phone that made it - could otherwise write a
second history under the same device id. So the Edge key is salted per device, the salt never
leaves it, and a restore draws a new one: a new device id, a new genesis, and a first link
(continue) that names the chain it came from and carries its debt, if any. The log goes on; it never
starts from zero, and no device ever writes another's chain.

## 7. Backup and restore: one section, last

**For every plugin:** a plugin backs up its important bits, and production hard keys on older
firmware are never affected. Hard keys have no plugins, so a backup made **by** a hard key never
changes. The case to protect is a soft-key backup restored **onto** an older hard key (v3.0.4,
the compatibility target).

**How restore walks a backup** (the 3.1.0 tree and v3.0.4 match line for line): the firmware
decrypts the backup and walks its records - `0xFF` slot fields, `0xFE` keys / authenticator state
/ resident keys, `0xFD` legacy U2F. **Any other first byte ends the walk**, with everything before
it already applied, and the firmware still reports "Successfully loaded backup".

**So: one plugin section, last in the backup.**
- It starts with `0xFB` (no firmware uses that byte), after the last `0xFE` record. Older firmware
  stops there with everything else restored.
- Then one entry per plugin: name length (u8) · name · data length (u16 LE) · data.
- A plugin-aware restore hands each entry to its plugin, and skips, by length, a plugin it doesn't have.
- It is inside the backup's encryption and its digest, so the same backup key protects it and the
  host's integrity check covers it.
- It is written and read by the loader's generic plugin-backup hook (`node-onlykey-lib/cli/firmware-plugins.js`), not by Edge.

**Size:** a backup is capped at 18,000 bytes (the backup array and the restore buffer, both
versions); a full key is about 16.7 KB. All plugins together get a fixed 512 bytes, and the hook
refuses to write past 18,000. Edge's entry is 54 bytes, or 90 with a debt.
