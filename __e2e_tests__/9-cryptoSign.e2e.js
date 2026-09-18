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
const {IFACE} = OkEmuModule;

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

/*
 * An OpenSSH key, loaded beside it while config mode is open anyway.
 *
 * A THROWAWAY ssh-keygen -t ed25519 fixture (the same one the library's
 * keys.ssh.test.js checks against its .pub), so the device's signature can
 * be VERIFIED here against a public key the firmware never saw - the raw
 * key above only proves that something was signed. Slot 103 so it disturbs
 * neither the signing slot nor the PGP convention's 101/102.
 */
const SSH_SLOT = 103;
const SSH_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACCK/qwnyc6jZLTBE8LPJ7MC2tpyjtAsUTJy+HPdlcMjTgAAAJBZLVmQWS1Z
kAAAAAtzc2gtZWQyNTUxOQAAACCK/qwnyc6jZLTBE8LPJ7MC2tpyjtAsUTJy+HPdlcMjTg
AAAEBTBSBVEFDFQtEzzQNibjTjaUbUDYHtpNarNFQJFDw94Ir+rCfJzqNktMETws8nswLa
2nKO0CxRMnL4c92VwyNOAAAAB2ZpeHR1cmUBAgMEBQY=
-----END OPENSSH PRIVATE KEY-----`;
/** ssh-ed25519 public key of the fixture, the 32 bytes after the type string. */
const SSH_PUB_HEX = '8afeac27c9cea364b4c113c2cf27b302dada728ed02c513272f873dd95c3234e';


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
 *
 * This built the frame by hand for as long as OKGETPUBKEY was in the message
 * table and called by nothing. `device.getPublicKey` is that frame, the same
 * empty-slot rule, and the multi-report collection a hand-rolled probe never
 * had - so the probe is now one call, and the method has a caller.
 */
async function probeKey(device, log, slot = SLOT) {
  const started = Date.now();
  try {
    const key = await device.getPublicKey(slot, {bytes: 32, timeoutMs: 4000});
    if (Date.now() - started > 4000) log(`  (slot ${slot} needed the resend)`);
    log(`slot ${slot}: holds a key (${key.length} bytes back)`);
    return true;
  } catch (e) {
    /*
     * BY KIND, not by sentence. The firmware has 113 of them and this used
     * to match two by hand; okmsg.errorKind groups them and the library
     * attaches the kind to what it throws, so "the slot is empty" is a
     * comparison rather than a regex that goes stale when a word changes.
     */
    if (e.kind === 'emptySlot') {
      log(`slot ${slot}: empty (${e.deviceText})`);
    } else {
      log(`probe failed: ${e.message}`);
    }
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
    /* A tap. The challenge digits go in one at a time here on purpose -
       each answers a separate prompt - but each is handed over, not sensed. */
    await OkEmu.pressQueue(String(d));
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
  let state = await device.connect();
  log(`device: ${String(state.status).trim()}`);

  /*
   * Unlock here rather than assert it. In the full run an earlier suite has
   * unlocked the soft key; run with --only on a fresh process the key is
   * locked, and the first test's assertion was the least of it: the config
   * mode gesture in the second test is a button-6 hold, which on a LOCKED
   * key is the digit 6 in the PIN buffer, so the 1234561 that followed was
   * eight digits and "did not unlock within 20000ms" (measured 2026-09-11,
   * --only cryptoSign, PIN confirmed fine on the This Key keypad).
   */
  if (!/UNLOCKED/i.test(String(state.status))) {
    log('locked at suite start: entering the PIN first');
    await device.unlock(PIN, {timeoutMs: 20000, enterDigits: pressDigits({log})});
    state = await device.connect();
    log(`device after unlock: ${String(state.status).trim()}`);
  }

  shared = {device, okcrypto, transport, status: String(state.status), present: false, sshPresent: false};
  shared.present = await probeKey(device, log);
  shared.sshPresent = await probeKey(device, log, SSH_SLOT);
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
         *
         * The sequence is the library's - see enableTouchFreeDerive, and
         * device.enterConfigMode() behind it. This suite carried its own copy
         * of the gesture, the wait and the lock check, which is how the DUO's
         * different gesture went unnoticed until a DUO was emulated.
         */
        await device.enterConfigMode({
          /*
           * HANDED to the firmware, not sensed. enterConfigMode holds button 6
           * past 72 - ~76 sense rounds at TIME_POLL=50ms, near four seconds,
           * and it retries up to three times. key_press IS the duration
           * payload() bands on, so the gesture is the same one.
           */
          hold: (button, ticks) =>
            OkEmu.pressQueue(String(button), ticks, {allowGesture: true}),
          settle: delay,
          attempts: 3,
        });
        log('the gesture landed and the device locked');

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

        /*
         * The SSH key, through the plugin's parser rather than raw bytes:
         * device.loadSshKey is what the Keys tab's SSH mode calls, so this is
         * the app's path end to end, with the same acknowledgement wait.
         */
        const sshAck = vendorSays(/Successfully set ECC Key/);
        try {
          /*
           * Named as it is written. The fixture's ssh-keygen comment is
           * "fixture", and loadSshKey uses the comment when no label is
           * given - so this also proves the name a key carries reaches the
           * device without the caller typing one.
           */
          const applied = await device.loadSshKey(SSH_KEY, {slot: SSH_SLOT, signature: true});
          log(`loadSshKey returned: ${JSON.stringify(applied)}`);
          const said = await sshAck.done;
          log(`device answered: ${JSON.stringify(said.slice(-40))}`);
        } finally {
          sshAck.off();
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

    it('touch sensitivity is field 28, and the range in the table is the firmware own', async ({log, assert, skip}) => {
      /*
       * Runs inside the config-mode window the provisioning test opened -
       * field 28 is gated on `configmode == true || !initcheck`
       * (okcore.cpp:2106), the same gate as the derive preference above it,
       * and config mode ends only at a restart. When the slot already held a
       * key that test did not run, so neither can this one.
       */
      const {device, transport} = await ready(log);
      if (!shared.provisioned) {
        skip('config mode was not entered this run - the signing slot was already provisioned');
      }

      /*
       * TOUCH SENSITIVITY, while the config-mode door is already open.
       *
       * Field 28, which the library's table said was unassigned until the
       * firmware was read (okcore.cpp:2106). Two things are worth proving
       * on a device and cannot be proven anywhere else: that the field id
       * is the one the firmware writes, and that the RANGE in the table is
       * the firmware's own. The second needs a frame the library would
       * refuse to build, so it is built here by hand - the only way to
       * hear "Error touchsense value out of range" is to send the value
       * that provokes it.
       */
      const touchOk = await device.setPreference('touchSense', 50);
      log(`touchSense 50: ${JSON.stringify(touchOk.response)}`);
      assert.ok(
        /Successfully set Touch Sensitivity/i.test(touchOk.response),
        'field 28 did not answer the way the firmware touch-sensitivity case does',
      );

      /* The library refuses 1 before the wire, from the same table. */
      let refusedByLib = null;
      try {
        await device.setPreference('touchSense', 1);
      } catch (e) {
        refusedByLib = String(e.message);
      }
      log(`library on 1: ${JSON.stringify(refusedByLib)}`);
      assert.ok(
        refusedByLib && /must be an integer 2\.\.100/.test(refusedByLib),
        'the library built a frame for a value the firmware refuses',
      );

      /* And the firmware refuses it too, which is what makes the floor right. */
      const refusal = await transport.request({
        iface: IFACE.VENDOR,
        data: protocol.okmsg.build({
          msg: protocol.msg.MSG.OKSETSLOT,
          slot: 0,
          field: 28,
          payload: [1],
        }),
        timeoutMs: 6000,
        match: r => /touchsense|Success/i.test(protocol.okmsg.text(r)),
      });
      const said = protocol.okmsg.text(refusal).trim();
      log(`touchSense 1 on the wire: ${JSON.stringify(said)}`);
      assert.ok(
        /out of range/i.test(said),
        'the firmware accepted 1, so the floor of 2 in the table is wrong',
      );

      /* Leave it at a middling value rather than the one that provoked an error. */
      await device.setPreference('touchSense', 20);
    });

    it('the public key of the slot it just wrote matches the private key it sent', async ({log, assert, skip}) => {
      /*
       * OKGETPUBKEY, which sat in the message table with no caller. Two
       * things fall out of it that nothing else in this suite could check:
       *
       * 1. The device kept the key it was given. Every other test here
       *    proves a signature verifies, which is the same claim from the
       *    other end; this one reads the public half straight back and
       *    compares it with the public key of the raw scalar the test sent.
       * 2. Slot 116 is a real slot. The app offered 101-110 until the
       *    firmware was read (okcore.cpp:458-469 refuses 117-132 BY NAME,
       *    so 101-116 are the host slots); an out-of-range slot answers
       *    a slot past the end answers NOTHING AT ALL, and the two are told
       *    apart here.
       */
      const {device} = await ready(log);
      if (!shared.present) {
        skip('no key in the slot');
      }

      const {ed25519} = require('@noble/curves/ed25519.js');
      const {toHex} = require('node-onlykey-lib').bytes;

      const pub = await device.getPublicKey(SLOT, {bytes: 32});
      log(`slot ${SLOT} public key: ${toHex(pub)}`);
      assert.equal(
        toHex(pub), toHex(ed25519.getPublicKey(KEY)),
        'the device public key is not the one belonging to the scalar this suite wrote',
      );

      /*
       * TWO EMPTY SLOTS IN A ROW, which is the shape that goes unanswered.
       *
       * A read straight after a read is SOMETIMES never answered, and only
       * when the first one hit an empty slot - which replies with
       * hidprint's error sentence rather than with key bytes. Three runs in
       * four on the bench, 2026-09-11; a 60 ms settle alone did not prevent
       * it, and getPublicKey now resends once when the device says nothing.
       * It never happened on slots that hold keys, which is why it stayed
       * hidden. See the second half of
       * FINDING-slot-write-after-a-label-read-is-lost.md, including what
       * that finding does NOT claim about the cause.
       */
      for (const empty of [105, 106]) {
        let said = null;
        try {
          await device.getPublicKey(empty, {bytes: 32, timeoutMs: 4000});
        } catch (e) {
          said = String(e.message);
        }
        log(`slot ${empty}: ${JSON.stringify(said)}`);
        assert.ok(
          said && /no ECC Private Key/i.test(said),
          `slot ${empty} did not answer; a read straight after another one was lost`,
        );
      }

      /* 116 is empty but IN RANGE; 117 is the first reserved slot. */
      let atTop = null;
      try {
        await device.getPublicKey(116, {bytes: 32, timeoutMs: 4000});
      } catch (e) {
        atTop = String(e.message);
      }
      log(`slot 116: ${JSON.stringify(atTop)}`);
      assert.ok(
        atTop && /no ECC Private Key/i.test(atTop),
        'slot 116 did not answer as an empty user slot, so the picker is wrong to offer it',
      );

      /*
       * A SLOT PAST THE END IS SILENCE, not an error, and that is worth
       * pinning because it is easy to assume otherwise.
       * okcrypto_getpubkey (okcrypto.cpp:274-292) is a chain of four `if`s
       * with NO final else: RSA below 5, ECC below 117, then the two
       * reserved derivation slots. A slot that matches none of them falls
       * off the end and the function returns having printed nothing.
       * "Error invalid ECC slot" (okcore.cpp:5229) exists but is
       * unreachable from here - it comes from okcore_flashget_ECC, which
       * this path only calls when the slot is already below 117.
       *
       * So a host asking about a slot it should not ask about waits for a
       * timeout. getPublicKey has one, and this is the test that says why.
       */
      let reserved = null;
      try {
        await device.getPublicKey(133, {bytes: 32, timeoutMs: 4000});
      } catch (e) {
        reserved = String(e.message);
      }
      log(`slot 133: ${JSON.stringify(reserved)}`);
      assert.ok(
        reserved && /did not answer OKGETPUBKEY/i.test(reserved),
        'a slot past the end answered something; okcrypto_getpubkey was expected to drop it',
      );
    });

    it('a key slot can be named, read back, and the name goes with the key', async ({log, assert, skip}) => {
      /*
       * The KEY label list - OKGETLABELS with slot byte 'k' - which nothing
       * in this library could read and no screen could show, so a key could
       * be written and the app would look exactly as it had.
       *
       * It also pins the half of wipeKey that was missing. The firmware
       * keeps a key and its label in different places: wipe_private()
       * clears the key and never touches the label (okcore.cpp:5191-5208),
       * so a wiped slot went on naming a key that was gone. The label write
       * needs config mode like any other OKSETSLOT, so this runs in the
       * window the provisioning test opened.
       *
       * Slot 104 rather than the signing slot: naming and wiping the slot
       * the rest of the suite depends on would make the failure land
       * somewhere else.
       */
      const {device} = await ready(log);
      if (!shared.provisioned) {
        skip('config mode was not entered this run - the signing slot was already provisioned');
      }

      const LABELLED = 104;
      const NAME = 'e2e-label';

      /* The label lives at its own index: ECC 104 -> 104 - 72 = 32. */
      await device.setSlot(32, {label: NAME});

      const after = await device.readKeyLabels();
      log(`named slots: ${JSON.stringify(
        after.keys.filter(k => k.label).map(k => `${k.slot}:${k.label}`))}`);
      assert.equal(after.keys.length, 20, 'the key label list is twenty rows');
      const row = after.keys.find(k => k.slot === LABELLED);
      assert.ok(row, `slot ${LABELLED} is not in the key label list`);
      assert.equal(row.label, NAME, 'the label read back is not the one written');
      assert.equal(row.kind, 'ecc');

      /*
       * The SSH key named itself. loadSshKey passes the key's own
       * ssh-keygen comment when the caller gives no label, so slot 103
       * should be carrying "fixture" without anything having typed it.
       */
      const sshRow = after.keys.find(k => k.slot === SSH_SLOT);
      assert.ok(sshRow, `slot ${SSH_SLOT} is missing from the key label list`);
      assert.equal(
        sshRow.label, 'fixture',
        'the SSH key did not name its own slot from its comment',
      );

      /* RSA 1 is in the same list, at index 25, and is a different kind. */
      const rsa = after.keys.find(k => k.slot === 1);
      assert.ok(rsa, 'RSA slot 1 is missing from the key label list');
      assert.equal(rsa.kind, 'rsa');

      /* A wipe clears the name as well, which is what Python does and this did not. */
      const wiped = await device.wipeKey(LABELLED);
      log(`wipe said: ${JSON.stringify(wiped.response)}, label: ${JSON.stringify(wiped.label)}`);
      assert.ok(
        /^Success/i.test(wiped.response),
        'the wipe was not acknowledged, which is what it used to not wait for',
      );

      const again = await device.readKeyLabels();
      const cleared = again.keys.find(k => k.slot === LABELLED);
      assert.equal(cleared.label, '', 'the label outlived the key it named');
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
        const signature = await okcrypto.sign(SLOT, payload, {
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

    it('an OpenSSH key loaded beside it signs, and the signature verifies', async ({log, assert}) => {
      /*
       * The one signature in this suite checked against a PUBLIC KEY. The
       * raw slot's test can only say "64 bytes, not zeros"; this fixture's
       * public half is known, so Ed25519 verification of what the device
       * returned proves the parser landed on the right 32 bytes AND that
       * the firmware signed the payload as given (okcrypto.cpp:697 signs
       * large_buffer, not a digest of it).
       */
      const {okcrypto} = await ready(log);
      if (!shared.sshPresent) {
        /*
         * The SSH key is loaded in the provisioning test, which runs only when
         * slot 101 is EMPTY. A soft key provisioned before this test existed
         * has 101 and not 103, and provisioning will never run again for it -
         * measured on the Pixel's soft key, 2026-09-11, as the one red test in
         * an otherwise green full run. That is a precondition this test cannot
         * meet on its own (loading needs config mode, which would leave the
         * key in it for every suite after), so it says so and skips; a
         * factory reset of the soft key makes it run.
         */
        if (shared.provisioned) {
          log('deferred to the next invocation - the device is in config mode');
        } else {
          log(`skipped: slot ${SSH_SLOT} is empty and slot 101 is not - provisioning ran before this test existed; factory-reset the soft key to see it`);
        }
        assert.ok(true);
        return;
      }
      const {ed25519} = require('@noble/curves/ed25519.js');
      const {fromHex} = require('node-onlykey-lib').bytes;

      const payload = new Uint8Array(32).map((_, i) => (i * 5 + 2) & 0xff);
      const expected = protocol.challenge.challengeDigits(payload);
      log(`challenge should be ${expected.join('-')}`);
      await delay(1500);

      const signature = await okcrypto.sign(SSH_SLOT, payload, {
        timeoutMs: 25000,
        confirm: ({digits, isAnswered}) => pressChallenge(digits, log, isAnswered),
      });
      log(`signature: ${signature.length} bytes`);
      assert.equal(signature.length, 64, 'an Ed25519 signature is 64 bytes');
      assert.ok(
        ed25519.verify(Uint8Array.from(signature), payload, fromHex(SSH_PUB_HEX)),
        'the signature does not verify against the public key ssh-keygen wrote for this fixture',
      );
      log('verified against the fixture public key');
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
      const again = await okcrypto.sign(SLOT, shared.payload, {
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
      const signature = await okcrypto.sign(SLOT, payload, {
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
    it('a key loaded as signature-only refuses to decrypt', async ({log, assert}) => {
      /*
       * The role bits are not decoration in either direction. KEY_TYPE above
       * carries SIGNATURE (0x40) and not DECRYPTION (0x20), and okcrypto.cpp
       * gates OKDECRYPT on feature bit 5 with "Error key not set as
       * decryption key" before it looks at the payload or asks for a press
       * (okcrypto.cpp:380-410, the ECC branch). So this needs no press and
       * no touch-free preference: the refusal is the answer, in text, and
       * the plugin rejects with it. The Keys tab's role toggles produce this
       * same byte, which is why it is pinned here and not in a screen test.
       */
      const {okcrypto} = await ready(log);
      if (!shared.present) {
        log('skipped: no key in the slot');
        assert.ok(true);
        return;
      }

      /*
       * BEFORE the no-press test, not after it. That test leaves a challenge
       * nobody answered, and CRYPTO_AUTH stays set until the firmware's 20 s
       * user timer fades it off (okcore.cpp:175, fadeoffafter20sec); until
       * then OKDECRYPT takes okcore.cpp:552's else-branch and says "Error
       * device locked" - a refusal, but not the one under test, and the LED
       * shows nothing a wait could key on. Measured on this test's first two
       * runs. Here the previous signature completed, so nothing is pending.
       */
      await delay(1500);
      let refused = null;
      let refusedKind = null;
      try {
        const point = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
        await okcrypto.decrypt(SLOT, point, {timeoutMs: 6000, confirm: null});
      } catch (error) {
        refused = String(error.message);
        refusedKind = error.kind ?? null;
      }
      log(`refusal: ${refused} (kind: ${refusedKind})`);
      assert.ok(refused, 'the device decrypted with a slot that has no decryption role');
      assert.ok(
        /not set as decryption key/i.test(refused),
        'refused, but not for the role: the message should name the missing decryption bit',
      );
      /*
       * And the library classified it. A caller that wants to say "this key
       * cannot decrypt" should not have to match the sentence itself.
       */
      assert.equal(refusedKind, 'wrongRole', 'the refusal was not classified as a role problem');
    });

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
        await okcrypto.sign(SLOT, Uint8Array.from([0xaa, 0xbb, 0xcc]), {
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
