/**
 * Give a FRESH device a PIN, so the rest of the suite has something to unlock.
 *
 * Every suite after this one assumes a provisioned device: suite 3 says so in
 * its header, and the derive suites unlock with `1234561` before they do
 * anything. Nothing created that device. It was provisioned by hand, once, in
 * a session nobody wrote down, and it survived only because flash.bin outlives
 * the app.
 *
 * That was tolerable while there was one device. There is now one PER FIRMWARE
 * VERSION - `files/okemu/<version>` - because a v2.1 firmware reading a v3.0
 * flash is not a measurement of either. Every version in the matrix therefore
 * starts UNINITIALIZED, and provisioning each of them by hand is the thing that
 * would stop the matrix from ever being run.
 *
 * ## It needs a DEBUG build, and says so rather than timing out
 *
 * The PIN bracket is a CONVERSATION: setPin waits for "Enter PIN", "Storing
 * PIN", "Confirm PIN" and "Both PINs Match", and every one of those is a
 * Serial.println inside `#ifdef DEBUG`
 * (FINDING-provisioning-needs-a-debug-build.md). A release ships with that gate
 * OFF - v3.0.2's onlykey.h has `//#define DEBUG` - so a pinned version has to
 * be staged with OKEMU_DEBUG=1 or it cannot be given a PIN at all.
 *
 * ## Two runs, not one
 *
 * `initialized` is recomputed from flash only in setup(), so the device goes on
 * reporting UNINITIALIZED until it boots again, and an in-process firmware
 * restart is not implemented - the thread only exits through the AIRCR trap.
 * The runner force-stops the app between runs, which is that boot. So a fresh
 * device provisions on the first run and is usable on the second, and this
 * fails the first one deliberately rather than letting thirteen suites time out
 * against a device that is not ready.
 */
'use strict';

const {getOnlyKey} = require('../src/onlykey');
const {pressDigits} = require('./helpers/pressDigits');
const {protocol} = require('node-onlykey-lib');
const okmsg = protocol.okmsg;

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;

/** The PIN every other suite uses. Digits are button numbers, so 1-6. */
const PIN = '1234561';

/*
 * WHAT THIS DELIBERATELY DOES NOT DO: set the touch-free derive preference.
 *
 * It looked free. okcore.cpp:2015 gates that field on
 * `configmode == true || !initcheck`, and !initcheck is true on a device that
 * has never been set up - so setting it here would have avoided the config-mode
 * gesture that later costs the derive suite a whole run
 * (FINDING-enabling-touch-free-derive-mid-run-kills-ctaphid.md).
 *
 * MEASURED, and it does not work. OKSETSLOT never reaches that gate on an
 * uninitialized device: okcore.cpp:398 takes the `initialized == false` branch
 * first, which accepts ONLY field 12 (wipemode) and field 20 (backupkeymode) -
 * "set once settings" - and answers everything else with "Error OnlyKey must
 * be initialized first". Which is what the device said:
 *
 *     status: UNINITIALIZEDv3.0.2-testc
 *     ✗ derivedChallengeMode: Error OnlyKey must be initialized first
 *
 * By the next boot the nonce hash exists, so initcheck is true and the only
 * remaining door is config mode. 9-cryptoSign already opens it on a fresh
 * device - it needs config mode for the signing key anyway - and sets the
 * preference while it is in there. So a new device costs three runs: PIN here,
 * key and preference in cryptoSign, then a green one.
 */
const delay = ms => new Promise(r => setTimeout(r, ms));

module.exports = function provision({describe, it}) {
  describe(provision.name, () => {
    it('has a PIN, or sets one and asks to be run again', async ({log, assert}) => {
      if (!OkEmu.isRunning()) {
        await OkEmu.start();
        await delay(1500);
      }

      const {device} = await getOnlyKey();
      const state = await device.connect();
      log(`status: ${state.status}`);

      if (!/UNINITIALIZED/i.test(state.status)) {
        /*
         * The ordinary case, and it must stay cheap - this runs before every
         * suite on every device, and a provisioned device should cost one
         * status read.
         */
        log('already provisioned; nothing to do');
        assert.ok(
          /INITIALIZED|UNLOCKED|LOCKED/i.test(state.status),
          `unrecognised device state: ${state.status}`,
        );
        return;
      }

      /*
       * A production build cannot be provisioned, and the reason is worth
       * naming here rather than fifteen seconds later in a message about the
       * PIN possibly being wrong.
       */
      const caps = device.capabilities;
      assert.equal(
        caps && caps.debugConsole,
        true,
        'this firmware has no debug console, so the PIN bracket has nothing ' +
          'to answer it - stage the version with OKEMU_DEBUG=1',
      );

      /*
       * A DUO IS PROVISIONED BY A MESSAGE, not by the six-step bracket.
       *
       * The classic device captures digits from its own buttons and the host
       * only brackets that, waiting for six console prompts. A DUO carries its
       * PINs in the message body: one OKPIN with a leading 0xFF meaning SET,
       * and each PIN in its own 16-byte slot. The middle slot is the second
       * profile PIN, which a DUO does not have, so it goes as empty.
       *
       * There are no prompts to count here, so the evidence is different: the
       * device answers, and the next boot reports INITIALIZED. Asserting "six
       * steps" against a DUO would fail on a device that had just been set up
       * correctly.
       */
      if (device.deviceType === 'duo') {
        log(`device is a DUO and UNINITIALIZED; setting the PIN to ${PIN} by message`);
        const problems = device.validateDuoPins({pin: PIN, pinConfirm: PIN});
        assert.ok(problems.ok, `the PIN this suite uses is not valid for a DUO: ${
          problems.primary.concat(problems.selfDestruct).join(' ')}`);

        const reply = await device.duoPin([PIN, '', ''], {set: true});
        log(`device answered: ${JSON.stringify(String(okmsg.text(reply)).slice(0, 60))}`);
      } else {
        log(`device is UNINITIALIZED; setting the PIN to ${PIN}`);
        const steps = [];
        const off = device.on('progress', e => {
          steps.push(e.step);
          log(`  ${e.step}`);
        });
        try {
          await device.setPin(PIN, {enterDigits: pressDigits({log})});
        } finally {
          off();
        }

        /*
         * The six steps are the evidence. "setPin resolved" is not: the bracket
         * is six waits, and one of them silently satisfied by the wrong prompt
         * would leave a device whose PIN is not what we think it is - which
         * presents, one suite later, as an unlock that never happens.
         */
        log(`steps: ${steps.join(', ')}`);
        assert.equal(steps.length, 6, 'the PIN bracket did not run to completion');
      }


      assert.ok(
        false,
        'PROVISIONED. The device reports its old state until it boots again ' +
          '(initialized is recomputed only in setup(), and an in-process ' +
          'firmware restart is not implemented), so run the suite again - the ' +
          'runner force-stops the app between runs, which is that boot. A ' +
          'brand new device needs three runs in all: this one, one in which ' +
          'cryptoSign takes config mode for the signing key and the ' +
          'touch-free derive preference, and then a green one.',
      );
    });
  });
};
