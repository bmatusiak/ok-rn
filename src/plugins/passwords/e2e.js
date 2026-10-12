/**
 * THE PASSWORD MANAGER ON THE SOFT KEY (in-app e2e; __e2e_tests__/13b-passwords.e2e.js runs it
 * through the plugin list, so it is gone when the plugin is).
 *
 * What only the real key can show: the manager key derived again after a lock is the SAME key -
 * an entry sealed before the lock opens after it - and the store id the key gives is stable. Runs
 * under its own storage prefix (okrn.e2e.passwords.), so the person's own list is never touched,
 * and removes what it wrote.
 */
'use strict';

const AsyncStorage = require('@react-native-async-storage/async-storage').default;
const {getOnlyKey} = require('../../onlykey');
const {pressDigits} = require('../../../__e2e_tests__/helpers/pressDigits');
const {createStores, LABEL} = require('./stores');

const OkEmuModule = require('../../transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;

const PIN = '1234561';
const PREFIX = 'okrn.e2e.passwords.';
const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));

/* AsyncStorage under the e2e prefix: the suite's stores never meet the person's */
const storage = {
  getItem: k => AsyncStorage.getItem(PREFIX + k),
  setItem: (k, v) => AsyncStorage.setItem(PREFIX + k, v),
  removeItem: k => AsyncStorage.removeItem(PREFIX + k),
};

let shared = null;
async function ready(log) {
  if (shared) return shared;
  if (!OkEmu.isRunning()) await OkEmu.start();
  const {device, okcrypto} = await getOnlyKey('embedded');
  let state = await device.connect();
  if (!/UNLOCKED/i.test(String(state.status))) {
    await device.unlock(PIN, {timeoutMs: 20000, enterDigits: pressDigits({log})});
    state = await device.connect();
  }
  shared = {okcrypto, state};
  return shared;
}

module.exports = function passwords({describe, it}) {
  describe(passwords.name, () => {
    let stores = null;
    let id = null;
    let entryId = null;

    it('opens a store on the soft key without a press, and names it after the key', async ({log, assert, skip}) => {
      const s = await ready(log);
      s.okcrypto.deviceVault.lock(LABEL);
      stores = createStores({storage, randomBytes});
      /* a new store opens only from the button: Open with OnlyKey */
      const r = await stores.openWithKey('embedded', s.okcrypto, {touchFree: 'preference'});
      if (r.why !== 'touch-free') skip('this key refused the touch-free derive: a press store (the button, every time)');
      id = await stores.identify('embedded', s.okcrypto);
      assert.ok(/^[0-9a-f]{64}$/.test(id), 'the store id is not 64 hex characters');
      const again = createStores({storage, randomBytes});
      assert.equal(await again.identify('embedded', s.okcrypto), id, 'the store id changed between two asks');
      log(`store ${id.slice(0, 8)}, opened ${r.why}`);
    });

    it('keeps an entry sealed: nothing readable in storage', async ({assert, skip}) => {
      if (!id) skip('no store');
      const m = stores.current('embedded');
      const e = await m.put({kind: 'login', title: 'e2e site', username: 'e2e-user', password: 'e2e-secret-1'});
      entryId = e.id;
      const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(PREFIX));
      /* one at a time: AsyncStorage 3 has no multiGet */
      const raw = (await Promise.all(keys.map(k => AsyncStorage.getItem(k)))).join('\n');
      for (const word of ['e2e site', 'e2e-user', 'e2e-secret-1']) assert.equal(raw.includes(word), false, `"${word}" is stored in the clear`);
    });

    it('locks, derives the key again, and the same entry opens', async ({log, assert, skip}) => {
      if (!entryId) skip('no entry');
      const s = await ready(log);
      stores.lockNow('embedded', () => s.okcrypto);
      assert.equal(s.okcrypto.deviceVault.isUnlocked(LABEL), false, 'the session key outlived Lock now');
      const fresh = createStores({storage, randomBytes});
      const r = await fresh.tryOpen('embedded', s.okcrypto);
      assert.ok(r, 'the touch-free store did not open again');
      assert.equal(r.why, 'touch-free', 'it opened without deriving again');
      assert.equal(r.manager.refused().length, 0, 'a record did not open with the key derived again');
      assert.equal(r.manager.get(entryId)?.password, 'e2e-secret-1');
      fresh.lockNow('embedded', () => s.okcrypto);
    });

    /*
     * A WALLET PHRASE on the real key: the same name twice gives the same 24 valid BIP39 words, and
     * its recipe opens them again (the check holds). The words are never logged.
     */
    it('derives the same wallet phrase twice, and its recipe opens it', async ({log, assert}) => {
      const {mnemonic} = require('node-onlykey-lib/passwords');
      const s = await ready(log);
      const a = await mnemonic.deriveMnemonic({okcrypto: s.okcrypto, name: 'e2e-phrase', out: 'bip39-24', press: false});
      const b = await mnemonic.deriveMnemonic({okcrypto: s.okcrypto, name: 'e2e-phrase', out: 'bip39-24', press: false});
      assert.equal(a.words.length, 24);
      assert.ok(mnemonic.isValidPhrase(a.words), 'not a valid BIP39 phrase');
      assert.equal(a.words.join(' '), b.words.join(' '), 'the same name gave other words');
      assert.equal(a.recipe.check, b.recipe.check);
      const again = await mnemonic.openRecipe({okcrypto: s.okcrypto, recipe: a.recipe});
      assert.equal(again.join(' '), a.words.join(' '), 'the recipe opened other words');
      log(`phrase check ${a.recipe.check}`);
    });

    it('cleans up what it wrote', async ({assert}) => {
      const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(PREFIX));
      for (const k of keys) await AsyncStorage.removeItem(k);
      const left = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(PREFIX));
      assert.equal(left.length, 0);
    });
  });
};
