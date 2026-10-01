/**
 * KEY CHAIN, the half that writes: what the NEXT run's 14a5-keychain checks.
 *
 * Runs after 14b-pqcSlots, which leaves the device in config mode on purpose
 * (only a power cycle - the runner's force-stop - ends it). Run alone, it
 * enters config mode itself. Everything it writes is recorded in AsyncStorage
 * (public data only: slots, labels, the RSA modulus), and 14a5 reads that
 * record back against the device after the restart.
 *
 * What it writes, as the Key Chain tab does it:
 *   ECC 113 + 114  a PGP pair made INSIDE the Key (X25519 decrypt, Ed25519
 *                  sign), labelled with one tag - 14a5 builds its certificate
 *   RSA4           an RSA-2048 key made in the App (OpenSSL), loaded with a
 *                  label, then wiped from the App's memory
 *   ECC 115        made inside the Key, then wiped
 *   RSA2           an App-made RSA key loaded, then wiped - on 3.1.0 firmware
 *                  the wipe leaves the slot answering a "modulus"
 *                  (FINDING-rsa-wipe-keeps-key-type); 14a5 checks it reads empty
 */
'use strict';

const AsyncStorage = require('@react-native-async-storage/async-storage').default;
const {getOnlyKey} = require('../src/onlykey');
const {pressDigits} = require('./helpers/pressDigits');
const {buildInfo} = require('../src/buildInfo');
const {device: deviceLib} = require('node-onlykey-lib');
const keychain = require('node-onlykey-lib/keychain');

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;

const PIN = '1234561';
const RECORD_KEY = 'okrn.e2e.keychain';
const PAIR_LABEL = keychain.tag.formatTag('pgp', 'e2e');
const RSA4_LABEL = keychain.tag.formatTag('sig', 'e2ersa');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

let shared = null;
async function ready(log) {
  if (shared) return shared;
  if (!OkEmu.isRunning()) await OkEmu.start();
  const {device} = await getOnlyKey();
  let state = await device.connect();
  if (!/UNLOCKED/i.test(String(state.status))) {
    await device.unlock(PIN, {timeoutMs: 20000, enterDigits: pressDigits({log})});
    state = await device.connect();
  }
  const caps = deviceLib.version.capabilities(String(state.status).trim(), {unreleased: buildInfo.unreleased});
  shared = {device, caps, record: {at: new Date().toISOString(), pairLabel: PAIR_LABEL, rsa4Label: RSA4_LABEL}};
  return shared;
}

/*
 * Generate inside the Key, once more if the write went unanswered: the first
 * write after entering config mode was dropped once (2026-10-01, ECC13, no
 * reply in 8 s) while the writes after it landed. Generating again into a test
 * slot costs nothing - it replaces whatever the first attempt may have made.
 */
async function generate(device, slot, type, opts, log) {
  try {
    await device.generateEccKey(slot, type, opts);
  } catch (e) {
    if (!/never acknowledged/.test(String(e && e.message))) throw e;
    log(`ECC${slot - 100}: no answer to the first write - generating again`);
    await delay(1000);
    await device.generateEccKey(slot, type, opts);
  }
  log(`ECC${slot - 100}: generated (type ${type})`);
}

/* An App-made RSA-2048 key loaded into `slot`, as Key Chain's "In the App" does it. */
async function loadAppRsa(device, slot, label, log) {
  const key = await keychain.generate.hostKey('rsa', {bits: 2048});
  const prepared = deviceLib.keys.prepareKey(key.material, {slot, signature: true});
  const r = await device.loadKey(slot, {type: prepared.type, key: prepared.key}, {label});
  prepared.key.fill(0);
  const modulus = hex(key.publicKey);
  keychain.generate.wipe(key);
  log(`RSA${slot}: ${JSON.stringify(r && r.response)}`);
  return modulus;
}

module.exports = function keyChainWrite({describe, it}) {
  describe(keyChainWrite.name, () => {
    it('is in config mode (14b leaves it there; alone, it enters it)', async ({log, assert, skip}) => {
      const s = await ready(log);
      if (!s.caps.curve25519Keygen) skip('this firmware cannot generate an X25519 key inside the Key');
      if (!s.device.inConfigMode) {
        await s.device.enterConfigMode({
          hold: (button, ticks) => OkEmu.holdTicks(button, ticks, {allowGesture: true}),
          settle: delay,
          attempts: 3,
        });
        await s.device.unlock(PIN, {timeoutMs: 20000, enterDigits: pressDigits({log})});
        log('entered config mode');
        await delay(1500);
      }
      assert.ok(s.device.inConfigMode, 'not in config mode: every write below would be refused');
    });

    it('makes a PGP pair INSIDE the Key: X25519 in ECC13, Ed25519 in ECC14, one label', async ({log, skip}) => {
      const s = await ready(log);
      if (!s.device.inConfigMode) skip('not in config mode');
      await generate(s.device, 113, 4, {decryption: true, label: PAIR_LABEL}, log);
      await generate(s.device, 114, 1, {signature: true, label: PAIR_LABEL}, log);
      log(`ECC13 + ECC14 generated, labelled ${PAIR_LABEL}`);
    });

    it('loads an RSA-2048 key made in the App (OpenSSL) into RSA4, with a label', async ({log, skip}) => {
      const s = await ready(log);
      if (!s.device.inConfigMode) skip('not in config mode');
      s.record.rsa4 = await loadAppRsa(s.device, 4, RSA4_LABEL, log);
    });

    it('wipes: a key made in ECC15, and an App key loaded into RSA2', async ({log, assert, skip}) => {
      const s = await ready(log);
      if (!s.device.inConfigMode) skip('not in config mode');
      await s.device.generateEccKey(115, 1, {signature: true, label: keychain.tag.formatTag('ssh', 'e2ewipe')});
      const ecc = await s.device.wipeKey(115);
      log(`ECC15: ${JSON.stringify(ecc.response)}`);
      assert.ok(/^Successfully wiped ECC/.test(ecc.response), `the ECC wipe was not confirmed: ${ecc.response}`);
      await loadAppRsa(s.device, 2, keychain.tag.formatTag('sig', 'e2ewipe'), log);
      const rsa = await s.device.wipeKey(2);
      log(`RSA2: ${JSON.stringify(rsa.response)}`);
      assert.ok(/^Successfully wiped RSA/.test(rsa.response), `the RSA wipe was not confirmed: ${rsa.response}`);
    });

    it('records what it wrote, for the next run to read back', async ({log, assert, skip}) => {
      const s = await ready(log);
      if (!s.record.rsa4) skip('nothing was written');
      await AsyncStorage.setItem(RECORD_KEY, JSON.stringify(s.record));
      log(`recorded: ${JSON.stringify({...s.record, rsa4: `${s.record.rsa4.slice(0, 12)}...`})}`);
      assert.ok(true);
    });
  });
};
