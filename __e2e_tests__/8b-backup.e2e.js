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
          await drainKeyboard(log);
          skip(
            'this key has no backup key set, so the firmware types a URL instead '
            + 'of a backup. The gesture and the refusal both work; the digest '
            + 'chain is what went unverified. Set a backup passphrase on the '
            + 'device to make this test run.',
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
       */
      assert.ok(result.verified,
        'the backup was captured but its digest chain does not check out - '
        + 'a character was decoded wrongly, or the capture ended early');
    });
  });
};
