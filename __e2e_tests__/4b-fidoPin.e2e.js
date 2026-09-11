/**
 * The FIDO2 PIN, on the SOFT key.
 *
 * clientpin.js and FidoAdmin were written against the firmware source and
 * pinned by unit tests with node:crypto as the oracle. This is the first time
 * those bytes meet the firmware itself - the same C, compiled for arm64 and
 * running in the emulator - which is the only thing that can prove the shared
 * secret, the zero IV and the 64-byte padding are all right at once.
 *
 * ## Why the soft key and not the bench key
 *
 * Eight wrong attempts lock the FIDO2 side of a key PERMANENTLY
 * (PIN_LOCKOUT_ATTEMPTS, ctap.h:170), and three lock it until it is replugged
 * (PIN_BOOT_ATTEMPTS, ctap.h:171). Nothing restores the lifetime counter
 * except a correct PIN or a reset that destroys every credential. The soft
 * key can be rebuilt from source; the bench key cannot.
 *
 * So this suite spends AT MOST ONE wrong attempt per run, in one test, and
 * immediately restores the counter with a correct one - which is exactly what
 * the firmware does on success (ctap_reset_pin_attempts, ctap.cpp:2642).
 *
 * ## The device must be unlocked
 *
 * okcore.cpp:639,651 gate FIDO dispatch on `unlocked == true` and drop
 * packets silently otherwise, so a locked device is indistinguishable from a
 * dead one on this interface.
 *
 * ## Reset is not exercised here
 *
 * `FidoAdmin.reset()` erases every resident credential behind a single button
 * press. The confirmation guard is tested (nothing reaches the device without
 * the exact words), the reset itself is not: a suite that wipes an
 * authenticator as a side effect of running is a suite nobody can run twice.
 */
'use strict';

const {getOnlyKey} = require('../src/onlykey');
const {pressDigits} = require('./helpers/pressDigits');
const {protocol, device: deviceLib} = require('node-onlykey-lib');

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;

const {CtapHid} = protocol.ctaphid;
const {FidoAdmin, RESET_CONFIRMATION} = deviceLib.fido;

const PIN = '1234561';

/*
 * The soft key's FIDO2 PIN. Two of them, because the change test has to leave
 * the key somewhere: it goes PRIMARY -> ALTERNATE -> PRIMARY, and if a run
 * dies between the two the key is left on ALTERNATE. `authenticate()` below
 * therefore tries PRIMARY and then ALTERNATE rather than failing - the cost
 * of the second try is one attempt, and the correct one that follows puts the
 * counter straight back.
 */
const FIDO_PIN = '12345678';
const FIDO_PIN_ALT = '87654321';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let session = null;

async function unlocked(log) {
  if (session) return session;

  if (!OkEmu.isRunning()) await OkEmu.start();
  const {device, transport} = await getOnlyKey();

  let status = 'already unlocked';
  const state = await device.connect();
  if (!/UNLOCKED/i.test(String(state.status))) {
    status = await device.unlock(PIN, {timeoutMs: 20000, enterDigits: pressDigits({log})});
  }
  log(`device: ${status}`);

  /* U2Finit() runs during unlock; the first FIDO packet after it is eaten by
   * the Android double-recv workaround (okcore.cpp:652-658). */
  await delay(500);

  const ctap = new CtapHid(transport);
  await ctap.init({timeoutMs: 8000});
  await delay(200);

  session = {device, transport, ctap, fido: new FidoAdmin(ctap)};
  return session;
}

/** The PIN this key currently has, discovered at most once per run. */
let current = null;

async function authenticate(fido, log) {
  if (current) return current;
  for (const candidate of [FIDO_PIN, FIDO_PIN_ALT]) {
    try {
      await fido.getPinToken(candidate, {timeoutMs: 10000});
      current = candidate;
      log(`the key's FIDO2 PIN is the ${candidate === FIDO_PIN ? 'primary' : 'alternate'} one`);
      return current;
    } catch (e) {
      log(`not ${candidate}: ${e.message}`);
    }
  }
  throw new Error('neither known FIDO2 PIN was accepted - do not guess another');
}

module.exports = function fidoPin({describe, it}) {
  describe(fidoPin.name, () => {
    it('reports PIN protocol 1, and only protocol 1', async ({log, assert}) => {
      /*
       * The correction that reshaped this whole module. The earlier plan
       * assumed protocol 2; ctap.cpp:2217 returns CTAP1_ERR_OTHER for
       * anything that is not 1, which means no HKDF and no explicit IV.
       */
      const {fido} = await unlocked(log);
      const state = await fido.pinState({timeoutMs: 10000});

      log(`protocols: ${JSON.stringify(state.protocols)}, pin set: ${state.set}`);
      assert.ok(Array.isArray(state.protocols), 'getInfo listed no pinProtocols');
      assert.ok(state.protocols.includes(1), 'protocol 1 is the only one this firmware parses');
      assert.equal(state.protocols.includes(2), false, 'protocol 2 is not implemented here');
      assert.equal(state.supported, true, 'clientPin is absent from the options map');
    });

    it('getRetries answers without a PIN and without spending one', async ({log, assert}) => {
      /*
       * The cheapest live check there is: no PIN, no user presence, no
       * counter movement. If this answers, the CBOR shape and the clientPin
       * dispatch are both right.
       */
      const {fido} = await unlocked(log);
      const before = await fido.getRetries({timeoutMs: 10000});
      const after = await fido.getRetries({timeoutMs: 10000});

      log(`retries: ${before}`);
      assert.equal(typeof before, 'number', 'no retry count came back');
      assert.ok(before >= 1 && before <= 8, `retries out of range: ${before}`);
      assert.equal(after, before, 'asking cost an attempt, which it must not');
    });

    it('a PIN can be set, and the pinToken comes back decryptable', async ({log, assert}) => {
      /*
       * Everything at once: ECDH against the device's key agreement key,
       * SHA-256 of the x coordinate, AES-256-CBC with a zero IV, the 64-byte
       * zero padding that the firmware reads as the length, and the truncated
       * HMAC. A pinToken that decrypts to 16 bytes cannot happen by accident -
       * the firmware encrypted it under a secret we derived independently.
       */
      const {fido} = await unlocked(log);
      const state = await fido.pinState({timeoutMs: 10000});

      if (!state.set) {
        await fido.setPin(FIDO_PIN, {timeoutMs: 10000});
        current = FIDO_PIN;
        log(`set the FIDO2 PIN to ${FIDO_PIN}`);
        assert.equal((await fido.pinState({timeoutMs: 10000})).set, true,
          'the device still says no PIN is set');
      } else {
        log('a PIN was already set; not setting one again');
      }

      const pin = await authenticate(fido, log);
      const token = await fido.getPinToken(pin, {timeoutMs: 10000});

      assert.equal(token.length, 16, `pinToken is ${token.length} bytes, expected 16`);
      assert.equal(token.every(b => b === 0), false, 'a pinToken of all zeros means it did not decrypt');
    });

    it('setPin on a key that has one is refused before anything is sent', async ({log, assert}) => {
      const {fido} = await unlocked(log);
      await authenticate(fido, log);

      let message = null;
      try {
        await fido.setPin('99999999', {timeoutMs: 10000});
      } catch (e) {
        message = e.message;
      }
      log(`refused with: ${message}`);
      assert.ok(message && /already set/.test(message), 'setPin was not refused locally');
    });

    it('a wrong PIN spends exactly one attempt, and a right one restores it',
      async ({log, assert}) => {
        /*
         * ONE wrong attempt, deliberately, and only here. Three per boot lock
         * the FIDO2 side until a replug, so a second one in the same run is
         * not spare capacity - it is the last one before the suite starts
         * breaking the device it is testing.
         *
         * What this proves that a unit test cannot: the firmware and this
         * client agree on what a WRONG pinHashEnc looks like. If our
         * encryption were wrong in a way that produced garbage rather than a
         * wrong hash, every PIN would look wrong - including the correct one
         * on the next line.
         */
        const {fido} = await unlocked(log);
        const pin = await authenticate(fido, log);

        const before = await fido.getRetries({timeoutMs: 10000});
        assert.ok(before >= 3, `only ${before} attempts left - not spending one`);

        let failure = null;
        try {
          await fido.getPinToken('00000000', {timeoutMs: 10000});
        } catch (e) {
          failure = e;
        }
        assert.ok(failure, 'a wrong PIN was accepted');
        log(`refused: ${failure.message}`);

        const spent = await fido.getRetries({timeoutMs: 10000});
        assert.equal(spent, before - 1, `one wrong PIN moved the counter from ${before} to ${spent}`);

        /* And the firmware puts it all the way back on success, not by one. */
        await fido.getPinToken(pin, {timeoutMs: 10000});
        const restored = await fido.getRetries({timeoutMs: 10000});
        log(`restored to ${restored}`);
        assert.ok(restored > spent, 'a correct PIN did not restore the counter');
      });

    it('a PIN can be changed, and changed back', async ({log, assert}) => {
      /*
       * changePin is the only subcommand whose pinAuth covers two fields, and
       * the order matters: newPinEnc then pinHashEnc (ctap.cpp:2050-2056).
       * The other order is a valid HMAC of the wrong message.
       */
      const {fido} = await unlocked(log);
      const pin = await authenticate(fido, log);
      const other = pin === FIDO_PIN ? FIDO_PIN_ALT : FIDO_PIN;

      await fido.changePin(pin, other, {timeoutMs: 10000});
      current = other;
      log(`changed to the ${other === FIDO_PIN ? 'primary' : 'alternate'} PIN`);

      const token = await fido.getPinToken(other, {timeoutMs: 10000});
      assert.equal(token.length, 16, 'the new PIN did not produce a token');

      await fido.changePin(other, FIDO_PIN, {timeoutMs: 10000});
      current = FIDO_PIN;
      const back = await fido.getPinToken(FIDO_PIN, {timeoutMs: 10000});
      assert.equal(back.length, 16, 'the key did not come back to the primary PIN');
      log('back on the primary PIN');
    });

    it('reset needs the exact words, and a near miss reaches no device',
      async ({log, assert}) => {
        /*
         * The reset ITSELF is not run: it erases all twelve resident
         * credentials and regenerates the key space, guarded by one button
         * press and nothing else (ctap.cpp:2417-2424). What is tested is that
         * the guard in front of it cannot be tripped by a stray truthy value.
         */
        const {fido} = await unlocked(log);

        for (const attempt of [true, 'yes', RESET_CONFIRMATION.toLowerCase(), '']) {
          let refused = false;
          try {
            await fido.reset(attempt, {timeoutMs: 5000});
          } catch (e) {
            refused = /exact confirmation/.test(e.message);
          }
          assert.ok(refused, `fido reset accepted ${JSON.stringify(attempt)}`);
        }
        log(`only "${RESET_CONFIRMATION}" gets through, and this suite never sends it`);
      });
  });
};
