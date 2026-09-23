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

/**
 * Everything on the bus, for the one failure that keeps costing a sweep a run.
 *
 * "a PIN can be changed, and changed back" answers CTAP1_ERR_INVALID_COMMAND
 * about one run in four - measured at 4 of 15 across a full production sweep,
 * never moving to another test. The status is self-contradictory: the same
 * clientPin subcommand succeeded moments earlier, so the device plainly knows
 * it. Every occurrence follows another clientPin exchange, which is the shape
 * of a late reply being matched to the next request rather than of a device
 * refusing anything (compare
 * FINDING-a-collector-ate-the-previous-replys-reports.md, the same class one
 * layer down).
 *
 * So capture the wire and let the next failure say what is on it, instead of
 * being read as a device that forgot a command it had just run.
 * Soft key only: a real key over USB does not come through OkEmu.
 */
function busTap() {
  if (!OkEmu || typeof OkEmu.on !== 'function' || !OkEmu.isRunning || !OkEmu.isRunning()) {
    return {lines: () => ['(no soft-key bus to tap)'], off: () => {}};
  }
  const seen = [];
  const t0 = Date.now();
  const off = OkEmu.on('stream', e => {
    const hex = Array.from(e.bytes).slice(0, 20).map(b => b.toString(16).padStart(2, '0')).join('');
    const tag = ['kbd', 'fido', 'vend', 'ser'][e.iface] || e.iface;
    seen.push(`+${Date.now() - t0}ms ${tag}${e.dir === 0 ? '<' : '>'} ${hex}`);
  });
  return {lines: () => seen.slice(-40), off};
}


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
/*
 * THE SAME PINS onlykey-testing USES (`test/01-protocol/18-clientpin-credmgmt`,
 * PIN / NEW_PIN), so one bench key can be driven by either kit without the two
 * disagreeing about what its FIDO2 PIN is. They were 12345678 / 87654321 here,
 * which no other kit sets.
 */
const FIDO_PIN = '9137';
const FIDO_PIN_ALT = '2468';

/*
 * A PIN THAT IS WRONG BY CONSTRUCTION, rather than a literal that might be
 * somebody's real one.
 *
 * This was hardcoded '00000000'. That is a plausible real PIN - the maintainer
 * may use it - and on a key that had it set, `getPinToken('00000000')` would
 * SUCCEED, so the test would fail with "a wrong PIN was accepted" and send the
 * reader hunting a firmware bug that is not there. The wrong PIN has to be
 * derived from the right one to be reliably wrong.
 *
 * Digits only, and the same length, because the firmware's rules are about
 * both: a 4-digit minimum and a 63-byte maximum (ctap.cpp). Shifting every
 * digit by one keeps it a valid PIN that cannot equal the one it is derived
 * from.
 */
const wrongVersionOf = (pin) =>
  String(pin).replace(/[0-9]/g, (d) => String((Number(d) + 1) % 10));

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

  /*
   * PROVE THE PRESSES ARE DONE, rather than sleeping and hoping.
   *
   * This suite enters a seven-digit PIN and then immediately starts CTAP2
   * clientPIN work, and a run on 2026-09-23 failed here once with
   * CTAP1_ERR_INVALID_COMMAND - not reproduced in the several runs since. A
   * press still in flight was the obvious suspect, and the obvious response
   * was a settle.
   *
   * IT IS ALREADY SETTLED, structurally and better than a delay could manage:
   * pressQueue() ends with pressesDrained(), so it does not return until the
   * firmware has TAKEN every press, and unlock() then resolves on the device's
   * own UNLOCKED broadcast, which only happens once the PIN has been processed.
   * Adding a sleep on top of that would be a placebo with a comment - the
   * exact shape of the false justifications this suite has been clearing out.
   *
   * So the assumption is CHECKED instead. It costs one call, and if a press is
   * ever genuinely still queued here it says so by name rather than surfacing
   * three commands later as a CTAP error that names nothing.
   */
  const pending = await OkEmu.pressPending();
  if (pending !== 0) {
    throw new Error(
      `${pending} button press(es) were still queued when the PIN bracket `
      + 'returned. pressQueue() is supposed to drain before resolving, so '
      + 'either that guarantee broke or something queued presses behind it - '
      + 'and the CTAP commands below would be racing the keypad.');
  }

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
          await fido.getPinToken(wrongVersionOf(pin), {timeoutMs: 10000});
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

      /*
       * THE FIRST CHANGE IS THE ONE THAT FAILS. Not the second - there is
       * never an intervening log line when it goes wrong - so the 750ms
       * settle further down cannot be what protects it. See busTap() above.
       */
      const tap = busTap();
      try {
        await fido.changePin(pin, other, {timeoutMs: 10000});
      } catch (e) {
        await delay(1500);
        log(`bus across the failed changePin: ${JSON.stringify(tap.lines())}`);
        throw e;
      } finally {
        tap.off();
      }
      current = other;
      log(`changed to the ${other === FIDO_PIN ? 'primary' : 'alternate'} PIN`);

      const token = await fido.getPinToken(other, {timeoutMs: 10000});
      assert.equal(token.length, 16, 'the new PIN did not produce a token');

      /*
       * A BEAT BETWEEN THE TWO CHANGES, seen once and not explained.
       *
       * Running them back to back, the second answered
       * CTAP1_ERR_INVALID_COMMAND - not a PIN error, not a policy error, the
       * code for a command the authenticator does not recognise, for a
       * clientPin it had just executed. It left the key on the alternate PIN,
       * which authenticate() then recovered at the cost of one attempt.
       *
       * A changePin writes flash (ctap_update_pin -> authenticator_write_state)
       * and a second one lands while that is settling, so a pause is the
       * cheap guess. It is a GUESS: one occurrence, no diagnosis, and the
       * next one to see it should say so rather than assume this fixed it.
       */
      await delay(750);

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
