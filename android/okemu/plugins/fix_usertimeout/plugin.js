'use strict';
/*
 * fix_usertimeout - a firmware fix, staged as a plugin so it can be tested on its own before it is
 * proposed upstream. AUDIT.md describes the issue, the fix and the test.
 *
 * Hook (the anchor occurs exactly once in the 3.1.0 tree; edge inserts after the same line, and
 * either order is correct):
 *   1 okcore.cpp  first line of okcore_run_pending_op(): stop the 20 s user timer
 */
module.exports = {
  name: 'fix_usertimeout',
  minBase: '3.1.0',
  notes: 'fix: the 20 s user timer stops when a request is decided, so it cannot answer "Timeout occured" for the next one',
  backup: false,
  /* keeps nothing in flash or EEPROM: the soft key's storage slot is not named after it (firmware-plugins slotPlugins) */
  stateless: true,
  hooks: [
    {
      file: 'okcore.cpp',
      anchor: 'void okcore_run_pending_op() {\n',
      insert: 'after',
      text: '    cancelfadeoffafter20(); /* the request is decided: its 20 s wait for the user is over */\n',
    },
  ],
};
