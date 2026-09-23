/**
 * Give the SOFT KEY a backup passphrase, so `backupCapture` has something to
 * capture.
 *
 * ## Why this is its own suite, and why it is armed
 *
 * `8b-backup` skips its digest test with "this key has no backup key set, so
 * the firmware types a URL instead of a backup". That skip is correct - a key
 * with no backup key is behaving properly - but it means the one thing the
 * suite exists to verify, the chained SHA-256 over the base64 body, has never
 * run. Setting a passphrase is what turns that skip into a measurement.
 *
 * It is ARMED (`--only backupPassphrase`) rather than part of the sweep for a
 * hard reason: OKSETPRIV is accepted only in CONFIG MODE, or on a device that
 * has never been initialised (okcore.cpp:452). Config mode silences CTAPHID
 * for the rest of the firmware's life, and the only way out is a restart - so
 * a test that quietly entered it mid-sweep would break every derive suite
 * behind it, exactly as `enableTouchFreeDerive` once did
 * (FINDING-enabling-touch-free-derive-mid-run-kills-ctaphid.md). Running it
 * alone costs one config-mode cycle and leaves the key with a passphrase that
 * outlives the app, because flash.bin does.
 *
 * ## THE SOFT KEY, and that is not a matter of which key happens to be plugged in
 *
 * `getOnlyKey('embedded')` is the emulator; the hard-key suites pass `'usb'`
 * and reach UsbPipe instead. This file names the backend EXPLICITLY rather
 * than taking the default, so the choice is visible at the call site: writing
 * a backup key to somebody's real OnlyKey is not a thing a test should be able
 * to do by inheriting an argument.
 *
 * ## The passphrase never reaches the device
 *
 * Only SHA-256 of its latin1 bytes does, written to slot 131 as an Ed25519
 * backup/decryption key. So a passphrase the host validates differently from
 * the desktop app produces a backup that cannot be restored and says nothing
 * at the time - which is why validateBackupPassphrase() is not advisory and
 * why the minimum (25 characters) is enforced host-side before any write.
 */
'use strict';
const {getOnlyKey} = require('../src/onlykey');
const {inConfigMode} = require('./helpers/touchFreeDerive');
const {pressDigits} = require('./helpers/pressDigits');
/*
 * SHARED, not repeated. Three callers set this passphrase - provisioning,
 * the backup suite's no-key path, and this one - and two of them
 * disagreeing would write two different backup KEYS, because only SHA-256
 * of the string ever reaches the device, and the mismatch would show up as
 * a backup that will not restore rather than as an error.
 */
const {writeBackupPassphrase, acknowledged} =
  require('./helpers/backupPassphrase');
const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;

const PIN = '1234561';

function isNamed() {
  const only = require('./only.js');
  return Array.isArray(only) && only.includes('backupPassphrase');
}

module.exports = function backupPassphrase({describe, it}) {
  describe(backupPassphrase.name, () => {
    it('runs only when named, and sets the soft key backup passphrase', async ({log, assert, skip}) => {
      if (!isNamed()) {
        skip(
          'enters CONFIG MODE, which silences CTAPHID until a restart and ' +
          'would break every derive suite behind it. Run it alone with ' +
          '--only backupPassphrase.',
        );
      }

      if (!OkEmu.isRunning()) await OkEmu.start();

      /* Named, not defaulted - see the header. */
      const {device} = await getOnlyKey('embedded');
      const state = await device.connect();
      log(`status: ${state.status}`);
      assert.ok(
        !/UNINITIALIZED/i.test(state.status),
        'this key has no PIN yet; provision it first (--only provision)',
      );

      /*
       * UNLOCK FIRST, and the reason is subtler than "config mode needs an
       * unlocked device".
       *
       * device.enterConfigMode() proves the gesture landed by watching the
       * device become LOCKED - entering config mode locks it
       * (OnlyKey.ino:914-926). That is sound evidence only if the device was
       * UNLOCKED to begin with. Run inside the sweep it always is, because
       * earlier suites unlocked it; run ALONE, as this suite must be, the key
       * is locked from the start and "it is locked now" proves nothing at all.
       *
       * Measured on the first attempt here: the gesture was reported as landed
       * on a key that was already locked, the PIN went in, and twenty seconds
       * of readLabels polling never found a readable device - because the key
       * was never in config mode, just locked, and the PIN entry that followed
       * was an ordinary unlock the helper was not waiting for.
       *
       * So: unlock normally first. Then the lock that enterConfigMode watches
       * for is a state CHANGE it caused, which is what it is reading it as.
       */
      if (!/UNLOCKED/i.test(state.status)) {
        const unlocked = await device.unlock(PIN, {
          timeoutMs: 20000, enterDigits: pressDigits({log}),
        });
        log(`unlocked: ${unlocked}`);
        assert.ok(/UNLOCKED/i.test(unlocked), `unexpected unlock status: ${unlocked}`);
      } else {
        log('already unlocked');
      }

      /*
       * restart:false - there is no in-place firmware restart to ask for.
       * OkEmu.restart() rejects unconditionally (1-softKey pins that), and the
       * real power cycle is the runner force-stopping the app when this run
       * ends. That is safe precisely because this suite is armed and runs
       * alone: nothing is behind it to be broken by the silent CTAPHID, and
       * flash.bin carries the passphrase across the restart exactly as it
       * carries it across a power cycle on hardware.
       */
      const said = await inConfigMode(
        device, PIN, log,
        () => writeBackupPassphrase(device, log),
        {restart: false});

      /*
       * PROVEN BY THE ACKNOWLEDGEMENT, because there is no readback.
       *
       * Nothing in the protocol reports whether a backup key is set. The only
       * other evidence is behavioural and expensive: run a capture and see
       * whether the device types a backup or the 108-character "No Backup
       * Key" URL. setBackupPassphrase() awaits ecc_priv_flash's "Successfully
       * set Backup Passphrase" for exactly this reason - OKSETPRIV outside
       * config mode is dropped in silence, so a write that is not awaited
       * reports success for a passphrase the device never took.
       */
      assert.ok(acknowledged(said),
        `the device did not acknowledge the backup passphrase: ${said}`);

      log('backupCapture can now measure a real backup - run it alone to time one');

      /* Left ON deliberately - the next test is about what that state does. */
      assert.ok(device.inConfigMode,
        'config mode should still be on: there is no message that ends it and '
        + 'this suite did not restart');
    });

    it('refuses a derive BY NAME while in config mode, instead of timing out', async ({log, assert, skip}) => {
      /*
       * THE POINT OF TRACKING THE STATE AT ALL.
       *
       * Config mode silences CTAPHID while the vendor interface goes on
       * answering, so a derive attempted here waits out its full timeout
       * against a device that is working exactly as designed. That is this
       * project's most expensive failure shape: six tests failing in a row
       * with "no CTAPHID reply", none of them naming a cause, all downstream
       * of one gesture forty seconds earlier
       * (FINDING-enabling-touch-free-derive-mid-run-kills-ctaphid.md).
       *
       * okcrypto checks session.configMode BEFORE the request and throws
       * (plugins/okcrypto/index.js:517) - turning six anonymous timeouts into
       * one sentence naming the cause and the cure. That refusal has never
       * been exercised against a device, only unit-tested, which is why it
       * gets a test here rather than a comment somewhere.
       *
       * It runs second on purpose: the test above leaves config mode ON, and
       * nothing can end it but a restart.
       */
      if (!isNamed()) skip('runs with the setter above - see the first test');

      const {okcrypto, device} = await getOnlyKey('embedded');
      assert.ok(device.inConfigMode, 'the setter above did not leave config mode on');

      const started = Date.now();
      let threw = null;
      try {
        await okcrypto.deviceAge.identity('config.mode.probe');
      } catch (e) {
        threw = e;
      }
      const took = Date.now() - started;

      assert.ok(threw, 'a derive in config mode RESOLVED - CTAPHID is supposed '
        + 'to be silent here, so either the refusal is gone or config mode is');
      log(`refused in ${took}ms: ${threw.message.slice(0, 80)}...`);

      assert.ok(/CONFIG MODE/i.test(threw.message),
        `the derive failed but not by name, so a caller cannot tell this from `
        + `a dead device: ${threw.message}`);
      assert.ok(/ends only at a restart/i.test(threw.message),
        'the refusal does not say how to get out of it, which is the half a '
        + 'reader actually needs');

      /*
       * FAST is the whole point. A timeout would also "fail", and would look
       * identical in a summary - the difference is that this one costs a
       * second instead of thirty and says why. Generous bound: the check is
       * before any I/O, so it should be immediate, but a slow phone under a
       * cold bundle is not the thing under test.
       */
      assert.ok(took < 5000,
        `the refusal took ${took}ms, which is long enough that it may have `
        + 'gone to the wire - the check is supposed to happen before the '
        + 'request, not after the silence');
    });
  });
};
