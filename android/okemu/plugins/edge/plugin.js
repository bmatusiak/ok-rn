'use strict';
/*
 * edge - OnlyKey Edge on the soft key (DESIGN.md). Step 1: every sign/decrypt
 * decision becomes a link in the key's SHA-256 chain; HEAD / READ /
 * CKPT_PUBKEY answer it. Hooks (each anchor occurs exactly once in the 3.1.0
 * tree, soft key and desktop emulator alike):
 *   1 okcore.cpp  include the plugin header
 *   2 okcore.cpp  the vendor switch: case OKEDGE
 *   3 okcore.cpp  okcore_prime_user_confirmation(): what is waiting for a decision
 *   4 okcore.cpp  okcore_run_pending_op(): APPROVE, before the operation runs (R4)
 *   5 okcore.cpp  fadeoffafter20sec(): TIMEOUT
 *   6 OnlyKey.ino the wrong-challenge branch: DENY
 *   7 okcore.cpp  wipeflashdata(): the chain's storage is wiped with the key
 */
module.exports = {
  name: 'edge',
  minBase: '3.1.0',
  notes: 'OKEDGE 0xF8: the key chains every sign/decrypt decision (soft key only)',
  /* 37 bytes in the backup's plugin section (version, seq, head) - see okplugin_edge_backup */
  backup: true,
  hooks: [
    {
      file: 'okcore.cpp',
      anchor: '#include "onlykey.h"\n',
      insert: 'after',
      text: '#include "plugins/edge/okplugin_edge.h"\n',
    },
    {
      file: 'okcore.cpp',
      anchor: '            default:\n                if (profilemode != NONENCRYPTEDPROFILE && FTFL_FSEC == 0x44 && integrityctr1 == integrityctr2) {\n',
      insert: 'before',
      text: '            case OKEDGE:\n                okplugin_edge_recv(recv_buffer);\n                return;\n',
    },
    {
      file: 'okcore.cpp',
      anchor: '    user_input_mode = okcore_user_input_mode_for_slot(slot);\n',
      insert: 'after',
      text: '    okplugin_edge_primed(opcode, slot, msg, msg_len);\n',
    },
    {
      file: 'okcore.cpp',
      anchor: 'void okcore_run_pending_op() {\n',
      insert: 'after',
      /* R13a + budget or no go (2026-10-06): a refused request ends here - nothing runs, no link, red fade */
      text: '    if (okplugin_edge_refused()) {\n        CRYPTO_AUTH = 0;\n        user_input_mode = USER_INPUT_CHALLENGE;\n        pending_op_no_press = 0;\n        pending_operation = 0;\n        packet_buffer_details[0] = 0;\n        fadeoff(1);\n        return;\n    }\n    okplugin_edge_decision(OKEDGE_DECISION_APPROVE);\n',
    },
    {
      file: 'okcore.cpp',
      anchor: '            hidprint("Timeout occured while waiting for confirmation on OnlyKey");\n',
      insert: 'before',
      text: '            okplugin_edge_decision(OKEDGE_DECISION_TIMEOUT);\n',
    },
    {
      file: 'sketch/OnlyKey.ino',
      anchor: '        } else if (CRYPTO_AUTH) { //Wrong challenge was entered\n',
      insert: 'after',
      text: '            { extern void okplugin_edge_decision(int); okplugin_edge_decision(2); }\n',
    },
    {
      file: 'okcore.cpp',
      anchor: 'void wipeflashdata() {\n',
      insert: 'after',
      text: '    okplugin_edge_wipe();\n',
    },
  ],
};
