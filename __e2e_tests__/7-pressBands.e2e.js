/**
 * Does a press land in the band it was asked for?
 *
 * The firmware decides what a press MEANS from how many main-loop iterations
 * saw the pad held, and nothing in that path reads a clock (OnlyKey.ino:936-942):
 *
 *     <= 20      gen_press()   types slot N
 *     21 .. 89   gen_hold()    types slot N+6, the b profile
 *     >= 90      rejected
 *
 * and, reached FIRST because each of those branches returns before the band
 * dispatch (OnlyKey.ino:873-914):
 *
 *     >= 72, button 1   backup()
 *     >= 72, button 2   get_key_labels()
 *     >= 72, button 3   lock + CPU_RESTART()
 *     >= 72, button 6   config mode
 *
 * So every hold this app performs is aimed between two walls it cannot see:
 * too short and it reads the wrong slot, too long and it takes a backup or
 * restarts the key. Until now holds were timed in milliseconds, which is a bet
 * on how fast this particular handset runs the loop - a number nobody has ever
 * measured, that differs per device and per build, and that the phone's own
 * scheduler moves around under load.
 *
 * okemu_set_button_ticks() replaces the bet with a count. This proves it, and
 * proves it BY SLOT NUMBER rather than by timing: the two bands are made to
 * read two different slots, and the firmware says which one it read.
 *
 * THE DEVICE MUST BE UNLOCKED. While locked, payload() ignores duration
 * entirely and every press just appends a PIN digit (OnlyKey.ino:632-640), so
 * the bands are not observable at all - which is why this runs after the
 * device-flow suite rather than beside the button probe.
 */
'use strict';

const {getOnlyKey} = require('../src/onlykey');

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;
const {IFACE, PRESS_TICKS} = OkEmuModule;

const delay = ms => new Promise(r => setTimeout(r, ms));

/*
 * Two slots, told apart by the LENGTH of what they hold.
 *
 * process_slot() prints "Slot Number N" using button_selected, not the slot it
 * resolved (OnlyKey.ino:1082-1083), so both bands print the same number and
 * that line cannot answer the question. "Password Length = N" is read from the
 * slot actually processed (OnlyKey.ino:1203-1209), so two different lengths in
 * 1a and 1b make the band directly observable with no decoder involved.
 */
const A_PASSWORD = 'aaaaa';           // slot 1  - what a tap must read
const B_PASSWORD = 'bbbbbbbbbbbbb';   // slot 7  - what a hold must read

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

/** The password length the firmware reported for the slot it just processed. */
function passwordLength(said) {
  const hits = said.match(/Password Length = (\d+)/g) || [];
  if (hits.length !== 1) return {length: null, hits: hits.length};
  return {length: Number(hits[0].match(/(\d+)$/)[1]), hits: 1};
}

let shared = null;
async function provisioned(log) {
  if (shared) return shared;
  if (!OkEmu.isRunning()) await OkEmu.start();

  const {device} = await getOnlyKey();
  const state = await device.connect();
  log(`device: ${String(state.status).trim()}`);

  /*
   * Written every run rather than once. The suite has to be able to run twice
   * against the same storage, and a slot whose password is left over from an
   * earlier version of this file would pass for the wrong reason.
   */
  await device.setSlot('1a', {label: 'band-a', password: A_PASSWORD});
  await device.setSlot('1b', {label: 'band-b', password: B_PASSWORD});
  log(`1a password ${A_PASSWORD.length} chars, 1b password ${B_PASSWORD.length} chars`);

  /*
   * Wait out the pending-operation window before the first measurement.
   *
   * After a FIDO2 ceremony the firmware sets pending_operation, and the main
   * loop then DISCARDS every press while it is set (OnlyKey.ino:521-525):
   *
   *     press_duration = touch_sense_loop();
   *     if (pending_operation==0xF6 || pending_operation==0xF7) setcolor(45);
   *     else if (press_duration) payload(press_duration);
   *
   * so touch_sense_loop() counts the iterations correctly, hands back a
   * perfectly good duration, and it is thrown away one line later - no
   * "Button selected", no slot, nothing on the wire. wipebuffersafter5sec()
   * re-arms it (okcore.cpp:5979) and only fadeoffafter20sec() clears it
   * (okcore.cpp:6027), so the window runs for up to twenty seconds after the
   * bridge and presence suites.
   *
   * The yellow it paints each iteration is the only outward sign, which is
   * what this waits on. See FINDING-presses-discarded-after-a-fido-ceremony.md.
   */
  /*
   * A pixel is one PACKED 24-bit colour, not three channels. Destructuring the
   * array as [r, g, b] reads three separate pixels and leaves b undefined, so
   * every comparison against it is false and the wait ends immediately - which
   * it did, while the strip was still sitting at 0x525200.
   */
  const seenPixels = [];
  const offLed = OkEmu.on("led", pixels => {
    const at = Date.now();
    for (const packed of pixels) {
      seenPixels.push({
        r: (packed >> 16) & 0xff,
        g: (packed >> 8) & 0xff,
        b: packed & 0xff,
        at,
      });
    }
    while (seenPixels.length > 600) seenPixels.shift();
  });
  try {
    const isPending = px => px.r > 64 && px.g > 64 && px.b < 64;  /* yellow */
    const deadline = Date.now() + 30000;
    let clearSince = Date.now();
    while (Date.now() < deadline) {
      await delay(250);
      const recent = seenPixels.filter(px => Date.now() - px.at < 400);
      if (recent.some(isPending)) clearSince = Date.now();
      else if (Date.now() - clearSince > 1200) break;
    }
    const last = seenPixels[seenPixels.length - 1];
    log(`led settled after ${((Date.now() - clearSince) / 1000).toFixed(1)}s clear: ${last ? `rgb(${last.r},${last.g},${last.b})` : "no led events"}`);
  } finally {
    offLed();
  }
  shared = {device, status: String(state.status)};
  return shared;
}

/** One counted press on button 1, and what the firmware said it read. */
async function bandFor(ticks, log) {
  const tap = serialTap();
  try {
    await OkEmu.holdTicks(1, ticks);
    /*
     * The hold is over when the counter drains, but payload() only runs once
     * key_off has passed 2 further iterations (okcore.cpp:2723) and the slot
     * is then typed out by a SoftTimer task. Wait for the print, not for the
     * release.
     */
    await delay(2500);
    const said = tap.take();
    return {...passwordLength(said), said};
  } finally {
    tap.off();
  }
}

module.exports = function pressBands({describe, it}) {
  describe(pressBands.name, () => {
    it('a counted tap reads the a slot', async ({log, assert}) => {
      const {status} = await provisioned(log);
      assert.ok(/UNLOCKED/i.test(status), 'the device is locked; bands are not observable');

      const {length, hits, said} = await bandFor(PRESS_TICKS.TAP, log);
      log(`${PRESS_TICKS.TAP} ticks -> Password Length = ${length} (${hits} line(s))`);
      log(`said: ${JSON.stringify(said.split(String.fromCharCode(10)).filter(Boolean).slice(-8))}`);

      assert.equal(hits, 1, 'the firmware processed no slot, or more than one');
      assert.equal(
        length, A_PASSWORD.length,
        `${PRESS_TICKS.TAP} ticks should be gen_press (slot 1), not slot 7`,
      );
    });

    it('a counted hold reads the b slot', async ({log, assert}) => {
      await provisioned(log);

      const {length, hits, said} = await bandFor(PRESS_TICKS.HOLD, log);
      log(`${PRESS_TICKS.HOLD} ticks -> Password Length = ${length} (${hits} line(s))`);
      log(`said: ${JSON.stringify(said.split(String.fromCharCode(10)).filter(Boolean).slice(-8))}`);

      assert.equal(hits, 1, 'the firmware processed no slot, or more than one');
      assert.equal(
        length, B_PASSWORD.length,
        `${PRESS_TICKS.HOLD} ticks should be gen_hold (slot 7), not slot 1`,
      );
    });

    it('back-to-back taps stay separate presses', async ({log, assert}) => {
      /*
       * The one that turns a fast finger into a gesture.
       *
       * touch_sense_loop() credits at most one pad per round and, while ANY of
       * them reads as touched, does key_off = 0 and key_on += 1
       * (okcore.cpp:2574-2628). The press is handed to payload() only once
       * key_off has passed 2 - three rounds with nothing held (okcore.cpp:2723).
       *
       * So a second counted hold armed before those rounds have happened does
       * not start a second press. It EXTENDS THE FIRST: key_on keeps climbing,
       * button_selected becomes whichever pad was seen last, and payload()
       * eventually receives one press whose duration is the sum.
       *
       * Three taps is 30 ticks, which lands in gen_hold - so a merge is not a
       * subtle mis-count here, it reads the wrong slot, and the b password's
       * different length says so outright. At seven taps the sum is 70; at
       * eight it is 80, and >= 72 on button 1 is backup().
       */
      await provisioned(log);

      const tap = serialTap();
      let said;
      try {
        for (let i = 0; i < 3; i++) {
          await OkEmu.holdTicks(1, PRESS_TICKS.TAP);
        }
        await delay(4000);
        said = tap.take();
      } finally {
        tap.off();
      }

      const lengths = (said.match(/Password Length = (\d+)/g) || [])
        .map(line => Number(line.match(/(\d+)$/)[1]));
      log(`3 x ${PRESS_TICKS.TAP} ticks -> Password Length ${JSON.stringify(lengths)}`);
      log(`said: ${JSON.stringify(said.split(String.fromCharCode(10)).filter(Boolean).slice(-12))}`);

      assert.equal(
        lengths.length, 3,
        'three taps should be three presses; one press means they merged',
      );
      assert.equal(
        lengths.filter(n => n === A_PASSWORD.length).length, 3,
        'every tap should have read slot 1',
      );
      assert.equal(
        lengths.filter(n => n === B_PASSWORD.length).length, 0,
        'a b-slot read means the taps summed into the gen_hold band',
      );
    });

    it('neither band comes anywhere near a gesture', async ({log, assert}) => {
      /*
       * The assertion that costs the most if it is missing. A hold that
       * overshoots into the gesture range does not fail loudly - it succeeds at
       * something else: backup() dumps the whole key at the keyboard, and on
       * button 3 the firmware locks and calls CPU_RESTART(), which on a phone
       * takes the app's process with it.
       *
       * Both bands are checked against the constant rather than against the
       * literal 72, so moving TAP or HOLD upward cannot quietly cross the line.
       */
      log(`TAP ${PRESS_TICKS.TAP}, HOLD ${PRESS_TICKS.HOLD}, gesture at ${PRESS_TICKS.GESTURE}`);
      assert.ok(PRESS_TICKS.TAP <= 20, 'TAP is not in the gen_press band');
      assert.ok(PRESS_TICKS.HOLD >= 21, 'HOLD is below the gen_hold band');
      assert.ok(
        PRESS_TICKS.HOLD < PRESS_TICKS.GESTURE,
        'HOLD is long enough to run a gesture instead of reading a slot',
      );

      /* And the guard that makes it unreachable rather than merely unlikely. */
      let refused = null;
      try {
        await OkEmu.setButtonTicks(1, PRESS_TICKS.GESTURE);
      } catch (e) {
        refused = e.message;
      }
      log(`refusal: ${refused}`);
      assert.ok(refused, 'a gesture-length hold was accepted without allowGesture');
      assert.ok(/gesture/i.test(refused), 'refused, but not for the stated reason');
    });

    it('the press timer counts down and reaches zero', async ({log, assert}) => {
      /*
       * The counter is what the UI shows as a press timer, and it is also how
       * holdTicks() knows a hold is over. If it never moved, a hold would look
       * instant and the timeout would be doing all the work.
       */
      await provisioned(log);

      await OkEmu.setButtonTicks(1, PRESS_TICKS.HOLD);
      const samples = [];
      const deadline = Date.now() + 10000;
      for (;;) {
        samples.push(await OkEmu.buttonTicksLeft(1));
        if (samples[samples.length - 1] === 0) break;
        if (Date.now() > deadline) break;
        await delay(50);
      }
      log(`ticks left: ${samples.join(' ')}`);

      assert.ok(samples[0] > 0, 'the hold was never armed');
      assert.equal(samples[samples.length - 1], 0, 'the hold never finished');
      assert.ok(
        samples.some((v, i) => i > 0 && v < samples[i - 1]),
        'the counter never decreased - the firmware main loop is not sampling',
      );

      await delay(2500);   /* let the slot finish typing before the next suite */
    });

    it("sweep: where the band edge actually lands", async ({log, assert}) => {
      /*
       * Diagnostic, kept because it is the only place the mapping from ticks
       * to observed behaviour is written down as a measurement rather than
       * as a reading of the firmware.
       */
      await provisioned(log);
      const seen = [];
      for (const ticks of [10, 10, 16, 21, 30]) {
        const {length, hits, said} = await bandFor(ticks, log);
        const reached = /Button selected/.test(said);
        seen.push(`${ticks}=>len:${length} hits:${hits} payload:${reached}`);
        log(seen[seen.length - 1]);
      }
      log(seen.join("  |  "));
      assert.ok(true);
    });
  });
};
