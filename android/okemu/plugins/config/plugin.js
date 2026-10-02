'use strict';
/*
 * config - OKGETCONFIG on the soft key (DESIGN.md): the key prints its
 * settings back as INI text, so they can be seen, exported and imported (the
 * import is the library's - it writes each value with the setting writes the
 * firmware already has). Read-only, no press, vendor API only, unlocked only;
 * refused over CTAP. Never on a hard key (owner, 2026-10-02): a hard key is not
 * emulated, so the app is not in the middle.
 *
 * Hooks (each anchor occurs exactly once in the 3.1.0 tree, soft key and
 * desktop emulator alike - and stays unique next to edge's, which inserts at
 * the same two places):
 *   1 okcore.cpp  include the plugin header
 *   2 okcore.cpp  the vendor switch: case OKGETCONFIG
 */
module.exports = {
  name: 'config',
  minBase: '3.1.0',
  notes: 'OKGETCONFIG 0xF9: the key prints its settings as INI (soft key only, read-only)',
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
      text: '            case OKGETCONFIG:\n                okplugin_config_recv(recv_buffer);\n                return;\n',
    },
  ],
};
