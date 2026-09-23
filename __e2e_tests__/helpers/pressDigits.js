/**
 * Enter a PIN by pressing the device's buttons, not by typing at its console.
 *
 * `device.unlock()` defaults to writing the digits over SEREMU with pressLine.
 * Whether anything reads them is `capabilities().consolePress`, and it takes
 * TWO conditions - which is a correction to what this comment used to say.
 *
 * It said the press interface was a debug-build feature and left it there. The
 * build half is right: the parser sits inside `#ifdef DEBUG` (okcore.cpp:2360).
 * The half it missed is the VERSION. No released firmware reads the console at
 * all - `Serial.read` does not appear in okcore.cpp in v3.0.2 or any older pin
 * - so on every release, debug build or not, the digits go nowhere. It does not
 * refuse; it says nothing, and unlock() times out blaming the PIN. The PIN is
 * fine. See FINDING-the-debug-console-is-a-control-channel-on-new-firmware-only.md,
 * which was written after a probe contradicted two readings of the source.
 *
 * Pressing buttons works on either build, because a button is a button. ok-rn's
 * PIN screen has always done it this way for exactly this reason; passing this
 * as `enterDigits` is what lets the suite use the library's unlock() rather than
 * reimplementing it, on whichever firmware is staged.
 *
 * ## The separation is STRUCTURAL now, not paced
 *
 * This paragraph used to explain why the digits were pressed one at a time:
 * holdTicks() waits for the RELEASE to be observed (RELEASE_ROUNDS idle sense
 * rounds), because counted presses with no idle gap between them MERGE - their
 * durations sum, and eight taps in a row would cross the gesture band and take
 * a backup instead of entering a PIN.
 *
 * All true, and no longer what this file does. It hands the whole run to
 * pressQueue, where okemu_press_take() refuses to give the firmware the next
 * press until the loop has taken the last - so the gap is guaranteed by the
 * queue rather than waited out, and a merge cannot happen. That is also what
 * the app itself does (useOkEmu.ts:602), which is the point: a helper that
 * entered PINs some other way would be testing a path no user takes.
 *
 * The description outlived the code it described - the same shape as the
 * `yield()` comment and the "do not call device.unlock() here" comment, both
 * of which were true when written and became instructions to keep a workaround
 * nobody needed. Kept rather than deleted because the merge hazard is REAL on
 * the sensed path, which is still how gestures are performed, and a reader who
 * finds holdTicks elsewhere should find the reason here.
 */
'use strict';

const OkEmuModule = require('../../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;

/**
 * @param {object} [opts]
 * @param {function} [opts.log] called with each digit as it is pressed
 * @returns {function(string): Promise<void>} an `enterDigits` hook
 */
function pressDigits({log} = {}) {
  return async digits => {
    const text = String(digits);
    for (const ch of text) {
      const button = Number(ch);
      if (!Number.isInteger(button) || button < 1 || button > 6) {
        throw new Error(
          `pressDigits: "${ch}" is not a button - a PIN digit is 1..6, ` +
            'because the digits ARE the buttons',
        );
      }
    }

    /*
     * HANDED OVER, NOT SENSED, and the whole run in one call.
     *
     * This pressed them one at a time through pressButton(), which emulates a
     * finger and waits out the rounds: ~757-855ms EACH, so a seven-digit PIN
     * cost five to six seconds of every suite that unlocks. pressQueue writes
     * the durations into the loop instead and returns when the firmware has
     * taken them all. Same presses, same bands - see OkEmu.pressQueue.
     */
    await OkEmu.pressQueue(text);
    if (log) log(`pressed ${text.split('').join(' ')}`);
  };
}

module.exports = {pressDigits};
