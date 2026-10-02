/**
 * SOFT-KEY FIRMWARE PLUGINS (android/okemu/plugins/<name>/, scripts/plugins.js).
 *
 * A plugin is staged into the soft key only when the build asks for it
 * (OKEMU_PLUGINS=hello). This suite ARMS ITSELF on that: on a normal build
 * every test skips and says why, so the base run measures the soft key
 * everyone else has - which is the point of a removable feature.
 *
 * hello is the smallest plugin: one vendor message, OKHELLO (0x7E, 0xFE on the
 * wire), answered with a fixed sentence while the key is unlocked.
 */
'use strict';

const {getOnlyKey} = require('../src/onlykey');
const {pressDigits} = require('./helpers/pressDigits');
const {buildInfo, hasSoftKeyPlugin, storageSlot} = require('../src/buildInfo');
const {protocol} = require('node-onlykey-lib');

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;
const {IFACE} = OkEmuModule;

const PIN = '1234561';
const OKHELLO = 0x80 | 0x7e;

module.exports = function softKeyPlugins({describe, it}) {
  describe(softKeyPlugins.name, () => {
    it('the build says which plugins its soft key carries', async ({log, assert}) => {
      log(`plugins: ${JSON.stringify(buildInfo.plugins)}; storage slot: "${storageSlot}"`);
      if (buildInfo.plugins.length) {
        assert.ok(storageSlot.includes('plugins-'), 'a plugin build must not share the base soft key\'s storage');
      } else {
        assert.ok(!storageSlot.includes('plugins-'), 'a build without plugins kept its usual storage slot');
      }
    });

    it('hello: OKHELLO is answered by the plugin, while unlocked', async ({log, assert, skip}) => {
      if (!hasSoftKeyPlugin('hello')) skip('this build has no hello plugin (stage with OKEMU_PLUGINS=hello)');
      if (!OkEmu.isRunning()) await OkEmu.start();
      const {device, transport} = await getOnlyKey();
      let state = await device.connect();
      if (!/UNLOCKED/i.test(String(state.status))) {
        await device.unlock(PIN, {timeoutMs: 20000, enterDigits: pressDigits({log})});
        state = await device.connect();
      }
      const reply = await transport.request({
        iface: IFACE.VENDOR,
        data: protocol.okmsg.build({msg: OKHELLO, slot: 0}),
        timeoutMs: 6000,
        match: r => /HELLO|Error/.test(protocol.okmsg.text(r)),
      });
      const said = protocol.okmsg.text(reply).trim();
      log(`the soft key said: ${JSON.stringify(said)}`);
      assert.equal(said, 'HELLO from plugin hello');
    });
  });
};
