# OnlyKey Edge: decisions

This file holds every decision about OnlyKey Edge, with its date, in the words of the people who made it. Brad is the owner. Tim is the OnlyKey firmware maintainer. The other Edge files describe only the system as it is now; the history and the reasons live here. Quotes are verbatim, spelling kept. Where a source is named ("from 2-DESIGN", "build/firmware"), it is one of the files the 2026-10-10 cleanup removed; git history keeps them.Where a rule was the build session's (Claude's) design or reading and not Brad's words, it says so. A decision that a later one replaced stays here, marked **Superseded**.

---

## 1. The idea and the name

- **The name is OnlyKey Edge** (it was "OnlyKey MCP"). Tim, 2026-09.
- **What Edge is, in Tim's words.** Tim (undated, from 2-DESIGN.md): "a feature that lets the CLI + USB security key approve credential requests."
- **Edge is serverless: no GUN, no Tor, no OnlyKey-hosted node.** Tim, 2026-10. The cloud side was to be the user's own Cloudflare. Tim (undated, from build/copies.md): "the user will set up cloudflare mcp for right now"; "I may add other options later".
- **Unplug and it stops.** The key's presence is the consent window: nothing keeps working once the key is unplugged, locked or the soft key stops. Brad, 2026-10-02: "the whole point is, if I unplug, it stops".
- **Local-only works.** No cloud service is ever required. Brad, 2026-10-04: "air-gap style".
- **Every way to use Edge is written down with what keeps it safe.** Brad, 2026-10-03: "write up each scenario so it can be used in any way that is secure and safe".
- **Brad's picture of Edge, in his words.** Brad, 2026-10-06: "we can call links transactions"; "each transaction happens in a budget"; "a group of budgets is a block"; "each device before sync generates a block"; "we use hash of a json"; "we count up with htop always, totp is for expirations"; "each transaction has a receipt"; "each key is a fork, and can merge into the block chain"; "budget or no go". The mapping of "count up" onto the hash chain and of "expirations" onto the key's own clock is the spec session's, not Brad's.
- **Budgets are blocks of transactions with receipts.** Brad, 2026-10-08: "receipts is what i wanted to replace tickets with, and budgets are blocks of transactions with receipts".
- **Edge is a plugin, built on Rectify.** All of Edge lives in one folder of the library; the core never requires it. Brad, 2026-10-07: "rectify i love it, its my go to".
- **Edge from an app uses the library directly.** apk-signer is the first such app. Brad, 2026-10-02: "developers use the lib directly in their apps".
- **The rules live beside the firmware code.** The whitepaper, SPEC, BLOCKS, RECEIPT-CODES, LATER and DECISIONS moved from onlykey-edge into ok-rn `android/okemu/plugins/edge/`, next to AUDIT.md and DESIGN.md; onlykey-edge keeps the index, EXPLAINED, APP, CLI, the RFC, the vectors and the feature specs. Brad, 2026-10-10: "lets move the whitepaper to the firmare ssource next to the other docs"; then, of SPEC, BLOCKS, RECEIPT-CODES, LATER and DECISIONS: "moveds these next to where we moved whitepaper file".
- **The first real use is Brad's daily loop.** Brad, 2026-10-02: "my daily loop, it's measurable against today's transcript".

## 2. Budgets

- **Budget or no go.** Nothing goes on the chain without a budget behind it; Edge never asks for a press. Brad, 2026-10-06: "budget or no go"; "if the ai wanted me to press a button it should use ssh or gpg agent".
- **What "budget or no go" means, and what it does not.** It means only that nothing goes on the chain without a budget behind it. Brad, 2026-10-08: "the AI wanted to fix the chain with a feature i never asked for"; "we are still developing, not fixing".
- **A link only for a press, or for a use or end of a budget the person approved.** Brad, 2026-10-08: "no unattended press, unless its an approved budget that can be logged into the blockchain"; "i dont want the firmware to just sign anything".
- **A budget opens with Yes in the app and a press on the key** (the clasp), the same for hard and soft key. Brad (undated, from 2-DESIGN.md; Tim to confirm).
- **Only a pressed approval opens a budget; a declined or timed-out ask writes nothing.** Brad, 2026-10-08: "i dont want the firmware to just sign anything". **Superseded** 2026-10-08: the 2026-10-06 rule that declined or timed-out budget opens are linked. firmware.md notes that the 2026-10-06 attribution had no words of Brad's behind it.
- **Budgets hold up to 1024 uses.** Brad, 2026-10-02 (no quote): back from 255, which is too few once ssh to the VM and the Pi is in the daily loop.
- **At most 300 uses per budget, sizes proposed per request.** Brad, 2026-10-03: "we'll see how it feels". The sheet shows every number before the press.
- **A work budget and a release budget, kept apart.** Brad, 2026-10-03 (no quote).
- **Derive and shared-secret operations are never in a budget.** Brad (undated, from 2-DESIGN.md).
- **Budgets have a lifetime; 12 hours by default.** Brad, 2026-10-02 (no quote): long enough to step away for lunch and come back to the same budget. The gap it closes, as firmware.md quotes it: "a budget lives as long as the key stays unlocked". **Superseded** 2026-10-02: the first design, where a budget had no time limit and ended only at lock, reboot or revoke.
- **Hold and resume.** In the app the person can hold a budget for checking (no press) and resume it (a press). Brad, 2026-10-02 (no quote).
- **Continue after a lock.** A budget ended by a lock or reboot can be continued with the uses and time it had left, never more. Brad, 2026-10-02: "a continue budget when I get back, on the phone press".
- **Only an ended budget can be continued.** Decided 2026-10-03, after a live test where both stayed open and the key paid from the old one (the build session's finding; no quote).
- **A budget is still active while a receipt is owed.** Brad, 2026-10-05: "it's still active if a ticket is owed".
- **Ended budgets keep their card and final counts, never 0.** Brad, 2026-10-05 (no quote).
- **Only an End asked for is linked; a lock or reboot ends budgets silently.** Brad, 2026-10-08: "no unattended press, unless its an approved budget that can be logged into the blockchain". **Superseded** 2026-10-08: R15 as first written, which linked a grant-end on lock and reboot.
- **A budget end seals a block.** Brad, 2026-10-07: "checkpoints can happen on a budget grant end, like it's the end of the block of transactions".
- **Budgets complete themselves once fulfilled.** When the last use's receipt is filed, the key writes the end link at once. Brad, 2026-10-10: "budgets should auto complete once fufilled". The build session's proposal, "The key completes a budget itself: when the last use's receipt is filed, it writes the end link at once", got Brad's 2026-10-10 answer: "exactly my thougts too". Built: the grant-end link's decision byte says completed 1, revoked 2, settled 3.
- **A press must be for a budget.** Only budget uses owe a receipt; an ordinary press is not Edge, writes no link and owes nothing. Brad, 2026-10-06: "a press must be for a budget". The consequence, that ordinary presses leave no record and the person's press is the safeguard as on any OnlyKey, was accepted by Brad on 2026-10-06. That wording is the spec session's. The whitepaper quotes it as Brad's words ("my press is the safeguard, as on any OnlyKey"), but no source has him saying it.
- **Waive, as first built.** A press cleared every open debt and the budget went on. Brad, 2026-10-08: "we cant block the key from being used, so how we have waive/loss for a receipt is the way to keep the user going". **Superseded** 2026-10-10 by the settle (next entry).
- **A settle ends the budget instead of letting it go on.** Waive is now called settle, all the way; the hash label is OKEDGE-SETTLE-v1. At the press the key ends every live budget, and the agent must ask for a new one. Brad, 2026-10-10, on the waive: "this voids rule 'budget or no go'"; on when it is needed: "if power cut mid usage, or the AI is no longer allowed to use the cli, and we need to settle the budget"; "waive i think its more secure to just end the budget instead of allowing it to be continue to be used, this will force a new budget to be created by the agent, and flow is good becuase the user will be re-prompted with the new budget to continue instead of weiving"; "this fixes a lot of holes in senerios i talked about, 1 being signing APK in the cloud, if it fails mid steam, and cant submit a recipet, most likely cant resume from there"; on the name: "ok yes SETTLE".
- **One owed use, not a list.** Nothing starts while a receipt is owed, so the 4-slot owed list and its overflow flag never held more than one use. The key now keeps one owed use or none: the flash record went from 320 to 208 bytes, and the backup section, the settle subject (over the one seq) and HEAD byte 57 (0 or 1; byte 58 reserved) changed with it. Brad, 2026-10-10, first: "keep for, ask to remove it at the end of the plan"; then, asked at the end: "Drop the owed list = yes".

## 3. TX start and intent

- **TX start, and the word.** Before each budget use the agent tells the key what it is about to sign. The mechanism (a token over the head and the request) is the spec session's design, not Brad's. The name is Brad's. Brad, 2026-10-06: "arm is now a transaction"; "short hand is TX for transaction". "ARM" was dropped because it is a trademark and reads as the chip. The code took the name on 2026-10-07.
- **A sign that does not match its TX start is refused: no press, no link.** The spec session's reading of "budget or no go", approved by Brad on 2026-10-06 (no quote).
- **Refusals are counted, both kinds.** Refused TX starts and signs refused for not matching their TX start both count in HEAD. Brad, 2026-10-06 (no quote): count both.
- **A budget that expires, is held or ends between the TX start and the sign is no longer a refusal.** The sign is an ordinary request; the person's press decides, and an ordinary press writes no link. Brad, 2026-10-08: "the AI wanted to fix the chain with a feature i never asked for"; "we are still developing, not fixing". **Superseded** 2026-10-08: the 2026-10-06 rule that such a sign is refused, never turned into a press. Brad dropped that rule as a misreading of "budget or no go".
- **The use says what it is for before it happens.** The intent is welded into the use's link at the TX start; the receipt is only its result. Brad, 2026-10-06 (no quote). His example: intent "sign release ok-rn 0.0.6, apk sha256 de2b…" → receipt "signed and verified".
- **The audit reads top-down.** The budget's reason is the whole task, each use's intent is a step, each receipt is its result. Brad (undated, from build/firmware.md R13b; no quote).
- **The person knows before the request happens.** Brad, 2026-10-10: "the intent to press comes from the user pressing the button, they should know beforehand that the request is about to happen, and in cli we can show what we are sending, and in the softkey, we can show it from the frimware in the sheet".

## 4. Receipts and codes

- **Every budget use owes one receipt; nothing automatic happens while one is owed.** Brad, 2026-10-02 (from the build/hardware.md decision log: "every use owes a receipt"; no quote).
- **The word is receipt, renamed all the way from ticket.** This covers the spec, CLI, screens, code, wire names and the hash label OKEDGE-RECEIPT-v1. Brad, 2026-10-08: "receipts is what i wanted to replace tickets with"; "rename goes all the way".
- **Receipt codes are one byte, with bit 7 as the alarm.** RECEIPT-CODES.md draft v1, 2026-09-26. This is a design, not Brad's quoted words.
- **An owed receipt is cleared by the agent filing it, never by a settle the agent presses itself.** DEVELOPMENT.md (undated; with the 2026-10-05 testing flow; no quote). The agent skill says the same: never ask the person to clear a receipt you skipped.
- **The firmware's text replies stay minimal: `EDGE:xx` codes only, the words in the library.** Owner, 2026-10-02: "keep the return strings minimal in firmware".

## 5. The key's scope

- **The key is a notary: the smallest firmware addition, the library does the rest.** Owner, 2026-10-02: "the smallest minimal firmware addition, because a device can only hold so much logic".
- **The firmware does only the work that must be secure.** Brad, 2026-10-06: "only the firmware can do the work that needs to be secure, and we just need to prove the firmware signed and did it, and using lib to check, with its pub key without exposing the private."
- **The firmware presents what it signs.** Brad, 2026-10-10: "the firmware needs to PRESENT this info becuase the firmawre is the thing that is signing"; "we can only display what the key sees".
- **Rip out the overhead.** Peers, siblings, anchors, sync and restore-then-replay all left the key on 2026-10-08. Brad, 2026-10-08: "im trying to remove the overkill stuff like this, like what we have is good, and we need to start ripping or removing the overhead that is not needed"; "i think we still have overkill in the block chain".
- **Known peers, copy-store receipts, k = 2 and the "no backup, no self-press" watermark are dropped.** Brad, 2026-10-08: "Drop peers". **Superseded** 2026-10-08: the first design, "1 local, 1 cloud, 2 checks" (Brad, undated, from 2-DESIGN.md and build/copies.md), where the key counted peer receipts before letting the ring wrap.
- **No `wipe` link; the fresh genesis is the mark.** Brad, 2026-10-08: "no unattended press, unless its an approved budget that can be logged into the blockchain". **Superseded** 2026-10-08: R9 as first written.
- **Every hash label is v1.** Brad, 2026-10-06 (no quote). A later link format writes version 2 links into the same chain, so no future change needs another reset (Brad, 2026-10-06; no quote).
- **v1 is the first release of the protocol and schemas.** Brad, 2026-10-08: "yes i like it"; "v0 turns to v1, v1 = first release of the protocol and schemas". Nothing older is read.
- **One clean start: a full Edge reset that keeps every private key.** Brad, 2026-10-06: "i am ok with doing full reset of stuff of edge data like its store, but we keep the private keys alive so we dont need to derive them". Private keys never leave the device they are on (Brad, 2026-10-06; no quote). The old history is not kept (Brad: not important; no quote).
- **The order before the reset.** Brad, 2026-10-07: "1, blockchain json 2. test-mode split 3. v1 on the protocal/schema version"; "with thoes 2 thing, done / just before we do the reset, we change all the schemas to V1, because we are doing a reset, and edge is still v1 with its protocal and schemas". Done 2026-10-08.
- **During the reset gap, pause commit signing rather than push unsigned.** Brad, 2026-10-08: "if we need to.. pause commit signing if we need to do a commit, push when we recover".
- **Firmware source holds only what it needs.** Brad, 2026-10-10: "need to clean firmware source to only what it needs".
- **Firmware comments describe the code only.** No pointers to documents, no history, nothing personal; enough for a whitepaper to be rebuilt from. Brad, 2026-10-10: "firmware source code comments need to be cleaned up too.. they dont need to point to other documents in the comments, comments in source code for firmware should be what the firmware does"; "we dont need to say how we got there, or what was used to get to this point, firmware comments need to be just what the source does and is used for, and how"; "firmware commnets need to be just what the source does and is used for, and how"; "so a white paper has the something to go on, when being re-written, but nothing personal in comments also".

## 6. Restore, backup and one chain per device

- **One chain per physical device.** Each device's chain uses a per-device salt that is not in the backup. Brad chose option (b), 2026-10-03: "a way to sync both chains"; "I may have a chain in the cloud". Until then, two copies of one key (the A13 and the Pixel) were test-only. The rejected option (a), a pressed BRANCH_ALLOW, came from the same proposal.
- **Purging: archive behind a clean checkpoint, verify only what is left.** Brad, 2026-10-03: "we keep them somewhere else, but instead of verifying every single block, we verify the ones we have not purged yet". The clean checkpoint, which replaced a per-budget SEAL link, was the spec session's design.
- **Each key is a declared fork.** Brad, 2026-10-04: "we should be treating each key as a fork".
- **Restore replays the newest copy and needs a press.** Brad, 2026-10-02 (from the build/hardware.md decision log; no quote). **Superseded** 2026-10-08 (next entry).
- **A restore continues the log; restore-then-replay is cut.** Every restore draws a new salt, so the restored key is a device of its own. Its first link, `continue`, carries the owed uses. Brad, 2026-10-08: "reset should never happen for a normal user ... you cant reset bitcoin, so i cant reset our log"; "we cant block the key from being used, so how we have waive/loss for a receipt is the way to keep the user going". (Waive is now settle, section 2.)
- **A lost log that turns up later still merges.** Brad, 2026-10-08: "if a user does indeed lose their log, and somehow gets it back later, it should still merge for log recovery".
- **No budget from a copy that does not verify.** Brad, 2026-10-02 (from the build/hardware.md decision log; no quote).
- **Verify only the new stuff.** Sealed blocks are re-welded to the newest key-signed checkpoint; only the open block gets the full checks. Brad, 2026-10-07: "we only need to verify the new stuff". **Superseded** 2026-10-07: the 2026-10-06 rule "app start: one full check from genesis" (the spec session's answer).
- **One chain state in memory.** Brad, 2026-10-07: "unify the state of the block chain in memory so ui and bluetooth dont need to constantly hammer verifying the blockchain … 1 complete check, both bluetooth and ui or anything else can just ask for validity"; "because it's a lot easier to manage and save, and watch events on it".
- **A new phone re-registers its receipt key as part of restore.** Brad (undated, from 2-DESIGN.md). **Superseded** 2026-10-08: peers and copy receipts were dropped.

## 7. Who asks

- **The agent gets its own SSH and PGP keys**, derived on the key, separate from Brad's, and named as the agent's on GitHub. Brad, 2026-10-02 (no quote). The identities were chosen 2026-10-03: SSH `ssh://claude@nitro16`, PGP `Claude (nitro16) 2026 <bmatusiak+agent@gmail.com>`, 1-year expiry. The trade-off was accepted: the agent's SSH key can push to every repo Brad can.
- **Derived identities are scoped by label, not just slot.** Found 2026-10-02 when Brad's GitHub login signed on slot 201 (the build session's design; no quote).
- **Agent registration (AGENT_ADD) with a press.** Built 2026-10-03. **Superseded** 2026-10-08 (next entry).
- **The agent key is cut; who asks is the Bluetooth pairing.** Retired: AGENT_ADD (op 15, never reused), `agent.key`, the phone's agent list and request signatures. Brad, 2026-10-08: "i think we still have overkill in the block chain"; "ok so this is not a 'edge' feature, thats ONLY for bluetooth"; "so the claude key thing is overkill"; "lets cut it out".
- **The 6-digit code is only for approving a computer for Bluetooth.** Brad, 2026-10-08: "i only want this to be used to approving the ble transport, not in edge"; "i like pairing 6 digit code thing, but thats should be app only so the data store can sync".

## 8. Sync and devices

- **One command brings copies together, approved where the key is, with a press.** Brad, 2026-10-04 (no quote). **Superseded** 2026-10-08 (next entry).
- **Pairing and sync are all app, not firmware.** Brad, 2026-10-08: "pairing and sync is all app stuff, not firmware"; "sync is a basic p2p style way to combine 2 blockchains into 1, the blocks are signed, so i honestly dont think firmware changes were needed here". Lost on purpose: a proof of order between two chains (Brad accepted, 2026-10-08).
- **Sync is held until approved from a banner, never a popup.** Brad, 2026-10-08: "sync with Approve sheet, however the approve sheet should not be displayed automatically, we need to add a banner at the top of edge tab to open it, banner with 'Sync want to merge new devices'"; "the Approve sheet will show the list of devices in the merge, we should hold these blocks in the app until approved and merged". Banner wording, Brad, 2026-10-08: "{computer} wants to merge a unknown backup device {device_name}".
- **This phone's own links merge at once.** Brad, 2026-10-08: "Own links direct".
- **One phone at a time.** Brad, 2026-10-08: "sync should only be 1 device at a time".
- **"Made with our key": keep the log, proven by the owner statement.** The owner key has no salt, so it is the same on every device from one backup. Brad chose this on 2026-10-08: "if it has the private ecc key to sign the block, then i want the log"; "lets say we make a hardkey with the backup, and the log gets created on the computer"; "how we view the block chain in the app between 2 devices creating blocks using the same key with different salts (non-transferable), so i know a different key made the block, each key with a different salt gives a different fingerprint we can track, but because its made with our key we want that block".
- **A device names itself with a nametag**, set in the Edge Management drawer. Brad, 2026-10-08: "give a way for a device to give its own name for its device fingerprint in the block"; "name is vague, lets call it nametag, so it can be a name or a tag for the block"; "find a way to fix multi names for the same device"; "this should fix our device naming issue (so its not 'unknown')".
- **All of a device's Edge data travels with its log.** Brad, 2026-10-09: "we should be syncing all the edge data, so if i sync my devices i can review the log"; "all the data i see on the a13 should be just like on the pixel".
- **A log is complete before it enters another data store.** Brad, 2026-10-09: "dont use shortcut to validate syncd data, before mergering into another data store"; "a data store must contain all info about the usage of the credental, including the result".
- **The Key Chain list syncs on its own, not through Edge.** Brad, 2026-10-08: "Move it out of Edge".
- **"Your own identities" leaves Edge; Key Chain manages them.** Brad, 2026-10-08: "i see 'your own identities' this is redundant, keychain plugin manages my identities already".
- **Test identities, "Mark as test" and the fake key panel are removed.** The testnet does their job. Brad, 2026-10-08: "yes remove 1-3, they're obvious".

## 9. Blocks, JSON and the testnet

- **Blocks are the chain's data, in JSON, not a view.** The key keeps its 64-byte links; a host writes each block as canonical JSON, and the block id is its SHA-256. Brad, 2026-10-07: "i believe i wanted the block chain data to be in json"; "that is actually what i was wanted and what i was talking about"; "i dont want every transaction".
- **The Edge testnet.** Test mode separates live from test, like Bitcoin, and everything on test is throwaway. Brad, 2026-10-07: "we should treat --test-mode as test net for cli for edge; the app has 'test mode', so that can be used for the trigger; so have it where we can separate live from test like how bitcoin does"; "for edge test mode, it can use different blockchains between"; "--test-mode where edge blockchain files are seperated from live and test (like how bitcoin does it) so it seperated, and everthing for test is throwaway".
- **The testnet is its own storage slot: a separate, throwaway soft key.** Brad chose this over two chains inside one key. Brad, 2026-10-07: "technically we change the storageSlot then for testnet"; "firmware.start(testmode ? testStorageSlot : storageSlot)".
- **Who starts the soft key.** Brad, 2026-10-07: "auto start firmware should be on if test mode is not built into the app; if testing mode is built in, auto start is disabled, so the login screen will need to start the firmware if i click login or testing mode button on login screen".
- **The testnet can be cleared, on the phone and the computer.** Brad, 2026-10-07: "test-mode can help separate the storage side too, both phone and cli, so it can be cleared".

## 10. The press sheet and no blind presses

- **Blind presses are a blocker.** Brad, 2026-10-10: "blind presses is a blocker, without it, it voids all security".
- **The sheet is the notifier, with the press button.** The old "press to confirm" banners are gone. Brad, 2026-10-10: "the confirm button press that i normally see 'press to confirm' element that shows when a press is need, needs to be removed, so the sheet is the notifier with press button".
- **The sheet shows only what the firmware presents.** Brad, 2026-10-10: "the firmware needs to PRESENT this info becuase the firmawre is the thing that is signing"; "the confirm sheet should only get the data from firmwhere, the cli should not be aware that we are checking the press"; "we can only display what the key sees".
- **The CLI stays unaware of ok-rn.** Brad, 2026-10-10: "cli -> firmware -> app press request display with press button -> firmware -> cli should be simple and easy"; "the best thing with ok-rn, is we have a display in the middle, this is why i want the cli to be un-aware of ok-rn".
- **The press hook is soft-key only.** Brad, 2026-10-10: "a hardkey is secure, it will never expose this hook, its a softkey only thing; sofrkey has a display, we can add hooks that increase, the host is the requester, it can not hook into the key so it can approve itself".
- **The CLI shows what it sends, the soft key shows what the firmware sees.** Brad, 2026-10-10: "the intent to press comes from the user pressing the button, they should know beforehand that the request is about to happen, and in cli we can show what we are sending, and in the softkey, we can show it from the frimware in the sheet". Built 2026-10-10: the CLI prints the request fingerprint before each press, in the same format as the sheet.

## 11. The CLI

- **One CLI command: `onlykey-js`.** No `okedge`, no `onlykey-edge-gpg`, no aliases. Brad (dated 2026-10-06 in CLI.md): "at the beginning, i said 1 cli command `onlykey-js`".
- **The agent service is optional, not the default.** `edge exec` works alone; the service only keeps the link open for speed. Brad, 2026-10-06: "i want service to be optional, but not default". The no-service default for `edge exec` was suggested by the build session and approved by Brad, 2026-10-06. **Superseded** 2026-10-06: the 2026-10-03 decision that the long-running `onlykey-js edge-agent` service in the lib's CLI is how the agent works.
- **Test and development commands are gated in source.** No environment variable or flag turns them on in a production package. Brad, 2026-10-06: "need to gate them in source".
- **`edge exec` is the only way to spend a budget; there is no `--press`.** Brad, 2026-10-06: "budget or no go".
- **No `edge peer` or `edge sibling` commands; `edge ticket` is `edge receipt`.** Brad, 2026-10-08: "pairing and sync is all app stuff, not firmware"; "Drop peers"; "rename goes all the way".
- **`edge register` is gone.** Brad, 2026-10-08: "so the claude key thing is overkill"; "lets cut it out".
- **`devices` lists the keys to pick a target.** Brad, 2026-10-08: "onlykey-js devices helps us pick a target"; "i can see the devices in a list so i can pick 1 - or you, so you can pick 1, sometimes its nice just to list connectable devices"; "normal onlykey-js devices will just be usb"; "--ble will just add bluetooth to the list"; "will ping and ask each device"; "locked is connectable, include that, show details about the device state if we can"; "now we add --json for machinecode output"; on the search time: "yea just seconds".
- **No device id checking for now.** Brad, 2026-10-08: "no ID checking, we will do it later if needed, maybe another way in the future".
- **CLI over Bluetooth to the firmware is how to test hard-key ideas.** Brad, 2026-10-10: "cli over ble to firmware calls is our easy way to test our theries like a hardkey with cli only".

## 12. Hard key and hardware

- **Size on a hard key is the gate for any port.** Brad, 2026-10-02: "important". Edge runs on soft keys and emulators until the size check passes.
- **Tim's option: an Edge build with 2 RSA slots instead of 4.** Raised by Tim, not decided; nothing is built until Tim decides.
- **Brad's option: keyboard layouts loaded over config mode, not compiled in.** Brad's idea (undated, from build/firmware.md); Tim decides.
- **Tim's hardware decisions** (2026-09, from the build/hardware.md decision log): a hash-chained log for the device's lifetime; 64 GB of storage, about 16 GB for system and logs; physical tamper is evidence, not prevention. Three tiers (host → SBC → MCU) is Brad's proposal (2026-09).
- **Tim's two directions use one core.** The CLI with a USB key, and the user's Worker as an MCP endpoint. Proposed by Brad, 2026-10-03; Tim to confirm. Brad reported on 2026-10-03 that Tim plans on the CLI and a web interface to review; the page may reach Edge both ways (Brad, 2026-10-03; no quote).
- **Remote through the phone** (a hard key on the phone over OTG, relayed through the user's Worker). Brad's idea, 2026-10-02; proposed.
- **Get to a hard-key-ready point: the Edge plugin on firmware, tested from the CLI alone.** Brad, 2026-10-10: "my goal for this cleanup, and extra stuff is to get to a hard key ready point, so i can bring the edge plugin to the firmware for testing on just cli without the app".
- **On a hard key, the CLI is the app.** Brad, 2026-10-10: "hardkey may not use ok-rn, it may be plugged into the host directly and cli becomes the app to use the hardkey". This **supersedes** in part the earlier decision that ok-rn is the only app and the desktop side is the MCP server only (Brad, undated, from 2-DESIGN.md).
- **Firmware 3.1.0+ for everything built on the derive.** Brad (undated, from 2-DESIGN.md).

## 13. Process

- **Two phones: the Pixel is the agent's, the A13 is Brad's.** Brad, 2026-10-04: "the Pixel is not mine to touch, the A13 is the only one I touch". A problem Brad sees on the A13 is reproduced on the Pixel (Brad, 2026-10-05; no quote).
- **Developing, not fixing.** Edge is unreleased; reset rather than repair, and build no compatibility features. Brad, 2026-10-08: "we are still developing, not fixing".
- **Everything is a first try.** Brad (undated, from build/daily-loop.md, with the 2026-10-03 decisions): "we can change stuff as we go if I have problems or if we find a hole".
- **How decisions get into the spec.** Brad's name goes only on his own words; anything else is marked as a suggestion with the date he approved it. A change that adds a way to sign or approve states its plain consequence and waits for Brad's yes. The spec changes only when Brad says so. (DEVELOPMENT.md, undated; no quote.)
- **Clean up the spec after the cuts.** Brad, 2026-10-10: "cleanup the whole edge spec in onlykey-edge ... too bloated, needs a major cleanup from the cuts we did".
- **The docs reflect only what we want, finalized.** Brad, 2026-10-10: "i needs all docs cleaned and finalized, with only what we are want"; "i feel like we have a good systems with what we have and i want really need the docs to refelect".
