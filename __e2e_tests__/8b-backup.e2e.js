/**
 * Take a backup, off the device's own gesture, and verify the digest chain.
 *
 * THE ONLY GESTURE WITH AN UPPER BOUND THAT MOVED. The 2.1 line leaves the
 * backup hold open-ended on classic hardware - `duration >= 72 && (duration <
 * 126 || HW_ID!=OK_GO)` (OnlyKey.ino:830), where the bound applies to OK_GO
 * only. The 3.0 line closed it at 180 (OnlyKey.ino:873), because that is where
 * the same button became a DUO's config-mode gesture. So a hold of 200 takes a
 * backup on one key and types a slot on the other, and the number BackupScreen
 * used to carry itself was right by luck rather than by construction.
 *
 * capabilities().gestures.backup is now the source, and this is where the
 * firmware gets a vote on it. Nothing else in the suite presses past 72 on
 * button 1, so without this the band is a reading of the source and no more.
 *
 * ## Why it is not a keystroke test
 *
 * There is no message that asks for a backup - the firmware answers the gesture
 * by TYPING the whole file, exactly as it types a slot. What makes this
 * different is the END MARKER: captureBackup stops on it rather than on
 * quiescence, so a backup still arriving is never truncated into a file that
 * verifies as damaged. The digest is a chain, each line hashed with the running
 * digest, so a verified capture is evidence the decode was correct across
 * several kilobytes rather than across one password.
 *
 * ## THE REFUSAL IS ALSO TYPED, AND IT BLOCKS
 *
 * A key with no backup key set answers the gesture by typing a 108-character
 * URL at TYPESPEED, five to nine seconds of `delay()` on the firmware's only
 * thread, with `taskKey` removed. The device answers nothing on vendor for that
 * whole window. See
 * FINDING-the-backup-refusal-is-typed-and-blocks-the-device.md - it was found
 * here, as the NEXT suite failing twice for a reason that was not its own.
 *
 * So this suite drains the typed refusal before it returns, and skips rather
 * than fails: a device that has no backup key is behaving correctly, and the
 * digest chain simply was not verified.
 *
 * Runs AFTER 8-keystrokes and before the config-mode suites: the device must be
 * unlocked, and it must not be inside the pending-operation window that follows
 * a FIDO2 ceremony, in which every press is discarded.
 */
'use strict';

const {getOnlyKey} = require('../src/onlykey');
const {pressDigits} = require('./helpers/pressDigits');
const {inConfigMode} = require('./helpers/touchFreeDerive');
const {writeBackupPassphrase, acknowledged} = require('./helpers/backupPassphrase');
/*
 * Through the PUBLIC surface. A deep `node-onlykey-lib/src/device/parsers`
 * resolves under Metro, which ignores the exports map, and is refused by node -
 * and the exports map is deliberate: it is one of three things keeping a
 * consumer to the surface it can use. The library is headed into GUIs that will
 * honour it.
 */
const {device: okdevice} = require('node-onlykey-lib');
const parsers = okdevice.parsers;

/** The same PIN every suite provisions and uses. */
const PIN = '1234561';

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;
const {IFACE} = OkEmuModule;

const delay = ms => new Promise(r => setTimeout(r, ms));

/**
 * Wait for the device to stop typing.
 *
 * Not a fixed sleep: how long the refusal takes is TYPESPEED times 108, and
 * TYPESPEED is a preference. Watching the keyboard interface go quiet measures
 * it instead of guessing, and costs nothing when there was no refusal.
 */
/*
 * capMs 60 s, not 20 s. The cap is a ceiling on how long we will wait for the
 * key to go quiet, and 20 s was shorter than the typing it was meant to
 * outlast: a measured backup types for ~85 s, so the drain gave up while the
 * key was still delivering characters and the next suite opened into a device
 * mid-sentence. That is the cascade
 * FINDING-the-backup-refusal-is-typed-and-blocks-the-device.md describes for
 * the refusal, and it applies to a real backup with far more to say.
 *
 * It costs nothing when there is nothing to drain: the quiet detector returns
 * as soon as the keyboard has been silent for quietMs, and the cap is only
 * reached when the key really is still typing.
 */
async function drainKeyboard(log, quietMs = 1500, capMs = 60000) {
  let seen = 0;
  let lastAt = Date.now();
  const off = OkEmu.on('stream', e => {
    if (e.iface !== IFACE.KEYBOARD || e.dir !== 0) return;
    seen += 1;
    lastAt = Date.now();
  });

  try {
    const deadline = Date.now() + capMs;
    for (;;) {
      await delay(250);
      if (Date.now() - lastAt >= quietMs) break;
      if (Date.now() >= deadline) break;
    }
  } finally {
    off();
  }

  if (seen) log(`drained ${seen} keyboard reports the device was still typing`);
  return seen;
}

let shared = null;

/**
 * Was this suite ASKED for by name?
 *
 * The runner writes only.js, so a plain sweep leaves it empty and anything
 * gated on this skips. It is how a test that writes to the key opts out of
 * running as a side effect of running everything.
 */
function isNamed() {
  const only = require('./only.js');
  return Array.isArray(only) && only.includes('backupCapture');
}

module.exports = function backupCapture({describe, it}) {
  describe(backupCapture.name, () => {
    it('the backup band is read from the device, not chosen here', async ({log, assert}) => {
      if (!OkEmu.isRunning()) await OkEmu.start();

      const {device} = await getOnlyKey();
      const state = await device.connect();
      log(`device: ${String(state.status).trim()}`);
      assert.ok(/UNLOCKED/i.test(String(state.status)),
        'the device is locked; a backup gesture would only unlock it');

      const {backup} = device.capabilities.gestures;
      log(`backup gesture: button ${backup.button}, ${backup.lo}..`
        + `${backup.hi === null ? 'open' : backup.hi - 1}, holding ${backup.ticks}`);

      assert.equal(backup.button, 1, 'the backup gesture is button 1 on every model');
      assert.ok(backup.ticks >= backup.lo, 'the recommended hold is below the floor');
      assert.ok(backup.hi === null || backup.ticks < backup.hi,
        'the recommended hold is past the ceiling, where it would type a slot');

      shared = {device, backup};
    });

    it('the key types a backup, and the digest chain verifies', async ({log, assert, skip}) => {
      assert.ok(shared, 'the band test did not run');
      const {device, backup} = shared;

      /*
       * A SLOW CAPTURE MUST NOT LOOK LIKE A HANG, because it was taking the
       * rest of the suite down with it.
       *
       * tools/e2e.js kills a run after 90s with no new line from the phone,
       * and that budget is documented as "the slowest single step measured is
       * a backup capture ON A PRODUCTION BUILD, well under a minute". A debug
       * build is not that: it prints a byteprint for everything it does, and
       * the same capture runs past 90s. With `onProgress: null` the suite said
       * nothing for the whole capture, so the watchdog fired, the run died at
       * backupCapture, and cryptoSign, derive, thirdParty, compositePgp,
       * identity, deriveParity, biometrics, passkeys and pqcSlots never ran at
       * all. Nine suites were being reported as neither passed nor failed.
       *
       * Throttled to one line every 10s rather than raising OKRN_E2E_STALL_MS,
       * for two reasons. Raising the budget weakens hang detection for every
       * other step to accommodate one slow one. And a line carrying the
       * character count is strictly better than silence: it says the keyboard
       * is still delivering, which is exactly the difference between slow and
       * wedged that the watchdog exists to tell. A capture that really stops
       * still goes quiet and is still caught.
       *
       * Not per-event: onProgress fires on EVERY keyboard report, and a backup
       * is thousands of characters. That flood is presumably why this was null
       * to begin with - the choice was between too much and nothing, and the
       * throttle is the third option.
       */
      /*
       * ON A TIMER, NOT ON THE EVENT - because ZERO characters is a real
       * outcome and the event-driven version could not report it.
       *
       * onProgress fires on keyboard reports. If the gesture never lands
       * nothing is typed, so it never fires, so the suite says nothing, so the
       * runner's 90 s watchdog kills the RUN - before this test's own 120 s
       * budget expires and before it can say what happened. Measured
       * 2026-09-23 running `--only deviceFlow,backupCapture`: the band test
       * passed, then ninety seconds of silence and `stuck after: the backup
       * band is read from the device`. The capture was never going to produce
       * a character, and the failure named a watchdog instead of a gesture.
       *
       * A timer feeds the watchdog either way and makes the distinction the
       * diagnostic actually turns on:
       *
       *   rising    the gesture fired and the key is typing
       *   stuck at ~110 then stopping   no backup key - the refusal URL
       *   ZERO      THE GESTURE NEVER FIRED
       */
      let typed = 0;
      const startedAt = Date.now();
      const reportProgress = ({characters}) => { typed = characters; };
      const heartbeat = setInterval(() => {
        const secs = Math.round((Date.now() - startedAt) / 1000);
        log(typed === 0
          ? `${secs}s: NOTHING typed yet - if this stays 0 the gesture never fired`
          : `still typing: ${typed} characters so far (${secs}s)`);
      }, 10000);

      /*
       * WAIT OUT THE LED FADE FIRST, or the gesture is discarded in silence.
       *
       * payload() bands the backup on `duration >= 72 && button_selected == '1'
       * && !isfade`. That last clause is the same one enableTouchFreeDerive
       * waits 22 s for, and the fade is started by the unlock this suite
       * depends on. Inside the full sweep a dozen suites run in between and it
       * has long ended; run as `--only deviceFlow,backupCapture` it has not,
       * and the gesture is dropped with nothing said.
       *
       * That is what made this test order-dependent: it typed normally in the
       * full run and produced ZERO characters standalone. A test that silently
       * does nothing depending on what ran before it is not measuring what it
       * claims to measure, so the wait is unconditional - 22 s is cheap next to
       * a capture that runs into the minutes, and it removes the dependency
       * rather than documenting it.
       */
      log('waiting for the LED fade to end, or the backup gesture is discarded');
      await delay(22000);

      let result;
      try {
        result = await device.captureBackup({
          /*
           * HANDED to the firmware, not sensed. A 100-tick gesture emulated as a
           * finger is ~104 sense rounds at TIME_POLL=50ms - about five seconds
           * before the backup even starts. key_press IS the duration payload()
           * bands on, so the band is identical and the wait is not.
           */
          trigger: () =>
            OkEmu.pressQueue(String(backup.button), backup.ticks, {allowGesture: true}),
          /*
           * MEASURED, at last. 2026-09-23, soft key, debug build:
           *
           *   1014 characters, ~85 s of typing, ~12 chars/s
           *   (predicted 12.5 - every character costs two real delays of
           *   (TYPESPEED^2/3)*8 ms, and the emulator's delay() is wall clock)
           *
           * and the digest chain verified, which is the first time this test
           * has ever actually run. It could not before: the firmware refuses
           * without a backup passphrase and nothing in the e2e set one, so it
           * skipped and this number never applied. `8c-backupPassphrase` sets
           * one on the SOFT key now.
           *
           * 240 s rather than the 120 s that just barely fit, because 85 s of
           * measurement is not 85 s of budget. This key's backup grows with
           * what is stored on it - the FIDO2 AuthenticatorState record alone
           * is ~210 bytes, plus 35 per populated ECC slot and 515 if any RSA
           * slot is set - so a key further through the suite types for longer
           * than the one measured here. Doubling covers that without being a
           * guess about a specific key.
           *
           * The other two budgets move with it, and BOTH have to: drainKeyboard's
           * cap below, or the next suite starts while the key is still typing,
           * and OKRN_E2E_TIMEOUT_MS in tools/e2e.js, which is the whole-run
           * budget a capture that no longer skips eats 107 s of.
           */
          timeoutMs: 240000,
          onProgress: reportProgress,
        });
      } catch (e) {
        clearInterval(heartbeat);
        const message = String(e && e.message);

        /*
         * The device SAID why, which is the outcome worth having: hidprint goes
         * out before the typing starts, so the reason arrives by name rather
         * than as a capture that times out with a partial file.
         *
         * Draining first, because the device is mid-URL and the next suite will
         * otherwise open inside a window where vendor answers nothing.
         */
        if (/no backup key set/i.test(message)) {
          log(`the device refused: ${message}`);
          /*
           * Drain FIRST. The device is mid-URL - 110 characters of
           * "No Backup Key - Follow instructions here ..." - and anything that
           * talks to it while it is still typing lands in a window where the
           * vendor interface answers nothing
           * (FINDING-the-backup-refusal-is-typed-and-blocks-the-device.md).
           */
          await drainKeyboard(log);

          /*
           * SET IT, rather than skipping for the life of the device.
           *
           * This is the CONFIG-MODE PASS. Provisioning gives a fresh key its
           * passphrase for free, in first-use state before the reboot
           * (0-provision), so reaching here means an already-initialised key
           * that never got one - and for that key the only route is config
           * mode, because OKSETPRIV needs `configmode || !initcheck` and
           * neither the device nor we can go back to first use.
           *
           * Config mode then silences CTAPHID until a restart, so the suites
           * behind this one fail for the rest of THIS pass. That is the cost,
           * and it is the shape the suite already has: a device needs three
           * passes - one for the base setup, one that takes config mode and
           * does all of it, and one that uses everything. 0-provision's own
           * "run me again" says the same thing. So this pass sets it, and the
           * digest chain verifies on the next one.
           *
           * inConfigMode() does not come back out, and cannot: there is no
           * in-place firmware restart (OkEmu.restart() rejects
           * unconditionally, and 1-softKey pins that refusal). The runner
           * force-stops the app when this pass ends, and that IS the power
           * cycle.
           */
          const said = await inConfigMode(
            device, PIN, log,
            () => writeBackupPassphrase(device, log));

          assert.ok(acknowledged(said),
            `this key had no backup passphrase and the device would not take `
            + `one: ${said}`);

          skip(
            'this key had no backup passphrase; it has one NOW. The digest '
            + 'chain is what went unverified, and it verifies on the next '
            + 'pass - this one took config mode to do the setup, so CTAPHID '
            + 'is silent for the suites behind it until the app restarts.',
          );
        }

        await drainKeyboard(log);
        throw e;
      }
      /* The success path needs it too, or the timer outlives the run. */
      clearInterval(heartbeat);

      log(`captured ${result.text.length} characters in ${Math.round((Date.now() - startedAt) / 1000)}s`);
      log(`digest: ${String(result.digest).slice(0, 16)}…`);
      log(`verified: ${result.verified}`);

      /*
       * Asserting on the digest rather than on the length. A capture that lost
       * one character to a dropped modifier is still thousands of characters
       * long and still looks like a backup file; the chain is what notices.
       *
       * FROM v2.1.2 ONLY. Before it the file has no digest line at all - the
       * rolling hash and the trailing `--<base64>` arrive together in the
       * v2.1.1..v2.1.2 firmware diff, and v2.1.1's okcore.cpp base64-encodes
       * each block and stops. verifyBackup() then reports 'no digest line
       * found', which is the truth about the file rather than a bad capture,
       * and asserting through it called three healthy versions broken:
       * v2.1.1, v2.1.0 and v0.2-beta.8 each failed this test on every run.
       *
       * What is left to check below that line is that the capture PARSES. That
       * is worth stating rather than skipping: a backup from those versions
       * can be restored and cannot be verified, which is a property of the
       * backup, not of this test.
       */
      if (device.capabilities.backupDigest) {
        assert.ok(result.verified,
          'the backup was captured but its digest chain does not check out - '
          + 'a character was decoded wrongly, or the capture ended early');
      } else {
        log(`no digest chain before v2.1.2; reason: ${result.reason || '(none given)'}`);
        assert.ok(result.text.includes(parsers.BACKUP_END),
          'the backup did not reach its END marker, so the capture was cut short');
        assert.ok(parsers.parseBackup(result.text).length > 0,
          'the backup reached its END marker but decodes to nothing');
      }

      /* Kept for the restore test below, which is armed and usually skips. */
      shared.text = result.text;
      shared.digest = result.digest;

      /*
       * EMIT THE WHOLE FILE when this suite was asked for by name, so a fixture
       * can be taken from a run instead of re-derived.
       *
       * A backup only exists as keystrokes the device TYPED - there is no
       * command that reads one back - so without this the only copy lives in
       * `shared.text` for the rest of the process and is then gone. Committing
       * one as a test fixture means `parseBackup`/`verifyBackup` and the restore
       * chunker can be exercised with no device at all, which is the only way
       * those paths get covered on a machine that has none.
       *
       * Gated on isNamed() for the same reason the restore test below is: a
       * plain sweep should not carry a key's material in its log, and twenty
       * lines of base64 in every version's output is noise. Ask for it and you
       * get it.
       *
       * The markers are there to be machine-read; tools/backup-fixture.js cuts
       * between them.
       */
      if (isNamed()) {
        log('----- FIXTURE BEGIN -----');
        for (const line of result.text.split('\n')) log(line);
        log('----- FIXTURE END -----');
      }
    });

    it('the backup RESTORES, and so does one from another key', async ({log, assert, skip}) => {
      /*
       * THE HALF THAT HAS NEVER RUN. device.restore() has existed all along and
       * nothing exercised it: this suite proved the device can TYPE a backup
       * and that the digest chain verifies, which says the file is intact and
       * says nothing about whether it can be put back. A backup that cannot be
       * restored is not a backup.
       *
       * It also matters more now than it did. With the vault gated to 3.0.5 no
       * derived data can exist on older firmware, so backup and restore carry
       * everything an upgrade needs to preserve - stored keys, slots, labels -
       * and the seed in slot 128 with them (the backup walks ECC slots
       * 101..132, okcore.cpp:7020). Restore IS the upgrade path, so it had
       * better work.
       *
       * ## Why restoring to the SAME key is the safe form
       *
       * The bytes going back are the bytes that came out, so the write is
       * idempotent: interrupted halfway, it has written what was already
       * there. That is what makes this runnable against a provisioned key at
       * all. It does NOT prove a cross-device restore, which needs two keys
       * and is a different test.
       *
       * ARMED, because it writes every key slot. `--only backupCapture` opts
       * into the whole exercise - capture then restore - and a plain sweep
       * runs the capture alone.
       */
      if (!isNamed()) {
        skip('writes every key slot. Run it with --only backupCapture.');
      }
      assert.ok(shared, 'the band test did not run');
      if (!shared.text) {
        skip('no backup was captured above, so there is nothing to restore');
      }
      const {device} = shared;

      /*
       * WHAT IT LOOKED LIKE BEFORE, so "it still works" is a comparison rather
       * than a feeling. Labels are the cheap witness: they are readable
       * without a touch and they live in the slots the restore rewrites.
       */
      const before = await device.readLabels({timeoutMs: 8000});
      log(`labels before: ${JSON.stringify(before.labels || before)}`);

      /*
       * RESTORE NEEDS CONFIG MODE, and capture needs it OFF - which is why
       * they cannot be one step.
       *
       * okcore.cpp's OKSETSLOT handler refuses a write whose first byte is not
       * 0xBA when `mod_keys_enabled && configmode == false`, answering "Error
       * not in config mode". The app already knows: BackupScreen renders
       * Restore with `unavailable={configMode === ON ? null :
       * NEEDS_CONFIG_MODE}`, and the capture panel directly above it with the
       * opposite gate.
       *
       * The first version of this test restored without entering it. The
       * stream went out and reported 672 bytes sent, and the refusal surfaced
       * on the NEXT call as a label read failing with "Error not in config
       * mode" - a command that had worked moments earlier. That reads as a
       * device that broke during the restore, and it was a precondition the
       * test never met.
       *
       * So the gesture happens between the two halves: capture with config
       * mode off, then enter it, then restore. inConfigMode() does not come
       * back out - the runner's force-stop at the end of the pass is the power
       * cycle - which is fine for an armed test and is why this one is armed.
       */
      let sent = null;
      const after = await inConfigMode(device, PIN, log, async () => {
        try {
          sent = await device.restore(shared.text, {
            onProgress: p => {
              if (p && p.block && p.packet === 1) log(`restoring block ${p.block}/${p.of}`);
            },
          });
        } catch (e) {
          throw new Error(
            `the backup verified but would not restore: ${e.message}. The `
            + 'device has been written to - read its labels before trusting it.');
        }
        log(`restored ${sent.bytes} bytes, digest ${String(sent.digest).slice(0, 16)}…`);

        /*
         * NOW A BACKUP FROM ANOTHER KEY, which is the case restore exists for.
         *
         * Restoring a key's own backup cannot fail the way a real restore
         * fails: the material already matches. The upgrade path is a key that
         * DIED, whose owner has a file taken on the firmware it was running,
         * and a replacement running something newer. The fixture is a file a
         * v3.0.4 key typed - the last SIGNED release - cut from a run by
         * tools/backup-fixture.js.
         *
         * IN THIS SAME WINDOW, and that is the device's constraint rather than
         * tidiness. Config mode ends only at a power cycle and the soft key has
         * no in-process restart, so there is no second window in this pass -
         * a separate test for this skipped with "the app already believes this
         * device is in config mode", which is how the constraint announced
         * itself. Leaving the undo for later would mean leaving the key holding
         * another device's slots until someone restarted the app.
         */
        const foreign = require('./fixtures/backup-v3.0.4.js');
        const check = parsers.verifyBackup(foreign);
        /*
         * Say WHICH failure. verifyBackup() names one of its two - "no digest
         * line found" - and on the other returns the two digests instead of a
         * reason, so both are spelled out here.
         */
        assert.equal(
          check.ok, true,
          `the committed fixture does not verify: ${
            check.reason || `digest ${check.digest} is not the expected ${check.expected}`
          }`,
        );
        assert.notEqual(
          check.digest, String(sent.digest),
          'the fixture and this key\'s backup are the same file, so this proves nothing',
        );

        const other = await device.restore(foreign, {
          onProgress: p => {
            if (p && p.block && p.packet === 1) log(`foreign block ${p.block}/${p.of}`);
          },
        });
        log(`accepted ${other.bytes} bytes from a v3.0.4 key, digest ${check.digest.slice(0, 16)}…`);
        assert.equal(other.digest, check.digest, 'the foreign restore sent a different file');

        /*
         * PUT IT BACK, immediately. If this throws the key is holding another
         * device's slots, and the message has to say so - a run that stopped
         * here quietly would leave a soft key that looks fine and is not.
         */
        try {
          const back = await device.restore(shared.text, {
            onProgress: p => {
              if (p && p.block && p.packet === 1) log(`restoring own block ${p.block}/${p.of}`);
            },
          });
          assert.equal(String(back.digest), String(shared.digest), 'this key was not put back');
          log('the key is back where it started');
        } catch (e) {
          throw new Error(
            'THE UNDO FAILED: this key now holds the v3.0.4 fixture\'s slots. '
            + `Restore its own backup before trusting it. Cause: ${e.message}`);
        }

        /*
         * READ IT BACK FROM INSIDE config mode. OKGETLABELS is on the
         * config-mode allowlist - it is what configModeReady() probes with -
         * so this is the same evidence it would be outside, without leaving.
         */
        return device.readLabels({timeoutMs: 8000});
      });

      /*
       * AND IT IS STILL THE SAME KEY. A restore that completes and leaves the
       * device unreadable has failed at the only thing being asked of it.
       */
      log(`labels after:  ${JSON.stringify(after.labels || after)}`);

      /*
       * WHAT THIS TEST PROVES, and what it deliberately does not.
       *
       * PROVES: a backup this device produced is accepted back by it. The
       * stream was framed, every packet acknowledged, and the device did not
       * refuse - which is the half that had never run at all, and the half
       * that a production key cannot show you, because it has no console to
       * say where a restore stopped.
       *
       * DOES NOT PROVE the contents came back. Reading labels immediately
       * afterwards shows the first few as null where they held text before,
       * and that is not loss: the device has written flash and has not
       * RELOADED it. BackupScreen says exactly this to the user after a
       * restore - "Restart the app so the key reloads what it now holds" - and
       * `initialized` is recomputed from flash only in setup(), the same
       * reason provisioning takes two runs.
       *
       * So content verification belongs in the NEXT pass, after the runner's
       * force-stop, which is the three-pass shape this suite already has. The
       * labels are logged rather than asserted because an assertion here would
       * be testing the reload, not the restore, and would fail for a reason
       * that has nothing to do with backups.
       */
      assert.ok(sent && sent.bytes > 0,
        'restore reported no bytes, so nothing was sent');
      assert.equal(String(sent.digest), String(shared.digest),
        'the device accepted a restore whose digest is not the one captured');
      log('restore accepted. Contents reload at the next app start - the '
        + 'runner restarts at the end of this pass.');
    });
  });
};
