/**
 * CONFIG MODE ON A HARD KEY: the door the vault and the composite key are behind.
 *
 * Two things the app can do were measured on the bench key and refused by
 * name: sealing to the vault ("derived keys per site without touch" not set)
 * and loading a composite PGP key ("Error not in config mode"). Both need the
 * key in config mode, which the firmware enters on a gesture (button 6 held
 * past the gesture band), LOCKS on entering, and leaves only at restart. This
 * suite walks that door on real hardware, through the console, and comes back
 * out:
 *
 *   1. hold 6#80 through the console; the key locks, which is the proof
 *   2. unlock with the PIN, through the console
 *   3. set derived-key challenge mode to 8 (touch-free per-site derive)
 *   4. generate a composite key on the phone and load its blob into RSA slot 1
 *   5. restart the key and unlock it again. SIGNING IS FORBIDDEN IN CONFIG
 *      MODE and config mode ends only at restart (9-cryptoSign's header says
 *      the same) - the first version of this suite signed before restarting
 *      and the key raised its challenge and then never answered
 *   6. sign a message THROUGH the key - the fork's hardware hooks call the
 *      device for both halves, each behind a three-button challenge the suite
 *      presses through the console - and verify it with the public key
 *
 * ## Named-only, like hardKeyProvision
 *
 * It changes the key's preferences and RSA slot 1 and reboots it, so it runs
 * only under --only hardKeyConfig; every test skips when the first did not arm.
 * The app must be pinned to the SOFT key while it runs (the app re-opens a
 * hard key that stops, and its console probe clears the console mid-sequence).
 */
'use strict';

const UsbPipeModule = require('../src/transport/UsbPipe');
const UsbPipe = UsbPipeModule.default || UsbPipeModule.UsbPipe;
const {getOnlyKey, resetOnlyKey} = require('../src/onlykey');

const PIN = '1234561';
const DERIVE_WITHOUT_TOUCH = 8;
const RSA_SLOT = 1;

const delay = ms => new Promise(r => setTimeout(r, ms));
let armed = false;
let shared = {};

function isNamed() {
  const only = require('./only.js');
  return Array.isArray(only) && only.includes('hardKeyConfig');
}

async function findKey() {
  const devices = await UsbPipe.listDevices();
  return devices.find(
    d => d.vendorId === UsbPipeModule.VENDOR_ID && d.productId === UsbPipeModule.PRODUCT_ID);
}

/** The same re-enumeration wait hardKeyProvision uses; see its comment. */
async function reopenAfterReboot({log, timeoutMs = 30000}) {
  const started = Date.now();
  try { await UsbPipe.stop(); } catch (_) { /* may already be gone */ }
  await resetOnlyKey('usb');
  let gone = false;
  for (;;) {
    const key = await findKey();
    if (!key) gone = true;
    if (gone && key && key.hasPermission) break;
    if (Date.now() - started > timeoutMs) {
      throw new Error(gone ? 'the key did not come back' : 'the key never left the bus');
    }
    await delay(500);
  }
  await delay(1500);
  await UsbPipe.start();
  log(`reopened after ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

module.exports = function hardKeyConfig({describe, it}) {
  describe(hardKeyConfig.name, () => {
    it('runs only when named, on an unlocked developer key', async ({log, assert, skip}) => {
      if (!isNamed()) skip('changes preferences and RSA slot 1 and reboots the key. Run it alone with --only hardKeyConfig.');
      const key = await findKey();
      if (!key) skip('no OnlyKey on the USB bus');
      if (!key.hasPermission) skip('no USB permission for the key');

      await UsbPipe.start();
      const {device} = await getOnlyKey('usb');
      const state = await device.connect();
      const status = String(state.status || '').trim();
      log(`before: ${JSON.stringify(status)}`);
      if (!(await device.consoleAnswers())) skip('this key does not read its console');
      if (!/UNLOCKED/i.test(status)) {
        log('locked; unlocking with the bench PIN');
        await device.unlock(PIN);
      }
      armed = true;
      assert.ok(armed);
    });

    it('enters config mode: the gesture lands and the key locks', async ({log, assert, skip}) => {
      if (!armed) skip('not armed');
      const {device} = await getOnlyKey('usb');
      const result = await device.enterConfigMode({
        /* The hard key's hold: the whole duration up front, on the console. */
        hold: (button, ticks) => device.press(`${button}#${ticks}`),
        attempts: 2,
        lockMs: 10000,
      });
      log(`config mode after ${result.attempts} attempt(s): button ${result.gesture.button}`);
      assert.ok(result.entered);

      await device.unlock(PIN, {timeoutMs: 20000});
      /* The unlock in config mode is never announced; a label read proves it. */
      const deadline = Date.now() + 20000;
      for (;;) {
        try { await device.readLabels({timeoutMs: 2500}); break; } catch (e) {
          if (Date.now() > deadline) throw new Error('never readable after the PIN: ' + e.message);
        }
      }
      log('unlocked again, in config mode');
    });

    it('sets touch-free per-site derive, which the vault needs', async ({log, assert, skip}) => {
      if (!armed) skip('not armed');
      const {device} = await getOnlyKey('usb');
      const result = await device.setPreference('derivedChallengeMode', DERIVE_WITHOUT_TOUCH);
      log(`derivedChallengeMode -> ${JSON.stringify(result.response ?? result)}`);
      assert.ok(!/^Error/i.test(String(result.response || '')), String(result.response));
    });

    it('loads a composite PGP key into RSA slot 1, acknowledged', async ({log, assert, skip}) => {
      if (!armed) skip('not armed');
      const openpgp = require('node-onlykey-lib/crypto/pgp');
      const {device, okcrypto} = await getOnlyKey('usb');

      const generated = await okcrypto.composite.generateCompositeKey(openpgp, {
        userId: {name: 'bench', email: 'bench@example.invalid'},
      });
      shared.armoredPublicKey = generated.armoredPublicKey;
      log(`generated; blob ${generated.blob.length} bytes`);

      const acks = [];
      const off = device.on('progress', e => { if (e.step === 'keyAck') acks.push(e.response); });
      try {
        await device.loadKey(RSA_SLOT, {type: okcrypto.composite.PQC_KEY_TYPE_BYTE, key: generated.blob});
      } finally {
        off();
      }
      generated.blob.fill(0);
      log(`device said: ${JSON.stringify(acks)}`);
      assert.ok(acks.length > 0, 'the load was not acknowledged');
    });

    it('restarts to leave config mode, and unlocks again', async ({log, assert, skip}) => {
      if (!armed) skip('not armed');
      const {device} = await getOnlyKey('usb');
      await device.restart();
      await reopenAfterReboot({log});
      const {device: fresh} = await getOnlyKey('usb');
      const state = await fresh.connect();
      log(`after restart: ${JSON.stringify(String(state.status || '').trim())}`);
      const seen = String(await fresh.unlock(PIN)).trim();
      log(`unlocked: ${JSON.stringify(seen)}`);
      assert.ok(/UNLOCKED/i.test(seen), 'the key did not unlock after the restart');
    });

    it('SIGNS THROUGH THE KEY, and the signature verifies', async ({log, assert, skip}) => {
      if (!armed || !shared.armoredPublicKey) skip('no key loaded');
      const openpgp = require('node-onlykey-lib/crypto/pgp');
      const {device, okcrypto} = await getOnlyKey('usb');
      const messages = okcrypto.messages;

      const pub = await openpgp.readKey({armoredKey: shared.armoredPublicKey});
      const deviceKey = openpgp.createHardwarePrivateKey(pub);
      okcrypto.registerPgpHooks(openpgp, RSA_SLOT);

      /*
       * Each half raises a three-button challenge computed from the bytes;
       * the library tells us the digits and this presses them through the
       * console. A real finger would do the same.
       */
      const off = okcrypto.on('challenge', ({digits}) => {
        log(`challenge: press ${digits.join('-')}`);
        (async () => {
          await delay(300);
          for (const d of digits) await device.press(String(d));
        })().catch(e => log(`press failed: ${e.message}`));
      });

      try {
        const text = 'signed on the key, not on the phone';
        const signed = await messages.signText(openpgp, {text, signWith: deviceKey});
        log(`signed: ${String(signed).length} chars`);
        const result = await messages.verifyText(openpgp, {armored: String(signed), verifyWith: shared.armoredPublicKey});
        log(`verify: ${result.valid}`);
        assert.ok(result.valid, 'the device-made signature did not verify');
      } finally {
        off();
        openpgp.clearHardwareHooks();
      }
    });

    it('and the key is handed back to the phone', async ({log, assert, skip}) => {
      if (!armed) skip('not armed');
      await resetOnlyKey('usb');
      await UsbPipe.stop();
      log('interfaces released');
      assert.equal(UsbPipe.isRunning(), false);
    });
  });
};
