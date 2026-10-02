# config - OKGETCONFIG / OKSETCONFIG: the soft key's settings as INI

**Owner:** Brad. **Started:** 2026-10-02 as `onlykey-RN/PROPOSAL-softkey-config-plugin.md`; moved here and rewritten to what was built.

## Why
The firmware lets a host write every setting and read none back. So ok-rn's Preferences and Advanced tabs couldn't show the key's real values. The CLI couldn't tell whether a sign would want a 3-digit code, one press, or nothing: the ssh agent printed a code even in single-press mode (the ssh practice, 2026-10-02).

## Decided (Brad, 2026-10-02)
- **A soft-key firmware plugin**, this folder: removable by deleting it, audited in `AUDIT.md`.
- **Never on a hard key, for security.** A hard key isn't emulated, so the app isn't in the middle: its settings would be readable by any host it's plugged into. On the soft key every host reaches the firmware through ok-rn.
- **Simple: INI text** that is read (`OKGETCONFIG`), exported and imported (`OKSETCONFIG`).
- **`OKGETCONFIG`: vendor API only, after PIN entry; refused over CTAP.**
- **`OKSETCONFIG`: config mode only, and DEBUG builds only.** A release soft key reads its settings but never imports.
- **Its tests never run on a hard key** that doesn't support it (the kit's 38 requires `emulated`).

## Built
| Piece | Where | Proven |
|---|---|---|
| `OKGETCONFIG` (0xF9, CHOSEN): prints the INI, whole zero-padded reports ended by a NUL | `src/okplugin_config.cpp` | kit 38 on the Windows emulator |
| `OKSETCONFIG` (0xFA, CHOSEN): the INI in 58-byte chunks; each value goes to the firmware's own `set_slot`, with every check it makes; one summary reply | same, under `#ifdef DEBUG` | kit 38; production build: `okplugin_config_set` absent from the object and the addon |
| Both pass the config-mode allow-list (the import reads back what it did) | `plugin.js` hook 3 | kit 38 |
| Lib: `node-onlykey-lib/config` (parse, plan, format - pure), `plugins/config` (`read()`, `readText()`, `write()`) | node-onlykey-lib | `test/config.test.js`, 8 tests |
| CLI: `onlykey-js config [export [file] \| import <file> [--one-way]]` | node-onlykey-lib `cli/` | the Pixel soft key over Bluetooth: export; import refused out of config mode; import in config mode, lockout and LED taken, read back |
| The ssh agent prints only the prompt that applies ("press any button", or the code) | node-onlykey-lib `cli/` | lib tests; the Pixel login prompts |

Kit 38 on the DEBUG emulator: **17 passed, 1 skipped** (the release-only check, which the kit can't run: its fixture needs the debug console).

## The INI
```ini
; OnlyKey soft key config - OKGETCONFIG v1
[input]
; resolved: what the key will ask for (code | press | none) - read-only
derived_keys=press
stored_keys=press
web_derive=press
hmac=press

[preferences]
; typeSpeed unset (the firmware default)
keyboardLayout=…
ledBrightness=7
lockout=25
lockButton=0
touchSense=…
modKeyMode=0
hmacChallengeMode=0
derivedChallengeMode=1
storedChallengeMode=1
webAgentDeriveMode=1
secProfileMode=0

[advanced]
; one-way: an import changes these only when asked to
; webcryptPolicy unset (the firmware default)
wipeMode=0
backupKeyMode=0
```
- **Key names are node-onlykey-lib's preference names**, so a file imports with no translation.
- **`[input]`** is the firmware's own resolution (`okcore_user_input_mode_for_slot`): read-only, never imported.
- **`[advanced]`** holds the lib's one-way settings. The CLI sends them only with `--one-way`.
- **"unset"** follows the firmware's own backup rule: type speed, layout, LED and touch sense stored as 0 mean "never set".

## Learned on the way
- **Config mode has an allow-list** (`okcore.cpp` recvmsg): any other vendor command is refused there with no reply. Hence hook 3.
- **The firmware never clears its response buffer** (held finding c), so every reply here is whole reports of its own bytes and zeros.
- **Each plugin set has its own soft-key storage slot.** An `edge,config` build is a new, blank soft key next to the `edge` one. Its derived ssh key differs too, so the Pi and the VM need the new public key.

## Still open
- **ok-rn:** each Preferences and Advanced row shows "now: <value>" when the key answers OKGETCONFIG; a hard key shows "unknown". The screens are yours.
- **ok-rn:** a Pixel e2e side-loaded from this folder (`tests/e2e.js`), after ok-rn is re-pinned to the lib with `plugins/config`.
- **The "the key is waiting" sheet** for API requests, which can now say "press any button" or "enter the code shown on the computer" correctly.
- **The command bytes 0xF9 / 0xFA** are CHOSEN, open for Tim, as Edge's 0x78 is.
- **Maybe:** name the storage slot only after plugins that store something, so a read-only plugin never forks the soft key.
