/**
 * DOES THE DEBUG CONSOLE READ WHAT IS WRITTEN TO IT? Measured, and it decides
 * whether real hardware can be driven by software at all.
 *
 * `device.unlock()` defaults to writing PIN digits to SEREMU with `pressLine()`.
 * Whether anything reads them is `capabilities().consolePress`, and this suite
 * is what keeps that honest against whichever firmware is staged.
 *
 * ## Why the question was open
 *
 * Two readings of the firmware concluded the console was write-only - and they
 * were right about every RELEASED firmware, where `Serial.read` does not appear
 * in `okcore.cpp` at all. The working tree added a full parser at `:2689`. So
 * the answer is a version capability, not a fact.
 * See FINDING-the-debug-console-is-a-control-channel-on-new-firmware-only.md.
 *
 * ## THE ECHO IS THE OBSERVABLE, AND NOTHING IS PRESSED
 *
 * `dbg_commit_line()` prints `I received from DEBUG: <first byte>` BEFORE it
 * acts on the line, and its own comment says clients use it both as a per-line
 * acknowledgement and as a "the firmware is running loop()" readiness probe.
 * An unrecognised first byte does nothing beyond that echo.
 *
 * So this sends a byte that is neither a button (1-6) nor a command (0, 8, 9)
 * and looks for the echo. That is a complete answer with NO side effects.
 *
 * ## Why it is not done by pressing, which is how this was learned
 *
 * The first version of this suite proved the point by pressing a button while
 * LOCKED and watching for `password appended with N`. It worked - and it
 * appended a digit to the PIN buffer on every run, which the firmware counts as
 * a failed attempt. Run enough times, the device WIPES ITSELF back to
 * unconfigured, which is exactly what happened to the bench key.
 * See FINDING-probing-on-a-locked-key-burns-pin-attempts.md.
 *
 * The echo costs nothing, works in either lock state, and cannot wipe anything.
 */
'use strict';

const {getOnlyKey} = require('../src/onlykey');

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;
const {IFACE} = OkEmuModule;

const delay = ms => new Promise(r => setTimeout(r, ms));

/**
 * A byte the parser recognises as neither a press nor a command.
 *
 * `dbg_commit_line` sends 1-6 to the press parser and everything else to the
 * command parser, which knows 0, 8 and 9. 'Z' reaches the command parser, is
 * not one of those, and so produces the echo and nothing else. Its ASCII value
 * is what the echo carries, because the echo prints the byte as a number.
 */
const INERT = 'Z';
const INERT_CODE = INERT.charCodeAt(0);

/** Everything the device has said on SEREMU since the listener went on. */
function serialTap() {
  let text = '';
  const off = OkEmu.on('stream', e => {
    if (e.iface !== IFACE.SEREMU || e.dir !== 0) return;
    for (const b of e.bytes) {
      if (b >= 0x20 && b <= 0x7e) text += String.fromCharCode(b);
      else if (b === 0x0a) text += '\n';
    }
  });
  return {
    take: () => {
      const out = text;
      text = '';
      return out;
    },
    off,
  };
}

let shared = null;

module.exports = function pressLineProbe({describe, it}) {
  describe(pressLineProbe.name, () => {
    it('the console is being listened to at all', async ({log, assert}) => {
      if (!OkEmu.isRunning()) await OkEmu.start();

      const {device} = await getOnlyKey();
      const state = await device.connect();
      log(`device: ${String(state.status).trim()}`);

      /*
       * The tap has to see SOMETHING before an absence means anything. The
       * firmware talks on SEREMU constantly, so a silent tap is a broken
       * listener rather than a silent device - and that distinction is the
       * whole reason this control exists.
       */
      const tap = serialTap();
      try {
        await delay(1500);
        const heard = tap.take();
        log(`heard ${heard.length} characters of console output`);
        assert.ok(
          heard.length > 0,
          'nothing at all arrived on SEREMU, so this build has no console and ' +
            'the question is not answerable here',
        );
        shared = {device};
      } finally {
        tap.off();
      }
    });

    it('and it either ANSWERS a line, or is write-only', async ({log, assert}) => {
      assert.ok(shared, 'the listener test did not run');
      const {device} = shared;

      const caps = device.capabilities;
      log(`capabilities says consolePress: ${caps ? caps.consolePress : 'unknown'}`);

      const tap = serialTap();
      try {
        tap.take();

        /*
         * device.press() IS pressLine - the device plugin's own wrapper, and
         * the exact path unlock() takes when given no enterDigits. One write
         * for the whole line, terminated by a newline.
         *
         * INERT rather than a digit: this asks whether the line is READ, not
         * whether a button moves. Nothing is pressed and no PIN attempt is
         * spent either way.
         */
        await device.press(INERT);
        log(`wrote ${JSON.stringify(INERT)} to SEREMU via device.press (pressLine)`);

        /*
         * Generous. The echo is printed from loop(), one byte consumed per
         * iteration, so a short line is answered within a few iterations - but
         * a slow build has room here.
         */
        await delay(3000);
        const said = tap.take();

        const echo = new RegExp(`I received from DEBUG: *${INERT_CODE}`).test(said);
        log(`echo for byte ${INERT_CODE}: ${echo ? 'yes' : 'none'}`);

        /*
         * ASSERTED AGAINST THE CAPABILITY, so this suite is what notices either
         * half of it drifting - the #ifdef DEBUG gate or the version boundary.
         *
         * When the device is LOCKED the version is not in the status, so
         * capabilities cannot answer and the echo is taken as the truth. That
         * is not a cop-out: it is the situation a host is actually in when it
         * needs to know, because pressing is how you unlock.
         */
        const known = Boolean(caps && caps.debugConsole !== null);
        log(`version known: ${known}${known ? '' : ' (locked - no version in the status)'}`);

        if (known) {
          assert.equal(
            echo, Boolean(caps.consolePress),
            `capabilities says consolePress=${caps.consolePress} and the device ` +
              `${echo ? 'answered' : 'did not answer'} - one of them is wrong`,
          );
        } else {
          log('capabilities cannot answer while locked; recording what the ' +
            'device did instead');
        }

        if (echo) {
          log('THE CONSOLE READS ITS INPUT. On this firmware a host can drive ' +
            'the key in software - presses, holds by tier, explicit tick ' +
            'counts, restart.');
        } else {
          log('THE CONSOLE IS WRITE-ONLY on this firmware. unlock() must be ' +
            'given enterDigits, and on real hardware every press needs a finger.');
        }
      } finally {
        tap.off();
      }
    });
  });
};
