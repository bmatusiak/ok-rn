# FINDING: a key in "challenge code" derive mode restores as "button press"

2026-10-12, read from the firmware tree that compiles (`android/okemu/.stage-src/v3.1.0/libraries/onlykey/okcore.cpp`). PASSWORD-MANAGER-SPEC.md "Backup restores the derive" asked for this write-up.

## What the code does

- **Backup** (`okcore.cpp:6165-6171`): the web and agent derive mode (field 30) is written into the backup only when it is not 0:
  `okeeprom_eeget_web_agent_derive_mode(ptr); if (*ptr != 0) { ... 30 ... }`
- **The modes** (lib `src/protocol/msg.js:142-147`): 0 = challenge code, 1 = button press, 2 = no press.
- **Reading the mode** (`okcore.cpp:5491-5496`): a stored value above 2 (an unset EEPROM byte) counts as button press.

So a key set to **challenge code (0)** writes nothing for field 30. The key it is restored into keeps its own setting; a fresh or wiped key reads as **button press**.

## What it changes

- **The derived keys do not change.** On 3.1.0 the derive's salt does not depend on the mode (the press-flag byte is always 0; lib `src/device/version.js:869`, `deriveReqPress` false from 3.1.0). The same backup gives the same store, the same wallet phrases and the same derived passwords.
- **Only the prompt changes:** after the restore the key asks a press where it asked a 3-digit code before. Challenge code can be set again through the lib preference `webAgentDeriveMode`, "Web and agent derived keys", in config mode (`src/device/preferences.js:183`).

The same `if (*ptr != 0)` guard sits on field 21 (stored derived challenge mode, `okcore.cpp:6158`).

## For the firmware note

Writing field 30 whenever it was set (0 included), or always, would carry challenge code across a restore. Not changed here; this is for the note to the firmware maintainer.
