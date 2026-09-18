/**
 * How long a button press actually costs, measured rather than assumed.
 *
 * Entering a PIN on the pad is slow enough to feel broken, and the numbers
 * quoted around the codebase disagree: usePressQueue and three screens say
 * "~400ms", which was the figure BEFORE settleRelease started waiting out
 * RELEASE_ROUNDS. Nobody has timed it since.
 *
 * This exists to compare press strategies on one yardstick. It asserts almost
 * nothing about the result - the point is the number in the log - but it does
 * fail if a press has become pathologically slow, because that is the symptom
 * this whole line of work started from.
 *
 * ## It runs LATE in the order, and that is not arbitrary
 *
 * These presses are real. On a locked key the firmware appends each one to its
 * PIN buffer, and that buffer CANNOT BE CLEARED by asking - clearPinEntry
 * appends before it resets, and the rollover leaves the count at one rather
 * than at zero. So a benchmark sitting early in the order left digits in front
 * of every later unlock: `deviceFlow` entered 1234561 onto the end of them and
 * was refused, and the failure looked like a regression in the press path
 * rather than in the thing measuring it. It cost a wrong diagnosis twice.
 *
 * Numbered after 7-pressBands so nothing that needs to unlock runs behind it.
 * The rollover padding below is kept as well - belt and braces, not a fix.
 *
 * ## Where the time goes, from the source
 *
 * A press is N sense rounds, and a round is one checkKey(), scheduled by
 * SoftTimer at TIME_POLL = 50ms (OnlyKey.ino:210). PRESS_TICKS.TAP is 10, and
 * settleRelease waits RELEASE_ROUNDS = 4 more so the next press cannot merge
 * into this one - so a tap is ~14 rounds, plus a 25ms poll to notice each
 * transition. Nothing in that path is CPU-bound; it is all waiting for a task.
 */
'use strict';

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;
const {protocol, device} = require('node-onlykey-lib');

const delay = ms => new Promise(r => setTimeout(r, ms));

/** Seven presses, because that is the shortest PIN the firmware accepts. */
const SAMPLE = [1, 2, 3, 4, 5, 6, 1];

module.exports = function pressBench({describe, it}) {
  describe(pressBench.name, () => {
    it('times a seven-press burst', async ({log, assert}) => {
      if (!OkEmu.isRunning()) {
        await OkEmu.start();
        await delay(1500);
      }

      /*
       * Warm one press first. The very first round after a quiet period can
       * include a task re-registration that fires immediately
       * (SoftTimer.add sets lastCallTime back by one period), which would
       * flatter whichever strategy happens to run first.
       */
      await OkEmu.pressButton(1);

      const roundsBefore = await OkEmu.rounds();
      const started = Date.now();
      await OkEmu.pressQueue(SAMPLE.join(''));
      const elapsed = Date.now() - started;
      const roundsUsed = (await OkEmu.rounds()) - roundsBefore;

      const per = Math.round(elapsed / SAMPLE.length);
      log(`${SAMPLE.length} presses in ${elapsed}ms - ${per}ms each`);
      log(`${roundsUsed} sense rounds - ${(roundsUsed / SAMPLE.length).toFixed(1)} per press`);
      log(`ticks per tap: ${device.press.PRESS_TICKS.TAP}, release rounds: ${device.press.RELEASE_ROUNDS}`);

      /*
       * A ceiling, not a target. One second per press means something is
       * badly wrong - a stalled loop, or a settle that is not settling - and
       * that is worth failing over. The improvement itself is read from the
       * log, because "faster than last time" is not a property this suite can
       * know.
       */
      assert.ok(per < 1000, `a press took ${per}ms, which is not a press any more`);

      /*
       * PUT THE PIN BUFFER BACK, or every suite after this one fails to unlock.
       *
       * These presses are real. On a LOCKED key the firmware appends each one
       * to its PIN buffer, so measuring seven of them leaves seven digits in
       * it - and deviceFlow's unlock then enters 1234561 onto the end of them
       * and is refused. That is exactly what happened when this suite was
       * first added: `unlocks with the PIN` started failing, and the two tests
       * behind it, and it looked like a regression in the press path rather
       * than in the thing measuring it.
       *
       * THE BUFFER CANNOT BE CLEARED by asking - the firmware's clearPinEntry
       * APPENDS before it resets. The only clean way back to empty is its own
       * rollover, which is what rolloverPresses computes: pad to MAX_DIGITS
       * and the tenth press resets it. Button 6 by default, never 3, because
       * 3 held is the lock gesture.
       */
      const padding = device.pin.rolloverPresses(SAMPLE.length);
      if (padding.length) {
        await OkEmu.pressQueue(padding.join(''));
        log(`cleared the PIN buffer with ${padding.length} more presses`);
      }
      void protocol;
    });
  });
};
