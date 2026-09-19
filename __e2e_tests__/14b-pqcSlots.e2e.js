/**
 * Post-quantum keys GENERATED INSIDE the key, into an ordinary ECC slot.
 *
 * The library could already derive an X-Wing key over CTAPHID for a label,
 * which lives in no slot and is recomputed each time. This is the other kind,
 * the one the Python age plugin uses: a 32-byte seed made in the key,
 * encrypted with the profile key, written to flash, and never crossing the
 * wire in either direction. Only the public half comes back.
 *
 * ## Why the read-back is of the PREVIOUS run's key
 *
 * Generating needs CONFIG MODE. Reading a public key is REFUSED in config
 * mode, silently - the device logs `ERROR NOT SUPPORTED IN CONFIG MODE` to a
 * debug console that production firmware does not have, and sends nothing at
 * all on the wire (FINDING-config-mode-refuses-a-public-key-read-in-silence.md).
 *
 * And config mode ends only at a power cycle. The emulator has no in-process
 * reset: the firmware's CPU_RESTART() writes AIRCR, `OkEmu.restart()` says so
 * in as many words, and stopping and starting it inside a run leaves "firmware
 * is not running". The real power cycle is the runner force-stopping the app
 * between runs.
 *
 * So one run cannot both generate and read back, and pretending otherwise is
 * what the first three attempts at this suite did. Instead the first test
 * reads what the LAST run generated - which proves something better than a
 * read-back would, because the key has survived a power cycle to get there.
 * On a device that has never run this suite it skips and says so.
 *
 * ## Why it runs LAST among the soft-key suites
 *
 * It leaves the device in config mode, deliberately - there is no way not to.
 * Config mode silences CTAPHID, so every suite that derives anything would
 * fail after it with a timeout that says nothing about why. The next run's
 * force-stop clears it.
 *
 * ## What can go wrong, and what it would cost
 *
 * The trigger is a SUM, not a flag: set_private() adds the eight key bytes and
 * compares against 2040 (okcore.cpp:5311). Anything else is an ordinary key
 * write, so a client that got the payload wrong would quietly store eight
 * bytes of nonsense as a private key rather than generate one.
 */
'use strict';

const {getOnlyKey} = require('../src/onlykey');
const {pressDigits} = require('./helpers/pressDigits');
const {device: deviceLib} = require('node-onlykey-lib');

const OkEmuModule = require('../src/transport/OkEmu');
const {buildInfo} = require('../src/buildInfo');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;

const {KEY_TYPE} = deviceLib.keys;

const PIN = '1234561';
/*
 * SLOTS NOTHING ELSE TOUCHES.
 *
 * 9-cryptoSign signs from 101, loads SSH into 103, and probes 105, 106, 116
 * and 133 as EMPTY slots to prove the picker offers the right range. An
 * earlier version of this suite generated into 105 and 106, and the full run
 * went red on a test that had every right to expect them empty - the failure
 * appeared in a completely different suite, which is the expensive kind.
 *
 * 110..112 are in the user range (101..116) and are used by nothing else.
 */
const SLOT = 110;
const OTHER_SLOT = 111;
const MLKEM_SLOT = 112;
const XWING_BYTES = 1216;

/** A tap: long enough to register, short enough not to be a gesture. */
const TAP = 4;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Press the three buttons, and STOP EARLY once the device has answered.
 *
 * For slots 101..116 the firmware reads the stored-key challenge preference,
 * and when it is on it never computes the digits at all - CRYPTO_AUTH goes
 * straight to 3 and ANY single press confirms (okcore.cpp:7567-7573).
 * Measured here: one generation took two presses and the next took one,
 * against digits of 1-2-1.
 *
 * The presses after the answer are not harmless. On an unlocked device a
 * stray press runs gen_press() and types a slot at the keyboard.
 */
async function pressChallenge(digits, log, isAnswered = () => false) {
  const pressed = [];
  for (const d of digits) {
    /* HANDED to the firmware, not sensed - one sense round rather than ~14. */
    await OkEmu.pressQueue(String(d), TAP);
    pressed.push(d);
    /*
     * payload() runs a press only once key_off has passed two further loop
     * iterations (okcore.cpp:2723), so back-to-back holds count as one long
     * one. The gap is that, not a guess at the device's speed.
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

  const {device} = await getOnlyKey();
  let state = await device.connect();
  log(`device: ${String(state.status).trim()}`);

  if (!/UNLOCKED/i.test(String(state.status))) {
    await device.unlock(PIN, {timeoutMs: 20000, enterDigits: pressDigits({log})});
    /*
     * ASKED AGAIN, because a LOCKED device announces INITIALIZED and nothing
     * else - no version, no model letter. Reading capabilities from that says
     * "this firmware has nothing", and the first run of this suite duly
     * skipped all of its own tests against a key that supports every one.
     */
    state = await device.connect();
    log(`unlocked: ${String(state.status).trim()}`);
  }

  /*
   * THE HINT, or this suite skips itself on a production working tree.
   *
   * Its first test gates the whole suite on `postQuantum`, and a working tree
   * built with OKEMU_PRODUCTION=1 reports v3.0.4-prodc - indistinguishable on
   * the wire from the release, which has none. Without this the run reports
   * green while exercising nothing, which is the worst answer available.
   */
  const caps = deviceLib.version.capabilities(String(state.status).trim(), {
    unreleased: buildInfo.unreleased,
  });
  shared = {device, caps, configMode: false, generated: null, stored: null};
  return shared;
}

module.exports = function pqcSlots({describe, it}) {
  describe(pqcSlots.name, () => {
    it('this firmware has post-quantum support at all', async ({log, assert, skip}) => {
      /*
       * NO RELEASED FIRMWARE DOES. Measured across every pin in
       * ok-versions.json: okpqc.cpp does not exist at v2.1.0, v2.1.1, v3.0.0,
       * v3.0.1 or v3.0.2, and neither post-quantum key type is in okcore.h at
       * any of them. On a matrix run against a real release this whole suite
       * is expected to skip, and that is the measurement, not a gap.
       */
      const {caps} = await ready(log);
      log(`postQuantum: ${caps.postQuantum}`);
      if (!caps.postQuantum) {
        skip('this firmware predates post-quantum support - no release has it');
      }
      assert.ok(caps.postQuantum);
    });

    it('the key an EARLIER run generated is still in the slot',
      async ({log, assert, skip}) => {
        /*
         * The storage proof, and a stronger one than reading back inside the
         * run that wrote it: this key has survived a power cycle. It is also
         * the check the firmware comment at okcore.cpp:5342 exists for - the
         * PQC keygens store their own seed and must not fall through to the
         * ordinary write, or the slot holds E(E(seed)) and reads back a
         * DIFFERENT key from the one reported. Anything encrypted to the
         * first would be unreadable by anyone.
         */
        const s = await ready(log);
        if (!s.caps.postQuantum) {
          skip('no post-quantum support');
        }

        let key = null;
        try {
          key = await s.device.getPublicKey(SLOT, {
            bytes: XWING_BYTES,
            keyType: KEY_TYPE.XWING,
            timeoutMs: 15000,
          });
        } catch (e) {
          log(`slot ${SLOT}: ${e.message}`);
          skip(
            'nothing in the slot yet - the generation below fills it, and this ' +
            'test measures it on the next run',
          );
        }

        log(`slot ${SLOT} holds ${key.length} bytes`);
        assert.equal(key.length, XWING_BYTES, 'pk_M(1184) || pk_X(32), okcore.h:240');

        /*
         * A truncated read looks like a key until something uses it, and the
         * X25519 half is the LAST 32 bytes - so it is what disappears first.
         */
        assert.equal(key.subarray(1184).every(b => b === 0), false,
          'the X25519 half is all zeros - the read ended early');
        assert.equal(key.every(b => b === 0), false, 'the whole key is zeros');

        s.stored = key;
      });

    it('A FILE ENCRYPTED TO IT IS OPENED BY THE DEVICE ITSELF',
      async ({log, assert, skip}) => {
        /*
         * The end of the whole post-quantum slot story, and the first time a
         * stored key has been USED rather than made and described.
         *
         * Encryption is host-side and needs no device: a recipient is public.
         * Decryption is the part that cannot be faked - the file key is
         * unwrapped with a shared secret that only the seed in flash can
         * produce, so plaintext coming back out means the device really holds
         * the private half of the key it reported.
         *
         * ## Why this is NOT the derived path with a number instead of a label
         *
         * The two send different things and get different things back:
         *
         *   label   ct_X only, 32 bytes  ->  64 back, and the HOST finishes
         *           the ML-KEM half from the seed
         *   slot    the WHOLE ciphertext, 1120  ->  32 back, which ARE the
         *           shared secret; the DEVICE ran the combiner
         *
         * A client that sent ct_X here is refused on length
         * (okcrypto.cpp:2069). A client that ALSO ran the ML-KEM half would
         * not be refused by anything - it would simply produce the wrong
         * secret and fail to open the file, with nothing saying why.
         *
         * ## Before config mode, deliberately
         *
         * Config mode answers eleven message types and silently drops the
         * rest (okcore.cpp:347); OKDECRYPT is not among them, exactly as
         * OKGETPUBKEY is not. So this runs while the device is still ordinary,
         * against the key a PREVIOUS run generated.
         */
        const s = await ready(log);
        if (!s.stored) {
          skip('no stored key yet - the generation below fills the slot');
        }

        const {okcrypto} = await getOnlyKey();
        const pqc = require('node-onlykey-lib/crypto').pqc;

        const recipient = pqc.encodeRecipient(s.stored);
        const secret = 'the device holds the only key that opens this';
        const file = okcrypto.deviceAge.encrypt(secret, recipient);
        log(`age file: ${file.length} bytes, encrypted with no device at all`);

        const opened = await okcrypto.deviceAge.decryptWithSlot(file, SLOT, {
          confirm: ({digits, isAnswered}) => pressChallenge(digits, log, isAnswered),
          timeoutMs: 60000,
        });

        const text = typeof opened === 'string'
          ? opened
          : new TextDecoder().decode(opened);
        log(`opened: ${JSON.stringify(text)}`);
        assert.equal(text, secret, 'the device did not open its own file');
      });

    it('and the same file opens from the IDENTITY string alone',
      async ({log, assert, skip}) => {
        /*
         * What a person actually keeps is the identity, not a slot number.
         * decryptWithIdentity decodes it, checks the fingerprint against the
         * key the slot holds NOW, and only then spends a button press.
         */
        const s = await ready(log);
        if (!s.stored) {
          skip('no stored key yet');
        }

        const {okcrypto} = await getOnlyKey();
        const pqc = require('node-onlykey-lib/crypto').pqc;

        const identity = pqc.encodeSlotIdentity(SLOT, s.stored);
        const secret = 'opened from an identity string';
        const file = okcrypto.deviceAge.encrypt(
          secret, pqc.encodeRecipient(s.stored));

        const opened = await okcrypto.deviceAge.decryptWithIdentity(file, identity, {
          confirm: ({digits, isAnswered}) => pressChallenge(digits, log, isAnswered),
          timeoutMs: 60000,
        });

        const text = typeof opened === 'string'
          ? opened
          : new TextDecoder().decode(opened);
        assert.equal(text, secret);
        log('the identity string was enough');
      });

    it('enters config mode, which a slot write needs', async ({log, assert, skip}) => {
      const s = await ready(log);
      if (!s.caps.postQuantum) {
        skip('no post-quantum support');
      }

      /*
       * The gesture that reaches config mode also LOCKS the device, so the PIN
       * goes back in afterwards. Both halves are the firmware's design. The
       * sequence is the library's rather than a copy kept here - a copy is how
       * a DUO's different gesture went unnoticed once.
       */
      await s.device.enterConfigMode({
        /* HANDED to the firmware; key_press IS what payload() bands on. */
        hold: (button, ticks) =>
          OkEmu.pressQueue(String(button), ticks, {allowGesture: true}),
        settle: delay,
        attempts: 3,
      });
      log('the gesture landed and the device locked');

      await s.device.unlock(PIN, {timeoutMs: 20000, enterDigits: pressDigits({log})});
      s.configMode = true;
      log('unlocked again, now in config mode');
      assert.ok(true);
    });

    it('GENERATES an X-Wing key in the device and hands back only the public half',
      async ({log, assert, skip}) => {
        const s = await ready(log);
        if (!s.configMode) {
          skip('config mode was not reached');
        }

        /*
         * ONE request. The firmware replays it itself on the third press
         * (OnlyKey.ino:846-859), so a client that re-sent here would be
         * ignored, and the extra presses would type slot contents at the
         * keyboard of an unlocked device.
         */
        const key = await s.device.generateKey(SLOT, KEY_TYPE.XWING, {
          confirm: ({digits, isAnswered}) => pressChallenge(digits, log, isAnswered),
          timeoutMs: 60000,
        });

        log(`X-Wing public key: ${key.length} bytes`);
        assert.equal(key.length, XWING_BYTES);
        assert.equal(key.subarray(1184).every(b => b === 0), false,
          'the X25519 half is all zeros');
        assert.equal(key.every(b => b === 0), false, 'the whole key is zeros');

        s.generated = key;
      });

    it('a second slot gets a DIFFERENT key', async ({log, assert, skip}) => {
      const s = await ready(log);
      if (!s.generated) {
        skip('nothing was generated');
      }

      /*
       * Cheap, and it catches the two worst outcomes at once: a generator
       * seeded from something constant, and a reply that is coming from a
       * stale buffer rather than from the slot that was asked for.
       */
      const other = await s.device.generateKey(OTHER_SLOT, KEY_TYPE.XWING, {
        confirm: ({digits, isAnswered}) => pressChallenge(digits, log, isAnswered),
        timeoutMs: 60000,
      });

      assert.equal(other.length, XWING_BYTES);
      assert.equal(other.every((b, i) => b === s.generated[i]), false,
        'two slots produced the same key');
      log(`slot ${OTHER_SLOT} differs from slot ${SLOT}`);
    });

    it('ML-KEM-768 generates too, and is 32 bytes shorter',
      async ({log, assert, skip}) => {
        /*
         * X-Wing IS ML-KEM with an X25519 key glued on - `pk_M(1184) ||
         * pk_X(32)` - so the two lengths coming back correctly is what shows
         * the type byte reached the firmware rather than a default being used
         * for both.
         */
        const s = await ready(log);
        if (!s.configMode) {
          skip('config mode was not reached');
        }

        const key = await s.device.generateKey(MLKEM_SLOT, KEY_TYPE.MLKEM768, {
          confirm: ({digits, isAnswered}) => pressChallenge(digits, log, isAnswered),
          timeoutMs: 60000,
        });

        log(`ML-KEM-768 public key: ${key.length} bytes`);
        assert.equal(key.length, 1184, 'MLKEM_PK_SIZE, okcore.h:233');
        assert.equal(key.every(b => b === 0), false, 'the whole key is zeros');
      });

    it('the generated key encodes to a recipient and an identity that agree',
      async ({log, assert, skip}) => {
        /*
         * EXACTLY WHAT THE KEYS SCREEN DOES after a generation, in the same
         * order: encode the public key as a recipient, encode the slot and a
         * fingerprint of that key as an identity. Driving the screen itself
         * would cost an unlock and a config-mode gesture through the UI; this
         * runs the composition against a key the device actually made, which
         * is the part that can be wrong.
         *
         * The fingerprint check is the one that matters. An identity names a
         * slot, and a slot can be generated again - so an identity written
         * against one key must NOT verify against the next one in the same
         * slot, or a person would be told their file is readable when it is
         * not.
         */
        const s = await ready(log);
        if (!s.generated) {
          skip('nothing was generated');
        }

        const pqc = require('node-onlykey-lib/crypto').pqc;
        const recipient = pqc.encodeRecipient(s.generated);
        const identity = pqc.encodeSlotIdentity(SLOT, s.generated);

        log(`recipient: ${recipient.slice(0, 32)}...`);
        log(`identity : ${identity}`);

        assert.ok(recipient.startsWith('age1onlykey1'), `bad recipient: ${recipient.slice(0, 20)}`);
        assert.ok(identity.startsWith('AGE-PLUGIN-ONLYKEY-1'), `bad identity: ${identity}`);

        const decoded = pqc.decodeIdentity(identity);
        assert.equal(decoded.derived, false);
        assert.equal(decoded.slot, SLOT);
        assert.equal(decoded.legacy, false);
        assert.ok(pqc.identityMatchesKey(decoded, s.generated),
          'the identity does not match the key it was made from');

        /* The recipient round-trips to the same 1216 bytes the device sent. */
        const back = pqc.decodeRecipient(recipient);
        assert.equal(back.length, XWING_BYTES);
        assert.ok(back.every((b, i) => b === s.generated[i]), 'recipient lost bytes');
      });

    it('and the device is left in config mode, which the next run clears',
      async ({log, assert, skip}) => {
        /*
         * Said out loud rather than left as a surprise. Config mode ends only
         * at a power cycle, the emulator has no in-process reset, and the
         * runner force-stops the app between runs - which IS the power cycle.
         * This suite therefore runs after every other soft-key suite, because
         * config mode silences CTAPHID and anything deriving after it would
         * fail with an unexplained timeout.
         */
        const s = await ready(log);
        if (!s.configMode) {
          skip('config mode was never entered');
        }
        log('config mode is still on; the next run starts with a fresh boot');
        assert.ok(true);
      });
  });
};
