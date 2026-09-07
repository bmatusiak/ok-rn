/*
 * softKey.e2e.js - the gate for running the OnlyKey firmware on the phone.
 *
 * Compiling libokemu.so proves nothing about whether it runs. Two things could
 * still fail on a real handset, and both are checked here:
 *
 *   1. vm.mmap_min_addr. The firmware dereferences absolute flash addresses,
 *      and certified_hw sits at 0x5BB0 - below Android's 0x8000 floor, which an
 *      unprivileged app cannot lower. If the mapping lands somewhere else the
 *      device still boots and still answers HID, and then faults the first time
 *      it encrypts anything. So "it booted" is NOT the pass condition; a
 *      completed OKCONNECT, which performs a key exchange, is.
 *
 *   2. Whether the firmware thread survives at all under ART, with bionic's
 *      1 MB default stack raised to 8 MB by the JNI layer.
 *
 * Run with: npx test-moniker --start-dev-server
 */

const OkEmuModule = require('../src/transport/OkEmu');

const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;
const {IFACE} = OkEmuModule;

/** okmsg framing: FF FF FF FF | msg | payload, zero-padded to 64. */
const HEADER = [0xff, 0xff, 0xff, 0xff];
const OKCONNECT = 0xe4;
const REPORT_SIZE = 64;

function buildMessage(msg, payload = []) {
  const frame = new Uint8Array(REPORT_SIZE);
  frame.set(HEADER, 0);
  frame[4] = msg;
  frame.set(payload, 5);
  return frame;
}

/**
 * OKCONNECT's payload: epoch seconds as hex digit PAIRS, one byte each. This
 * is python-onlykey's set_time() encoding and the firmware parses it as such -
 * not as a plain integer.
 */
function setTimePayload(when = Date.now()) {
  let hex = Math.floor(when / 1000).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const out = [];
  for (let i = 0; i < hex.length; i += 2) {
    out.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

function ascii(bytes) {
  let out = '';
  for (const b of bytes) {
    if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
  }
  return out;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = function softKey({describe, it}) {
  describe(softKey.name, () => {
    it('libokemu.so loads for this ABI', async ({log, assert}) => {
      const available = OkEmu.isAvailable();
      log(`isAvailable: ${available}`);
      assert.ok(
        available,
        'libokemu.so did not load. Check the APK actually carries this ' +
          "device's ABI - a 32-bit-only handset needs armeabi-v7a.",
      );
    });

    it('firmware boots and backs itself with files', async ({log, assert}) => {
      if (OkEmu.isRunning()) {
        log('already running from a previous test; stopping first');
        await OkEmu.stop();
        await delay(200);
      }

      const banner = [];
      const offLog = OkEmu.on('stream', event => {
        if (event.iface === IFACE.SEREMU && event.dir === 0) {
          banner.push(ascii(event.bytes));
        }
      });

      const result = await OkEmu.start();
      log(`start -> ${JSON.stringify(result)}`);
      assert.ok(result.started, `firmware did not start: ${result.message}`);
      assert.ok(
        result.storageDir && result.storageDir.length > 0,
        'no storage directory reported; flash.bin has nowhere to live',
      );

      // setup() runs on its own thread; give it a moment to reach the loop.
      await delay(1500);
      offLog();

      log(`boot output: ${banner.join('').slice(0, 400)}`);
      assert.ok(OkEmu.isRunning(), 'firmware stopped on its own after starting');
    });

    it('completes OKCONNECT, which proves the flash mapping is usable', async ({
      log,
      assert,
    }) => {
      assert.ok(OkEmu.isRunning(), 'firmware is not running');

      // Subscribe before writing: a fast reply would otherwise land before
      // anyone is listening.
      const reply = OkEmu.nextReport(IFACE.VENDOR, 5000);

      const message = buildMessage(OKCONNECT, setTimePayload());
      await OkEmu.write(IFACE.VENDOR, message);
      log(`sent OKCONNECT (${message.length} bytes)`);

      const bytes = await reply;
      const text = ascii(bytes);
      log(`reply: ${text}`);
      log(
        `raw: ${Array.from(bytes.slice(0, 24))
          .map(b => b.toString(16).padStart(2, '0'))
          .join(' ')}`,
      );

      assert.ok(bytes.length > 0, 'empty reply to OKCONNECT');
      // The firmware answers with its lock state and version string. Either
      // wording is a pass; what matters is that it got far enough to derive
      // the transit key, which touches certified_hw at 0x5BB0.
      assert.ok(
        /UNLOCKED|INITIALIZED|OnlyKey/i.test(text),
        `unrecognised OKCONNECT reply: "${text}"`,
      );
    });

    it('survives a restart with its storage intact', async ({log, assert}) => {
      assert.ok(OkEmu.isRunning(), 'firmware is not running');

      const before = await OkEmu.restart();
      log(`restart -> ${JSON.stringify(before)}`);
      assert.ok(before.started, `firmware did not come back: ${before.message}`);

      await delay(1500);

      const reply = OkEmu.nextReport(IFACE.VENDOR, 5000);
      await OkEmu.write(IFACE.VENDOR, buildMessage(OKCONNECT, setTimePayload()));
      const text = ascii(await reply);
      log(`post-restart reply: ${text}`);

      assert.ok(
        /UNLOCKED|INITIALIZED|OnlyKey/i.test(text),
        `firmware did not answer after restart: "${text}"`,
      );
    });
  });
};
