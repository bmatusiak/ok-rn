/**
 * Enter a PIN by pressing the device's buttons, not by typing at its console.
 *
 * `device.unlock()` defaults to writing the digits over SEREMU with pressLine.
 * That is a DEBUG-BUILD FEATURE: the whole simulated-press command interface
 * sits inside `#ifdef DEBUG` in okcore.cpp, so on a production build the
 * firmware never reads what is written there. It does not refuse - it says
 * nothing, and unlock() times out with a message about the PIN possibly being
 * wrong. The PIN is fine; nothing is listening.
 *
 * Pressing buttons works on either build, because a button is a button. ok-rn's
 * PIN screen has always done it this way for exactly this reason; passing this
 * as `enterDigits` is what lets the suite use the library's unlock() rather than
 * reimplementing it, on whichever firmware is staged.
 *
 * ## Why the presses are sequential and paced by the firmware
 *
 * holdTicks() waits for the RELEASE to be observed before returning
 * (RELEASE_ROUNDS idle sense rounds), because counted presses with no idle gap
 * between them MERGE - their durations sum, and eight taps in a row would cross
 * the gesture band and take a backup instead of entering a PIN. So these are
 * awaited one at a time on purpose; firing them together is the bug this
 * pacing exists to prevent.
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
    for (const ch of String(digits)) {
      const button = Number(ch);
      if (!Number.isInteger(button) || button < 1 || button > 6) {
        throw new Error(
          `pressDigits: "${ch}" is not a button - a PIN digit is 1..6, ` +
            'because the digits ARE the buttons',
        );
      }
      await OkEmu.pressButton(button);
      if (log) log(`pressed ${button}`);
    }
  };
}

module.exports = {pressDigits};
