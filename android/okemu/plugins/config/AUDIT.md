# config - audit

Everything this plugin changes, adds or answers. Delete the folder and none of it is built.

## What it changes in the firmware (2 hooks, `plugin.js`)
| File | Where | What |
|---|---|---|
| `okcore.cpp` | after `#include "onlykey.h"` | `#include "plugins/config/okplugin_config.h"` |
| `okcore.cpp` | the vendor switch, before `default:` | `case OKGETCONFIG: okplugin_config_recv(recv_buffer); return;` |

Nothing else in the firmware is touched.

## The one request
| Request | Answer |
|---|---|
| `OKGETCONFIG` (`TYPE_INIT \| 0x79`, 0xF9 - CHOSEN), no payload | INI text, NUL-ended, padded with zeros to whole 64-byte reports |
| …while locked or never set up | nothing (as every vendor request then) |
| …in config mode | nothing: the firmware's own config-mode allow-list stops it before the plugin (`okcore.cpp` recvmsg, 3.1.0 line 338) |
| …through the WebAuthn tunnel (`outputmode != RAW_USB`) | `Error OKGETCONFIG is vendor API only` |

No press. **It writes nothing**: no EEPROM, no flash, no RAM state outside its own reply buffer (`out[704]`, cleared before each answer).

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
