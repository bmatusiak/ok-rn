'use strict';

/*
 * Guest Book's in-app suite, from its plugin (src/plugins/guestbook/e2e.js) - empty when the
 * plugin is removed, so this folder never names a plugin's files.
 */
const {pluginE2E} = require('../src/plugins');

module.exports = function guestbook(harness) {
  for (const suite of pluginE2E('guestbook')) suite(harness);
};
