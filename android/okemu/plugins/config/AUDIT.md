# config - audit

Everything this plugin changes, adds or answers. Delete the folder and none of it is built.

## What it changes in the firmware (3 hooks, `plugin.js`)
| File | Where | What |
|---|---|---|
| `okcore.cpp` | after `#include "onlykey.h"` | `#include "plugins/config/okplugin_config.h"` |
| `okcore.cpp` | the vendor switch, before `default:` | `case OKGETCONFIG: okplugin_config_recv(…)` and `case OKSETCONFIG: okplugin_config_set(…)` |
| `okcore.cpp` | the config-mode allow-list in recvmsg (after `!= OKSETSLOT && … != OKSETPRIV`) | `&& recv_buffer[4] != OKGETCONFIG && recv_buffer[4] != OKSETCONFIG` - both may pass in config mode |

Nothing else in the firmware is touched.

## The requests
| Request | Answer |
|---|---|
| `OKGETCONFIG` (`TYPE_INIT \| 0x79`, 0xF9 - CHOSEN), no payload | INI text, NUL-ended, padded with zeros to whole 64-byte reports |
| …while locked or never set up | nothing (as every vendor request then) |
| …in config mode | answered (the allow-list hook): the import reads its result back with it |
| …through the WebAuthn tunnel (`outputmode != RAW_USB`) | `Error OKGETCONFIG is vendor API only` |
| `OKSETCONFIG` (`TYPE_INIT \| 0x7A`, 0xFA - CHOSEN): the INI in chunks - byte 5 `0xFF` = more, else the last chunk's length (1..58); text from byte 6 | after the last chunk: `OKSETCONFIG applied <n> unknown <u>`; nothing for the chunks before it |
| …out of config mode | `Error OKSETCONFIG needs config mode` (and the collected text is dropped) |
| …through the WebAuthn tunnel | `Error OKSETCONFIG is vendor API only` |
| …too long (over 704 bytes) or a bad chunk length | `Error OKSETCONFIG too long` / `bad chunk` |

No press for either. **OKGETCONFIG writes nothing.** **OKSETCONFIG writes only through `set_slot`** - the firmware's own setting write, one call per value, exactly what an `OKSETSLOT` for that field does, with every check it makes (ranges, first-use-only settings, one-way modes). Its own replies are discarded (`outputmode = DISCARD`) and one summary is sent; the host reads the result back with OKGETCONFIG. `[input]` is skipped; a key outside the table below is counted as unknown, never guessed. Which one-way `[advanced]` values go in is the host's to leave out; config mode (a deliberate hold and the PIN) is the firmware's gate for them.

| INI key | Field written |
|---|---|
| lockout 11 · wipeMode 12 · typeSpeed 13 · keyboardLayout 14 · backupKeyMode 20 · derivedChallengeMode 21 · storedChallengeMode 22 · secProfileMode 23 · ledBrightness 24 · lockButton 25 · hmacChallengeMode 26 · modKeyMode 27 · touchSense 28 · webAgentDeriveMode 30 · webcryptPolicy 31 | the global slot (0), the value as one byte |

## Every value it prints, and where it comes from
| INI key | Source | Printed as |
|---|---|---|
| `[input] derived_keys` | `okcore_user_input_mode_for_slot(201)` | code / press / none |
| `[input] stored_keys` | `okcore_user_input_mode_for_slot(1)` | code / press / none |
| `[input] web_derive` | `okcore_user_input_mode_for_slot(128)` | code / press / none |
| `[input] hmac` | `okeeprom_eeget_hmac_challengemode` == 1 | none, else press |
| `typeSpeed` | `okeeprom_eeget_typespeed(…, 0)` | `11 - stored` (the field 13 write stores `11 - value`); unset if not 1..11 |
| `keyboardLayout` | `okeeprom_eeget_keyboardlayout` | as stored |
| `ledBrightness` | `okeeprom_eeget_ledbrightness` | as stored |
| `lockout` | `okeeprom_eeget_timeout` | as stored |
| `lockButton` | `okeeprom_eeget_autolockslot` | this profile's nibble (field 25 keeps one per profile) |
| `touchSense` | `okeeprom_eeget_touchoffset` | as stored |
| `modKeyMode` | `okeeprom_eeget_modkey` | as stored |
| `hmacChallengeMode` | `okeeprom_eeget_hmac_challengemode` | as stored |
| `derivedChallengeMode` | `okeeprom_eeget_derived_key_challenge_mode` | as stored (field 21) |
| `storedChallengeMode` | `okeeprom_eeget_stored_key_challenge_mode` | as stored (field 22) |
| `webAgentDeriveMode` | `okeeprom_eeget_web_agent_derive_mode` | as stored (field 30) |
| `secProfileMode` | `okeeprom_eeget_2ndprofilemode` | as stored |
| `[advanced] webcryptPolicy` | `okeeprom_eeget_webcrypt_policy` | `stored & OKWC_VALID_MASK` when written, else unset |
| `[advanced] wipeMode` | `okeeprom_eeget_wipemode` | as stored |
| `[advanced] backupKeyMode` | `okeeprom_eeget_backupkeymode` | as stored |

**"unset"** follows the firmware's own rule: its backup writer saves these settings only when non-zero, and at boot a 0 keeps the default. So `typeSpeed`, `keyboardLayout`, `ledBrightness` (0 keeps the brightness it has) and `touchSense` (0 becomes 12; a write of 0 is refused) print as unset when 0. Elsewhere 0 is a real value: lockout 0, lock button 0, mode 0 (= code).

**Never printed:** keys, PINs, passwords, nonces, the failed-login count, CTAP state, slot contents.

## Why the padding
`send_transport_response` copies only the bytes it is given into a buffer it never clears, so a short last report would carry the previous reply's tail (held finding c). Every reply here is whole reports of its own bytes and zeros.

## Not on a hard key
Never built into a hard-key image (owner, 2026-10-02): a hard key is not emulated, so the app is not in the middle.

## Tests (`tests/kit.test.js`, the kit's 38 on an emulator built with the plugin)
1. The INI prints: version line, the three sections, known keys only, whole reports, NUL-ended.
2. Values written through the firmware's own writes are read back exactly (lockout, LED, type speed, lock button), then restored.
3. `[input]` follows field 21: press reads `press`, challenge reads `code`.
4. Refused through the WebAuthn tunnel.
5. OKSETCONFIG is refused out of config mode, and nothing changes.
6. In config mode it imports through the firmware's own writes: `applied 3 unknown 1`; `[input]` is ignored; read back with OKGETCONFIG.
