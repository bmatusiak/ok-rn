/**
 * SOFT-KEY FIRMWARE PLUGINS (android/okemu/plugins/<name>/, or OKEMU_PLUGINS_DIR).
 *
 * A plugin is staged into the soft key only when the build asks for it
 * (OKEMU_PLUGINS=<name>). Its tests live IN ITS FOLDER (tests/e2e.js) and are
 * SIDE-LOADED here (owner, 2026-10-01): the stager copies the staged plugins'
 * tests into src/generated/ and lists them in pluginTests.js; this suite
 * registers them. A plugin and its tests leave together; a base build lists
 * none, so the base run measures the soft key everyone else has.
 *
 * Plugin tests get the app through `ctx` rather than reaching into src/.
 */
'use strict';

const {getOnlyKey} = require('../src/onlykey');
const {pressDigits} = require('./helpers/pressDigits');
const {buildInfo, hasSoftKeyPlugin, storageSlot} = require('../src/buildInfo');
const {protocol} = require('node-onlykey-lib');

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;
const {IFACE} = OkEmuModule;

/* try/catch, not a static import: a checkout that was never staged has no generated list */
let pluginTests = [];
try {
  pluginTests = require('../src/generated/pluginTests.js');
} catch {
  pluginTests = [];
}

const ctx = {getOnlyKey, OkEmu, IFACE, protocol, pressDigits, PIN: '1234561', buildInfo, hasSoftKeyPlugin};

module.exports = function softKeyPlugins({describe, it}) {
  describe(softKeyPlugins.name, () => {
    it('the build says which plugins its soft key carries', async ({log, assert}) => {
      log(`plugins: ${JSON.stringify(buildInfo.plugins)}; storage slot: "${storageSlot}"; side-loaded tests: ${JSON.stringify(pluginTests.map(t => t.name))}`);
      if (buildInfo.plugins.length) {
        assert.ok(storageSlot.includes('plugins-'), 'a plugin build must not share the base soft key\'s storage');
      } else {
        assert.ok(!storageSlot.includes('plugins-'), 'a build without plugins kept its usual storage slot');
        assert.equal(pluginTests.length, 0, 'a base build side-loads no plugin tests');
      }
    });

    /* each staged plugin's own tests, from its own folder */
    for (const t of pluginTests) t.register({it}, ctx);
    if (!pluginTests.length) {
      it('side-loaded plugin tests', async ({skip}) => {
        skip('this build stages no plugin (build with OKEMU_PLUGINS=<name> to run a plugin\'s own tests)');
      });
    }
  });
};
