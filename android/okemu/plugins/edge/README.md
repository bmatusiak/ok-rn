# OnlyKey Edge: the firmware plugin

A firmware plugin for the OnlyKey 3.1.0 firmware that lets an agent use the key inside a
**budget** a person approves. The person approves the budget once, with a physical press. Each use
inside it is then signed without a press, and the key records each use as a **link** in a SHA-256
hash chain that only the key extends. Every use owes a **receipt** from the agent. The key signs
**checkpoints** over its chain, so a host can prove its copy is the key's.

**Protocol and schemas:** v1, the first release.
**Runs on:** the soft key only - the firmware compiled into the ok-rn Android app, and the desktop
emulator. A hard key has no free flash sector for the plugin's state today
([WHITEPAPER.md](WHITEPAPER.md) §3).

## What the key does

- **Opens a budget only at a press.** A budget names up to 4 scopes (operation, slot, cap), a
  lifetime, and the hash of a reason. The key draws a seed and commits to the budget's hash series
  in the opening link.
- **Pays only for the announced request.** Before each use the agent sends a TX start, a token
  bound to the chain's head, the exact bytes to be signed and an optional intent. A sign that is
  not that request is refused with no press and no link.
- **Links each budget use** before the operation runs, revealing the next value of the budget's
  hash series. An ordinary press writes no link.
- **Keeps one owed receipt.** While a receipt is owed, nothing automatic starts: no TX start, no
  new budget, no resume. A receipt from the agent pays it. A person's pressed **settle** clears it
  and ends every live budget.
- **Ends a budget itself** when its last use is receipted. It also ends one on a revoke or a
  settle. Each end writes a link that says which.
- **Signs checkpoints** over (seq, head) with an Edge key that no other request reaches.
- **Travels in the backup.** One plugin section carries the chain's position and its debt. A
  restore always starts a new device, whose first link continues the old chain.

## Files

| File | What it is |
|---|---|
| [SPEC.md](SPEC.md) | The rules (R1-R31), one line each, with the glossary and acceptance tests |
| [WHITEPAPER.md](WHITEPAPER.md) | The firmware byte by byte: state, chain, budgets, the wire, threat model, with line references into the code |
| [AUDIT.md](AUDIT.md) | What the plugin changes in the core firmware: hooks, sub-ops, storage, keys, size |
| [DESIGN.md](DESIGN.md) | Why it is built this way |
| [BLOCKS.md](BLOCKS.md) | The model on the host side: transactions, budgets, blocks, sync, the testnet |
| [RECEIPT-CODES.md](RECEIPT-CODES.md) | The receipt's one-byte result codes, and the settle |
| `src/okplugin_edge.cpp`, `src/okplugin_edge.h` | The plugin |
| `plugin.js` | The manifest: name, base version, backup section, and the eight hooks inserted into the core |
| `tests/kit.test.js` | Emulator tests, run by the onlykey-testing kit |
| `tests/e2e.js` | On-device tests, run by ok-rn's in-app e2e suite |
| `tools/measure-size.sh` | The plugin's code, constants and RAM size on a hard key's CPU |

**Reading order:** this README, then SPEC.md for the rules, then WHITEPAPER.md for how the code
keeps them. AUDIT.md is the short review checklist; DESIGN.md answers "why".

## Building

The plugin is staged only when it is asked for: `OKEMU_PLUGINS` includes `edge`. Without it the
firmware is the base build, byte for byte. When staged, `plugin.js` inserts eight hooks into
`okcore.cpp` and `OnlyKey.ino`. Each anchor occurs exactly once in the 3.1.0 tree. The hooks are
listed in [AUDIT.md](AUDIT.md).

## Testing

- **Emulator:** `tests/kit.test.js` is side-loaded by the onlykey-testing kit
  (`01-protocol/38-softkey-plugins.test.js`) when the emulator was built with the plugin. Every
  link, signature and receipt the key writes is checked by the host library's own reading of it.
- **Phone:** `tests/e2e.js` is copied into ok-rn's in-app e2e suite when the build stages the plugin.
- **Size:** `tools/measure-size.sh` compiles the plugin alone with the Teensy 1.6.5-r5 toolchain
  (Cortex-M4, `-Os`) in the firmware toolchain image and prints each function's size. The
  latest numbers are in [AUDIT.md](AUDIT.md).

## The host side

The key does the least: it gates, links and signs. The host stores the chain, verifies it, pairs
uses with receipts and syncs devices. That half is `node-onlykey-lib/edge`: the wire calls are in
`edge/plugin/index.js`, the chain, budgets and receipts in `edge/src/`.
