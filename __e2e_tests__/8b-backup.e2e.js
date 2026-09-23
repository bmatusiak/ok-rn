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
async function drainKeyboard(log, quietMs = 1500, capMs = 20000) {
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
      let lastProgressAt = 0;
      const reportProgress = ({characters}) => {
        const now = Date.now();
        if (now - lastProgressAt < 10000) return;
        lastProgressAt = now;
        log(`still typing: ${characters} characters so far`);
      };

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
          timeoutMs: 120000,
          onProgress: reportProgress,
        });
      } catch (e) {
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

      log(`captured ${result.text.length} characters`);
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
