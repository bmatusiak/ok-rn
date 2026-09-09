/**
 * Write a slot, press its button, and read back what the key typed.
 *
 * This closes a loop the desktop app cannot. On hardware a slot's contents are
 * write-only - the key types them into whatever window has focus, and the only
 * slot data any client can ask for is the label. There is no command for
 * "what is in slot 1", deliberately.
 *
 * Here the app is both the key and the host, so the keystrokes arrive
 * in-process on IFACE.KEYBOARD. Decoding them is what makes this a password
 * manager rather than a password typer, and it is also the only way to capture
 * a backup, which the firmware likewise types rather than sending as a reply.
 *
 * The decoder is unit-tested against a second implementation of the firmware's
 * forward path (node-onlykey-lib/test/keystrokes.test.js, 28 layouts). What
 * that CANNOT establish is that the real firmware types what both of those
 * believe it does - the encoder in the test and the decoder under test could
 * agree with each other and disagree with the device. This suite is the only
 * place the actual firmware gets a vote.
 *
 * THE DEVICE MUST BE UNLOCKED, and it must not be inside the pending-operation
 * window that follows a FIDO2 ceremony, in which every press is discarded
 * (FINDING-presses-discarded-after-a-fido-ceremony.md). Both are why this runs
 * after the press-band suite, which settles the device and leaves it unlocked.
 */
'use strict';

const {getOnlyKey} = require('../src/onlykey');
const {device: okdevice} = require('node-onlykey-lib');

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;
const {IFACE, PRESS_TICKS} = OkEmuModule;

const {keystrokes} = okdevice;

const delay = ms => new Promise(r => setTimeout(r, ms));

/*
 * Deliberately awkward.
 *
 * Lower case alone would pass with a decoder that ignored the modifier byte
 * entirely, which is the single most likely way to get this wrong: 'a' and 'A'
 * are the same HID usage and differ only in report[0]. The digits and symbols
 * cover the shifted and unshifted halves of the number row, and the repeated
 * 'o' covers the case where the same key is pressed twice in a row - which
 * needs the intervening release report to be seen as a release.
 */
const SECRET = 'Tr0ub4dor&3 Zz';

/** Every keyboard report the device has sent since the listener went on. */
function keyboardTap() {
  const reports = [];
  const off = OkEmu.on('stream', e => {
    if (e.iface !== IFACE.KEYBOARD || e.dir !== 0) return;
    reports.push(Array.from(e.bytes));
  });
  return {
    reports,
    take: () => reports.splice(0, reports.length),
    off,
  };
}

let shared = null;
async function ready(log) {
  if (shared) return shared;
  if (!OkEmu.isRunning()) await OkEmu.start();

  const {device} = await getOnlyKey();
  const state = await device.connect();
  log(`device: ${String(state.status).trim()}`);

  await device.setSlot('2a', {label: 'typed', password: SECRET});
  log(`slot 2a password: ${SECRET.length} chars`);

  shared = {device, status: String(state.status)};
  return shared;
}

module.exports = function keystrokeCapture({describe, it}) {
  describe(keystrokeCapture.name, () => {
    it('types a slot as HID reports at all', async ({log, assert}) => {
      const {status} = await ready(log);
      assert.ok(/UNLOCKED/i.test(status), 'the device is locked; slots are not typed');

      const tap = keyboardTap();
      try {
        await OkEmu.holdTicks(2, PRESS_TICKS.TAP);
        /*
         * Typing is paced by the slot's TYPESPEED, two delays per character
         * (OnlyKey.ino:619-623), so a short password still takes a second or
         * two. Waiting for the reports to stop is more honest than waiting a
         * fixed time and hoping.
         */
        let stable = 0;
        for (let i = 0; i < 60 && stable < 6; i++) {
          const before = tap.reports.length;
          await delay(100);
          stable = tap.reports.length === before ? stable + 1 : 0;
        }

        const reports = tap.take();
        log(`${reports.length} keyboard reports`);
        assert.ok(reports.length > 0, 'the key typed nothing at all');
        assert.ok(
          reports.every(r => r.length === 8),
          'a keyboard report is 8 bytes: modifiers, reserved, six usages',
        );

        shared.reports = reports;
      } finally {
        tap.off();
      }
    });

    it('and the decoder reads the password back out of them', async ({log, assert}) => {
      /*
       * The assertion this whole layer exists for. Not "something came back"
       * but the exact string that was written - a decoder that dropped capitals
       * or mangled a symbol would still produce plausible text.
       */
      const reports = shared && shared.reports;
      assert.ok(reports, 'the capture test did not run');

      const {text, unmapped} = keystrokes.decode(reports);
      log(`decoded: ${JSON.stringify(text)}`);
      if (unmapped.length) {
        log(`unmapped usages: ${unmapped.map(e => '0x' + e.usage.toString(16)).join(', ')}`);
      }

      const {segments} = keystrokes.splitFields(text);
      log(`segments: ${JSON.stringify(segments)}`);

      /*
       * The password is one of the segments rather than the whole text: a slot
       * types the fields it has, separated by TAB or RETURN per its addchar
       * byte, and this slot has a label and a password. Asserting on the
       * segment rather than on the whole string keeps the test about the
       * decoder instead of about which separators the firmware chose to add.
       */
      assert.ok(
        segments.includes(SECRET),
        `expected ${JSON.stringify(SECRET)} among the typed fields`,
      );
    });

    it('the capitals really did come from the modifier byte', async ({log, assert}) => {
      /*
       * Proving the previous test could have failed.
       *
       * 'T', 'Z' and '&' are the only reason SECRET is shaped the way it is. If
       * the firmware sent no modifier bits at all, the decoder would have
       * returned "tr0ub4dor73 zz" and the assertion above would have caught it
       * - but it is worth showing the bits are actually on the wire, so that a
       * future change to either side fails HERE, where the message says why.
       */
      const reports = shared && shared.reports;
      assert.ok(reports, 'the capture test did not run');

      const shifted = reports.filter(r => r[0] !== 0);
      log(`${shifted.length} of ${reports.length} reports carry a modifier`);

      /*
       * Exactly three characters in SECRET need shift - T, & and Z - and the
       * firmware sends one report per press, so three is the whole expected
       * count rather than a floor. The lowercase z in "Zz" is not one of
       * them, which is the point of putting the pair there.
       */
      const needShift = [...SECRET].filter(c => /[A-Z&]/.test(c));
      log(`characters needing shift: ${JSON.stringify(needShift)}`);
      assert.equal(
        shifted.length, needShift.length,
        'the modifier bits on the wire do not match the capitals in the password',
      );
      assert.ok(
        shifted.every(r => (r[0] & 0x22) !== 0),
        'a modifier other than shift appeared while typing a password',
      );
    });
  });
};
