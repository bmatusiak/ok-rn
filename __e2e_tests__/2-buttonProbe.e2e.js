/**
 * Does a simulated button press reach the firmware, and does it arrive as the
 * button that was pressed?
 *
 * okemu_set_button() sat in the HAL from the start with nothing calling it, so
 * until now a press could only be delivered over the DEBUG serial console -
 * which is #ifdef DEBUG and would not exist in a release build. User presence
 * is not optional: every FIDO2 signing operation waits on one.
 *
 * The second half of that question is the one that matters. The first version
 * of this probe asked only "did the firmware react", pressed button 1, and
 * passed - while the device logged "password appended with 5". The HAL's table
 * had been seeded with the TOUCHPIN order rather than the button order, and
 * the two are a permutation of each other (ok_hal.cpp:452-473). A Confirm
 * control wired to the wrong button is worse than no Confirm control, so this
 * now checks all six.
 *
 * MUST RUN LOCKED, AND FIRST. While locked a press appends to the PIN buffer
 * and the firmware prints the digit (OnlyKey.ino:958-963), which is what makes
 * the mapping observable. Once unlocked the same press runs gen_press() and
 * types a slot's contents at the keyboard instead - no digit, and side effects.
 */
'use strict';
const {getOnlyKey} = require('../src/onlykey');
const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;
const {IFACE} = OkEmuModule;

const delay = ms => new Promise(r => setTimeout(r, ms));

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
    read: () => text,
    take: () => { const out = text; text = ''; return out; },
    off,
  };
}

/** One press, and the digit the firmware said it was - null if it said none. */
async function pressAndRead(tap, button) {
  tap.take();
  await OkEmu.pressButton(button);
  await delay(1000);
  const said = tap.take();
  const hits = said.match(/password appended with (\d)/g) || [];
  if (hits.length !== 1) return {digit: null, hits: hits.length, said};
  return {digit: Number(hits[0].slice(-1)), hits: 1, said};
}

module.exports = function buttonProbe({describe, it}) {
  describe(buttonProbe.name, () => {
    it('every button arrives as itself', async ({log, assert}) => {
      if (!OkEmu.isRunning()) await OkEmu.start();
      // setup() runs on its own thread; let it reach the main loop before the
      // first press, or the touch baseline has not been taken yet.
      await delay(1500);

      /*
       * HOW MANY BUTTONS THIS DEVICE HAS, from the device.
       *
       * A classic has six pads. A DUO has TWO, and its third button is both of
       * them at once - okcore.cpp's sense loop has no third branch for a DUO,
       * it reads the two pads as buttons 2 and 1 and each branch checks whether
       * the other is also held. Its touchread1, 4, 5 and 6 branches are guarded
       * `!= OK_HW_DUO`, so those pads produce no button at all.
       *
       * This used to walk 1..6 unconditionally, which on a DUO asserts three
       * buttons that do not exist. Reading the count is not merely tidier: the
       * pads BEYOND the count must stay silent, and that is worth checking too
       * - a device that answered button 5 would be one whose mapping had
       * drifted into the classic table.
       */
      const {device} = await getOnlyKey();
      const buttons = (device.capabilities && device.capabilities.buttons) || 6;
      log(`this device has ${buttons} buttons`);

      const tap = serialTap();
      const seen = {};
      try {
        for (let button = 1; button <= 6; button++) {
          const {digit, hits} = await pressAndRead(tap, button);
          seen[button] = digit;
          log(`pressed ${button} -> firmware said ${digit} (${hits} line(s))`);
        }
      } finally {
        tap.off();
      }

      log(`mapping: ${JSON.stringify(seen)}`);
      for (let button = 1; button <= buttons; button++) {
        assert.equal(
          seen[button], button,
          `pressing button ${button} registered as ${seen[button]}`,
        );
      }
      for (let button = buttons + 1; button <= 6; button++) {
        assert.equal(
          seen[button], null,
          `this device has ${buttons} buttons, but ${button} answered as ` +
            `${seen[button]} - the mapping has drifted`,
        );
      }
    });

    it('leaves the PIN buffer clean for the suites that follow', async ({log, assert, skip}) => {
      /*
       * A DUO HAS NO BUTTON PIN BUFFER TO CLEAN.
       *
       * Its PIN travels in the message body - one OKPIN carrying the digits as
       * ASCII - so presses never append to a password buffer and there is
       * nothing here to roll over. The cleanup below also pads with button 6,
       * which a DUO does not have.
       */
      const {device} = await getOnlyKey();
      if (device.deviceType === 'duo') {
        skip('a DUO carries its PIN in the message body, so presses never enter a buffer');
      }

      /*
       * Six presses are now sitting in the password buffer, and the next suite
       * unlocks with a seven-digit PIN. Thirteen appends would overrun
       * pass_keypress' limit of ten mid-PIN, resetting the buffer partway
       * through and failing an unlock that is perfectly correct.
       *
       * So drive it to the limit deliberately. pass_keypress starts at 1 and
       * the tenth press takes the else branch, which calls password.reset()
       * and sets it back to 1 (OnlyKey.ino:964-989). Six done, four to go.
       *
       * BUTTON 6, NOT BUTTON 1. The mapping test above pressed 1,2,3,4,5,6 in
       * order, which is a PREFIX OF THE PIN - and the first version of this
       * padded with button 1, spelling 1234561 exactly. The device unlocked
       * mid-cleanup and the three remaining presses ran gen_press() and typed
       * a slot at the keyboard ("Slot Number 1", "Displaying Full Keybuffer").
       * profile1hashevaluate() hashes the whole buffer, so only the exact
       * sequence matches; 1234566666 cannot collide with a seven-digit PIN.
       *
       * This costs one session_attempt of the three allowed, and sets
       * firsttime, so the EEPROM failed-login counter ticks up once more this
       * boot. Both are reset by the successful unlock that follows.
       */
      const tap = serialTap();
      try {
        for (let i = 0; i < 4; i++) {
          await OkEmu.pressButton(6);
          await delay(1000);
        }
      } finally {
        tap.off();
      }

      const said = tap.read();
      log(`tail: ${JSON.stringify(said.split('\n').filter(Boolean).slice(-4))}`);
      assert.ok(
        /Login Failed/i.test(said),
        'the buffer never rolled over, so the next unlock starts with junk in it',
      );
      assert.ok(
        !/UNLOCKED/.test(said),
        'the padding presses spelled the PIN - the device is unlocked and the ' +
          'suites that follow expect it locked',
      );
    });
  });
};
