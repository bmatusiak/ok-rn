'use strict';
/*
 * hello - the smallest soft-key firmware plugin: one vendor message, OKHELLO
 * (0x7E, 0xFE on the wire), answered with a fixed sentence while the key is
 * unlocked. It exists to prove the plugin mechanism (scripts/plugins.js):
 * staged only when OKEMU_PLUGINS names it, two hooks found exactly once, gone
 * when the folder is deleted. See AUDIT.md.
 */
module.exports = {
  name: 'hello',
  minBase: '3.1.0',
  notes: 'OKHELLO 0x7E answers "HELLO from plugin hello" while unlocked',
  hooks: [
    {
      file: 'okcore.cpp',
      anchor: '#include "onlykey.h"\n',
      insert: 'after',
      text: '#include "plugins/hello/okplugin_hello.h"\n',
    },
    {
      /* the vendor switch's own default (okcore.cpp recvmsg); `default:` alone occurs twice */
      file: 'okcore.cpp',
      anchor: '            default:\n                if (profilemode != NONENCRYPTEDPROFILE && FTFL_FSEC == 0x44 && integrityctr1 == integrityctr2) {\n',
      insert: 'before',
      text: '            case OKHELLO:\n                okplugin_hello_recv(recv_buffer);\n                return;\n',
    },
  ],
};
