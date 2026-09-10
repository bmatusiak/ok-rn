/**
 * Sign with a key the device holds, over the vendor path.
 *
 * The okcrypto plugin carried a comment saying this could not be written
 * without checking two things against real firmware. Both were checked, both
 * were real, and this is where they are proven rather than argued:
 *
 *   FRAMING. process_packets() reads buffer[4] as the command, buffer[5] as the
 *   SLOT, buffer[6] as 0xFF-or-length and buffer[7..] as data
 *   (okcore.cpp:7472-7519). The hex chunker used for OKRESTORE writes the same
 *   64-byte frame with NO slot byte, which would put the length where the slot
 *   is read. Both framings are 64 bytes; only the device can tell them apart,
 *   which is why a unit test cannot replace this one.
 *
 *   THE RESPONSE. Pushed unsolicited as one 64-byte report, and PLAINTEXT
 *   despite send_transport_response's encrypt argument, which is ignored unless
 *   outputmode is WEBAUTHN (okcore.cpp:2840-2846).
 *
 * A third thing turned up that no amount of reading the plugin would have
 * suggested, and it shapes this whole file: LOADING A KEY REQUIRES CONFIG MODE,
 * SIGNING IS FORBIDDEN IN IT, AND CONFIG MODE ENDS ONLY AT RESTART.
 *
 *   OKSETPRIV is accepted only when `configmode == true` or on first use
 *   (okcore.cpp:452). Config mode is entered by a >=72-tick hold on button 6,
 *   which also LOCKS the device (OnlyKey.ino:914-926). recvmsg()'s config-mode
 *   allowlist does not include OKSIGN (okcore.cpp:347), so signing there is
 *   refused - and `configmode` is assigned false exactly once, at its
 *   definition (okcore.cpp:161), so nothing turns it off again.
 *
 * So provisioning a signing key and using it cannot happen in one firmware
 * lifetime. This suite therefore provisions on one invocation and signs on the
 * next, which is the device's shape rather than a convenience.
 *
 * THE DEVICE MUST BE UNLOCKED and out of the post-ceremony window in which
 * presses are discarded, which is why this runs last.
 */
'use strict';

const {getOnlyKey} = require('../src/onlykey');
const {pressDigits} = require('./helpers/pressDigits');
const {setTouchFreeDerive} = require('./helpers/touchFreeDerive');
const {protocol} = require('node-onlykey-lib');

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;
const {IFACE, PRESS_TICKS} = OkEmuModule;

const delay = ms => new Promise(r => setTimeout(r, ms));

const PIN = '1234561';

/** An ECC slot in the range okcrypto_sign accepts (101-116). */
const SLOT = 101;

/*
 * Ed25519 with the signature bit set.
 *
 * okcrypto_sign refuses a slot whose feature bits lack bit 6 ("Error key not
 * set as signature key"), so the modifier is not decoration - without it the
 * device answers with a refusal that looks much like a framing failure.
 */
const KEY_TYPE = 1 | 0x40;          // CURVE.ED25519 | MODIFIER.SIGNATURE
const KEY = new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff);

/**
 * The gesture that reaches config mode.
 *
 * Comfortably inside the 72..179 window: below 72 it is an ordinary hold, and
 * on button 6 there is nothing above it to overshoot into. This is the one
 * place in the suite that deliberately asks for the gesture band, which is why
 * it is the one place that passes allowGesture.
 */
const CONFIG_TICKS = 80;

/**
 * Wait for the device to SAY something on the vendor interface.
 *
 * The status replies are plain ASCII in a 64-byte report, so matching text is
 * what a host actually does with them.
 *
 * This exists because the alternative - do the thing, sleep, then read what the
 * DEBUG console happened to have printed - is a race the device wins whenever
 * it is slow. A key write erases a flash sector first, and on some devices that
 * takes longer than the sleep did: the console tap came back EMPTY and the test
 * reported "the key write never reached ecc_priv_flash", which was measurably
 * false. The write had landed; the test looked too early.
 *
 * Listening from BEFORE the request, and resolving on the answer, cannot lose
 * that race - and it works on a production build too, where there is no debug
 * console to sniff at all.
 */
function vendorSays(pattern, {timeoutMs = 15000} = {}) {
  let seen = '';
  let settle;
  const done = new Promise((resolve, reject) => {
    settle = {resolve, reject};
  });
  const off = OkEmu.on('stream', e => {
    if (e.iface !== IFACE.VENDOR || e.dir !== 0) return;
    let s = '';
    for (const b of e.bytes) {
      if (b >= 0x20 && b <= 0x7e) s += String.fromCharCode(b);
    }
    seen += s;
    if (pattern.test(seen)) settle.resolve(seen);
  });
  const timer = setTimeout(
    () => settle.reject(new Error(
      `the device never said anything matching ${pattern} - it said ` +
      `${JSON.stringify(seen.slice(-120))}`)),
    timeoutMs,
  );
  return {
    off: () => {
      off();
      clearTimeout(timer);
    },
    get seen() { return seen; },
    done,
  };
}

/** What the device says on SEREMU - the only witness some writes have. */
function serialTap() {
  let text = '';
  const off = OkEmu.on('stream', e => {
    if (e.iface !== IFACE.SEREMU || e.dir !== 0) return;
    for (const b of e.bytes) {
      if (b >= 0x20 && b <= 0x7e) text += String.fromCharCode(b);
      else if (b === 0x0a) text += '\n';
    }
  });
  return {read: () => text, take: () => { const o = text; text = ''; return o; }, off};
}

/**
 * Is there a signing key in the slot?
 *
 * OKGETPUBKEY rather than a trial signature: it needs no challenge, leaves no
 * CRYPTO_AUTH state behind, and okcore_flashget_ECC answers an empty slot with
 * "Error no ECC Private Key set in this slot" (okcore.cpp:5243-5245). A trial
 * signature would tell us the same thing at the cost of three button presses
 * and a five-second wipe timer.
 */
async function probeKey(transport, log) {
  const {MSG} = protocol.msg;
  try {
    const reply = await transport.request({
      iface: IFACE.VENDOR,
      data: protocol.okmsg.build({msg: MSG.OKGETPUBKEY, slot: SLOT}),
      timeoutMs: 4000,
      match: r => protocol.okmsg.parseState(r).state !== 'unlocked'
        && protocol.okmsg.parseState(r).state !== 'locked',
    });
    const text = protocol.okmsg.text(reply);
    if (/no ECC Private Key/i.test(text)) {
      log(`slot ${SLOT}: empty (${text.trim()})`);
      return false;
    }
    log(`slot ${SLOT}: holds a key (${reply.length} bytes back)`);
    return true;
  } catch (e) {
    log(`probe failed: ${e.message}`);
    return false;
  }
}

/**
 * Answer the challenge, one press at a time, stopping the moment it is taken.
 *
 * HOW MANY presses are needed is a device preference the host cannot read. With
 * the slot's challenge mode set to 1 the firmware accepts ANY single press and
 * never computes the digits at all (OnlyKey.ino:821, okcore.cpp:7571-7587);
 * with it at 0 the three digits are checked in order. Measured on this device:
 * one press of button 2 satisfied a challenge whose digits were 1-6-6, and the
 * firmware logged "Challenge3 entered2".
 *
 * Pressing on regardless is not harmless. The device is unlocked, so a press
 * the challenge did not consume runs gen_press() and types a slot at the
 * keyboard.
 */
async function pressChallenge(digits, log, isAnswered = () => false) {
  const pressed = [];
  for (const d of digits) {
    await OkEmu.holdTicks(d, PRESS_TICKS.TAP);
    pressed.push(d);
    /*
     * payload() only runs a press once key_off has passed two further loop
     * iterations (okcore.cpp:2723), so back-to-back holds would be counted as
     * one long one. This is the gap between presses, not a guess at how fast
     * the device is - the tick counter already handles that part.
     */
    await delay(600);
    if (isAnswered()) break;
  }
  log(`pressed ${pressed.join('-')} of ${digits.join('-')}`);
  return pressed;
}

let shared = null;
async function ready(log) {
  if (shared) return shared;
  if (!OkEmu.isRunning()) await OkEmu.start();

  const {device, okcrypto, transport} = await getOnlyKey();
  const state = await device.connect();
  log(`device: ${String(state.status).trim()}`);

  shared = {device, okcrypto, transport, status: String(state.status), present: false};
  shared.present = await probeKey(transport, log);
  return shared;
}

module.exports = function cryptoSign({describe, it}) {
  describe(cryptoSign.name, () => {
    it('the plugin no longer claims it cannot sign', async ({log, assert}) => {
      const {okcrypto, status} = await ready(log);
      assert.ok(/UNLOCKED/i.test(status), 'the device is locked; OKSIGN is refused');

      const ops = okcrypto.deviceOperations;
      log(`operations: ${JSON.stringify(ops)}`);
      assert.equal(ops.compositeSign, true);
      assert.equal(ops.compositeDecrypt, true);

      /*
       * The derive pair is implemented and proven now (suite 10-derive), so
       * this asserts what is TRUE rather than pinning a sentence.
       */
      assert.equal(ops.derivePublicKey, true);
      assert.equal(ops.deriveSharedSecret, true);

      /*
       * Nothing is unavailable any more. The reason field has blamed a missing
       * CTAPHID transport, then a missing key exchange, then X-Wing's response
       * shape - each true when written and stale within a chunk. It is empty
       * now, which is the only state that cannot go out of date.
       */
      assert.equal(ops.deriveXwing, true);
      assert.equal(ops.reason, '', `nothing is missing, but reason says: ${ops.reason}`);
    });

    it('provisions a signing key if the slot is empty, which needs config mode', async ({
      log,
      assert,
    }) => {
      const {device, transport} = await ready(log);
      if (shared.present) {
        log('already provisioned; nothing to do');
        assert.ok(true);
        return;
      }

      const tap = serialTap();
      try {
        /*
         * The hold that reaches config mode also locks the device, so the PIN
         * has to go back in before anything will be accepted. Both halves are
         * the firmware's design, not a workaround.
         */
        log(`holding button 6 for ${CONFIG_TICKS} ticks`);
        await OkEmu.holdTicks(6, CONFIG_TICKS, {allowGesture: true});
        await delay(2000);

        const said = tap.take();
        assert.ok(
          !/UNLOCKED/.test(said.split('\n').slice(-3).join('')),
          'the device should have locked itself on entering config mode',
        );

        await device.unlock(PIN, {timeoutMs: 20000, enterDigits: pressDigits({log})});
        log('unlocked again, now in config mode');

        /*
         * While we are in config mode anyway, turn on the preference the VAULT
         * needs (10-derive). Field 21 is gated on config mode
         * (okcore.cpp:2013), and reaching config mode costs a gesture that
         * also locks the device - so doing it twice in one run is two gestures
         * for one setting that persists in EEPROM.
         *
         * The vault derives its public key without a touch and its secret with
         * one, because the pairing decides the key - the press flag is an
         * INPUT to the derivation
         * (FINDING-the-press-flag-changes-the-derived-key.md). Without bit 3
         * the touch-free half is refused as CTAP2_ERR_EXTENSION_NOT_SUPPORTED,
         * and retrying with a touch would derive a DIFFERENT key.
         */
        log(`console after unlock: ${JSON.stringify(
          tap.take().split(String.fromCharCode(10)).filter(Boolean).slice(-8))}`);

        await setTouchFreeDerive(device, log);

        log(`console after the preference: ${JSON.stringify(
          tap.take().split(String.fromCharCode(10)).filter(Boolean).slice(-8))}`);

        /*
         * LISTEN FIRST, then write. The device answers "Successfully set ECC
         * Key" on the vendor interface (okcore.cpp, ecc_priv_flash) on every
         * release in the matrix, so there IS an acknowledgement - an earlier
         * version of this test said there was not and sniffed the DEBUG console
         * after a fixed 800ms instead.
         *
         * That was a race, and v3.0.2 won it: ecc_priv_flash erases a flash
         * sector before it answers, the console tap came back EMPTY, and the
         * test reported "the key write never reached ecc_priv_flash" about a
         * write that had landed. Waiting for the answer cannot lose that race,
         * and it works on a production build too, which has no console to sniff.
         */
        /*
         * loadKey now waits for the acknowledgement and retries, so this only
         * has to check that it came - see plugins/device/index.js. The retry
         * used to live here, which meant every other caller of loadKey still
         * had the fire-and-forget behaviour that lost the write.
         */
        const ack = vendorSays(/Successfully set ECC Key/);
        tap.take();
        try {
          const written = await device.loadKey(SLOT, {type: KEY_TYPE, key: KEY});
          log(`loadKey returned: ${JSON.stringify(written)}`);
          const said = await ack.done;
          log(`device answered: ${JSON.stringify(said.slice(-40))}`);
        } catch (e) {
          /*
           * SAY WHAT THE CONSOLE SAW. An acknowledgement that never arrives is
           * the least informative failure this suite can produce - it looks
           * identical whether the frame was refused, dropped, or answered on a
           * path nobody is watching. The DEBUG console sees all three
           * differently, so print it rather than leaving the next person to
           * rebuild this by hand.
           */
          const console_ = tap.take();
          log(`console after the write: ${JSON.stringify(
            console_.split(String.fromCharCode(10)).filter(Boolean).slice(-12))}`);
          throw e;
        } finally {
          ack.off();
        }

        shared.provisioned = true;
        log(
          'PROVISIONED. Signing cannot be proven in this firmware lifetime: ' +
            'OKSIGN is not on the config-mode allowlist and config mode ends ' +
            'only at restart. Run the suite again.',
        );
      } finally {
        tap.off();
      }
    });

    it('signs when the challenge is answered', async ({log, assert}) => {
      const {okcrypto} = await ready(log);
      if (!shared.present) {
        assert.ok(
          shared.provisioned,
          'no key, and provisioning did not run either',
        );
        log('deferred to the next invocation - the device is in config mode');
        return;
      }

      const payload = new Uint8Array(32).map((_, i) => (i * 3 + 1) & 0xff);
      const expected = protocol.challenge.challengeDigits(payload);
      log(`challenge should be ${expected.join('-')}`);

      const tap = serialTap();
      try {
        const signature = await okcrypto.composite_sign(SLOT, payload, {
          timeoutMs: 25000,
          confirm: ({digits, isAnswered}) => {
            assert.equal(
              digits.join('-'), expected.join('-'),
              'the plugin computed different digits than the test did',
            );
            return pressChallenge(digits, log, isAnswered);
          },
        });

        log(`signature: ${signature.length} bytes`);
        assert.equal(signature.length, 64, 'an Ed25519 signature is 64 bytes');

        /*
         * Not all zeros and not ASCII. A refusal is text and an unwritten
         * buffer is zeros; both are 64 bytes, so length alone would pass for
         * either.
         */
        assert.ok(
          signature.some(b => b !== 0),
          'the response is all zeros, so nothing was signed',
        );
        assert.ok(
          signature.some(b => b < 0x20 || b > 0x7e),
          'the response is printable text, so it is a message: ' +
            JSON.stringify(protocol.okmsg.text(signature)),
        );

        shared.signature = signature;
        shared.payload = payload;
      } catch (error) {
        log(`serial tail: ${JSON.stringify(tap.read().split('\n').filter(Boolean).slice(-8))}`);
        throw error;
      } finally {
        tap.off();
      }
    });

    it('signing the same bytes twice gives the same signature', async ({log, assert}) => {
      /*
       * Ed25519 is deterministic, so a second signature over the same payload
       * with the same key must be identical. Much stronger than "64 bytes came
       * back": it says the device used the key material rather than returning
       * whatever was in a buffer, and it would catch a framing error that made
       * the device sign a DIFFERENT set of bytes each time - which is precisely
       * what a missing slot byte causes.
       */
      const {okcrypto} = await ready(log);
      if (!shared.signature) {
        log('skipped: no signature from the previous test');
        assert.ok(!shared.present, 'a key is present but no signature was taken');
        return;
      }

      await delay(1500);
      const again = await okcrypto.composite_sign(SLOT, shared.payload, {
        timeoutMs: 25000,
        confirm: ({digits, isAnswered}) => pressChallenge(digits, log, isAnswered),
      });

      const hex = b => Array.from(b.slice(0, 8))
        .map(x => x.toString(16).padStart(2, '0')).join('');
      log(`first: ${hex(shared.signature)}...  again: ${hex(again)}...`);
      assert.equal(
        Array.from(again).join(','), Array.from(shared.signature).join(','),
        'the same bytes signed twice produced different signatures',
      );
    });

    it('one press is enough on this device, which is a preference', async ({log, assert}) => {
      /*
       * Recorded as a measurement rather than assumed, because it decides how a
       * caller must press: one at a time, stopping when the answer lands. The
       * count is not a constant and the host cannot read the preference, so
       * this is the only way to know.
       */
      const {okcrypto} = await ready(log);
      if (!shared.present) {
        log('skipped: no key in the slot');
        assert.ok(true);
        return;
      }

      await delay(6000);   /* let the previous attempt's 5s wipe timer pass */
      const payload = Uint8Array.from([0x11, 0x22, 0x33]);
      let pressed = null;
      const signature = await okcrypto.composite_sign(SLOT, payload, {
        timeoutMs: 25000,
        confirm: async ({digits, isAnswered}) => {
          pressed = await pressChallenge(digits, log, isAnswered);
        },
      });

      assert.equal(signature.length, 64);
      log(`confirmed after ${pressed.length} press(es) of 3`);
      assert.ok(
        pressed.length <= 3,
        'more presses were sent than the challenge has digits',
      );
    });
    /*
     * LAST, because it leaves the device unusable for the tests after it.
     *
     * An abandoned crypto operation does not simply time out: the next OKSIGN
     * comes back "Error device locked", which is the branch taken when
     * integrityctr1 != integrityctr2 (okcore.cpp:535). Walking away from a
     * challenge is not free.
     */
    it('nothing is signed without a press at all', async ({log, assert}) => {
      /*
       * What confirmation actually guarantees here, stated as the thing that
       * can be tested.
       *
       * "Three WRONG buttons are refused" was the obvious test and it is false
       * on this device: with the slot's challenge mode at 1 the firmware takes
       * ANY single press (OnlyKey.ino:821), so pressing 2-1-1 against digits of
       * 1-6-6 produced a signature and logged "Challenge3 entered2". Asserting
       * a refusal there would have been asserting a security property the
       * device does not have.
       *
       * What IS true in both modes is that SOMETHING must be pressed. That is
       * the property worth pinning, and it fails loudly if presence stops being
       * required.
       */
      const {okcrypto} = await ready(log);
      if (!shared.present) {
        log('skipped: no key in the slot');
        assert.ok(true);
        return;
      }

      await delay(1500);
      const tap = serialTap();
      let refused = null;
      try {
        await okcrypto.composite_sign(SLOT, Uint8Array.from([0xaa, 0xbb, 0xcc]), {
          timeoutMs: 6000,
          confirm: null,          // nobody touches the device
        });
      } catch (error) {
        refused = String(error.message);
      }

      const said = tap.read().split(String.fromCharCode(10)).filter(Boolean);
      tap.off();
      log(`firmware: ${JSON.stringify(said.filter(l => /Challenge|OKSIGN|Waiting/i.test(l)).slice(0, 6))}`);
      log(`refusal: ${refused}`);

      assert.ok(refused, 'the device signed with nobody pressing anything');
      assert.ok(
        /were those buttons pressed/.test(refused),
        'timed out, but the message does not say what the challenge was',
      );
      /*
       * No assertion on "Waiting for challenge buttons to be pressed": that
       * line only prints when okcrypto_ecdsa_eddsa is RE-ENTERED with
       * CRYPTO_AUTH between 1 and 3 (okcrypto.cpp:742-747). The first call
       * takes the !CRYPTO_AUTH branch and prints nothing, so expecting it here
       * was expecting the wrong line.
       */
    });

  });
};
