/**
 * THE PASSWORD MANAGER, run through the app-plugin list (src/plugins/index.ts) - never by naming
 * the plugin, so deleting src/plugins/passwords leaves this suite empty instead of broken. The
 * suite itself lives with the plugin: src/plugins/passwords/e2e.js.
 *
 * 13b, before 14b-pqcSlots and 14c-keychainWrite: those leave the soft key in config mode, where
 * it answers no derive, and only the runner's restart ends it.
 */
'use strict';

const {pluginE2E} = require('../src/plugins');

module.exports = function passwords(harness) {
  for (const suite of pluginE2E('passwords')) suite(harness);
};
