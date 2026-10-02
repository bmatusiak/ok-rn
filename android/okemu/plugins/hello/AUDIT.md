# hello: what it changes

The smallest soft-key firmware plugin. It exists to prove the plugin mechanism (`okemu/scripts/plugins.js`), not to do anything useful.

- **Staged only when asked:** `OKEMU_PLUGINS=hello`. Without it, the soft key's firmware is the base build, byte for byte.
- **Soft key only:** never in a hard-key image or the desktop emulator.

## Hooks (both in `okcore.cpp`, each anchor must occur exactly once)
1. After `#include "onlykey.h"`: `#include "plugins/hello/okplugin_hello.h"`.
2. Before the vendor switch's own `default:` in `recvmsg()` (the one whose next line is `if (profilemode != NONENCRYPTEDPROFILE && FTFL_FSEC == 0x44 && …)`): a `case OKHELLO:` that calls `okplugin_hello_recv()` and returns.

## New code
- `src/okplugin_hello.h`: `OKHELLO` = `TYPE_INIT | 0x7E` (`0xFE` on the wire).
- `src/okplugin_hello.cpp`: answers `HELLO from plugin hello` (`hidprint`), only if the key is initialized, unlocked and not in config mode.

## What it does not do
- No storage: no flash, no EEPROM.
- Reads no secret and changes no existing behaviour.
- In config mode the firmware's allow-list (`okcore.cpp:335`) drops `OKHELLO` before the switch, as it does any message not on that list.
