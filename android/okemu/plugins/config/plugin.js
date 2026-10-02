'use strict';
/*
 * config - the soft key's settings as INI (DESIGN.md): OKGETCONFIG prints
 * them, OKSETCONFIG imports a file - in CONFIG MODE ONLY (owner, 2026-10-02),
 * by handing each value to the firmware's own setting write (set_slot), so
 * every check the firmware makes still applies. Vendor API only, after PIN
 * entry; refused over CTAP. Never on a hard key (owner, 2026-10-02): a hard
 * key is not emulated, so the app is not in the middle.
 *
 * Hooks (each anchor occurs exactly once in the 3.1.0 tree, soft key and
 * desktop emulator alike - and stays unique next to edge's, which inserts at
 * the first two places):
 *   1 okcore.cpp  include the plugin header
 *   2 okcore.cpp  the vendor switch: case OKGETCONFIG, case OKSETCONFIG
 *   3 okcore.cpp  the config-mode allow-list (recvmsg): both may pass there -
 *                 OKSETCONFIG is the import and runs ONLY in config mode, and
 *                 OKGETCONFIG reads back what it did
 */
module.exports = {
  name: 'config',
  minBase: '3.1.0',
  notes: 'OKGETCONFIG 0xF9 prints the settings as INI; OKSETCONFIG 0xFA imports one, config mode only (soft key only)',
  backup: false,
  hooks: [
    {
      file: 'okcore.cpp',
      anchor: '#include "onlykey.h"\n',
      insert: 'after',
      text: '#include "plugins/config/okplugin_config.h"\n',
    },
    {
      file: 'okcore.cpp',
      anchor: '            default:\n                if (profilemode != NONENCRYPTEDPROFILE && FTFL_FSEC == 0x44 && integrityctr1 == integrityctr2) {\n',
      insert: 'before',
      text: '            case OKGETCONFIG:\n                okplugin_config_recv(recv_buffer);\n                return;\n'
        + '            case OKSETCONFIG:\n                okplugin_config_set(recv_buffer);\n                return;\n',
    },
    {
      file: 'okcore.cpp',
      anchor: 'recv_buffer[4] != OKSETSLOT && recv_buffer[4] != OKSETPRIV',
      insert: 'after',
      text: ' && recv_buffer[4] != OKGETCONFIG && recv_buffer[4] != OKSETCONFIG',
    },
  ],
};
