/**
 * WIPE A HARD KEY AND SET IT UP AGAIN - the bench operation, as a suite.
 *
 * This is how the hard-key path stops being read-only: a key with a KNOWN PIN
 * can be unlocked, and everything after unlock (slots, derive, backup) can be
 * measured against real hardware. It runs the firmware's own paths, in the
 * firmware's own order, through the debug console:
 *
 *     0C   wipe userspace - PIN, profiles, slots; NOT the firmware - and restart
 *     (set PIN through the OKSETPIN bracket, digits pressed by the console)
 *     8    restart, so `initialized` is recomputed from flash
 *     (unlock with the PIN, the same way)
 *
 * ## It runs ONLY when named, and that is enforced here, not by convention
 *
 * A full run must never wipe a key. `tools/e2e.js --only hardKeyProvision`
 * writes the name into only.js; this suite reads only.js back and SKIPS unless
 * it is there. The guard is in the suite because the suite is what is
 * dangerous; a note in a README is not a guard.
 *
 * ## Needs a developer build
 *
 * Every step goes through the console: the wipe and restart commands and the
 * PIN digits alike. A production key does not read its console, so the suite
 * skips with the reason rather than sending commands into silence.
 *
 * ## Re-enumeration
 *
 * A wipe and a restart both reboot the key, which drops off the USB bus and
 * comes back as a new device. The pipe reports `disconnected`; the suite
 * closes it, waits for the key to reappear in the device list WITH permission,
 * and opens it again. Android usually keeps the grant across a re-plug of the
 * same device; when it does not, the prompt has to be accepted on the phone,
 * and the suite says so while it waits.
 */
'use strict';

const UsbPipeModule = require('../src/transport/UsbPipe');
const UsbPipe = UsbPipeModule.default || UsbPipeModule.UsbPipe;
const {getOnlyKey, resetOnlyKey} = require('../src/onlykey');

/** The PIN every other suite uses on the soft key. Digits are buttons, 1-6. */
const PIN = '1234561';

const delay = ms => new Promise(r => setTimeout(r, ms));

/*
 * ARMED by the first test, checked by every later one. A skip() ends ONE
 * test; the rest of the suite still runs, and in a full run the wipe test
 * then failed with "No open transport" against a pipe the first test never
 * opened - three red lines for a suite that was correctly staying out of
 * the way. So the later tests ask whether the first one armed them.
 */
let armed = false;

function isNamed() {
  const only = require('./only.js');
  return Array.isArray(only) && only.includes('hardKeyProvision');
}

async function findKey() {
  const devices = await UsbPipe.listDevices();
  return devices.find(
    d => d.vendorId === UsbPipeModule.VENDOR_ID && d.productId === UsbPipeModule.PRODUCT_ID);
}

/**
 * Wait for the key to leave the bus and come back, then open it.
 *
 * Leaving first: the command that reboots it returns before the reboot, so
 * looking for the key straight away finds the OLD enumeration and opens a
 * handle that dies a moment later.
 */
async function reopenAfterReboot({log, timeoutMs = 30000}) {
  const started = Date.now();

  try { await UsbPipe.stop(); } catch (_) { /* it may already be gone */ }
  await resetOnlyKey('usb');

  let gone = false;
  let key = null;
  let warnedPermission = false;
  for (;;) {
    key = await findKey();
    if (!key) gone = true;
    if (gone && key && key.hasPermission) break;
    if (gone && key && !key.hasPermission && !warnedPermission) {
      warnedPermission = true;
      log('the key is back but this app has no permission yet - accept the USB prompt on the phone');
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(gone
        ? 'the key did not come back with permission within the wait'
        : 'the key never left the bus - the command did not reboot it');
    }
    await delay(500);
  }
  /* The firmware needs a moment after enumeration before it answers. */
  await delay(1500);
  const result = await UsbPipe.start();
  log(`reopened after ${((Date.now() - started) / 1000).toFixed(1)}s, ${result.interfaces.length} interfaces`);
}

module.exports = function hardKeyProvision({describe, it}) {
  describe(hardKeyProvision.name, () => {
    it('runs only when named, on a developer key', async ({log, assert, skip}) => {
      if (!isNamed()) {
        skip('destructive: wipes the attached key. Run it alone with --only hardKeyProvision.');
      }
      const key = await findKey();
      if (!key) skip('no OnlyKey on the USB bus');
      if (!key.hasPermission) skip('the key is attached but this app has no USB permission for it');

      await UsbPipe.start();
      const {device} = await getOnlyKey('usb');
      const state = await device.connect();
      log(`before: ${JSON.stringify(String(state.status || '').trim())}`);

      const answers = await device.consoleAnswers();
      if (!answers) {
        skip('this key does not read its console, so it cannot be wiped or provisioned from here');
      }
      armed = true;
      assert.ok(armed);
    });

    it('wipes userspace and the key reboots', async ({log, assert, skip}) => {
      if (!armed) skip('not armed - see the first test');
      const {device} = await getOnlyKey('usb');
      device.console.clear();
      await device.wipeUserspace();
      /*
       * The firmware announces the path it is taking before it takes it. Seen
       * or not, the proof is the reboot below - the console can drop lines
       * under load - so this is logged, not asserted.
       */
      const heard = await device.console.waitFor(/0C. confirmation received/, {timeoutMs: 2000})
        .then(() => true).catch(() => false);
      log(`firmware acknowledged the wipe: ${heard}`);

      await reopenAfterReboot({log});
      const {device: fresh} = await getOnlyKey('usb');
      const state = await fresh.connect();
      const status = String(state.status || '').trim();
      log(`after wipe: ${JSON.stringify(status)}`);
      assert.ok(/UNINITIALIZED/i.test(status), `expected UNINITIALIZED, got ${status}`);
    });

    it('sets a PIN through the firmware bracket, and restarts to make it real', async ({log, assert, skip}) => {
      if (!armed) skip('not armed - see the first test');
      const {device} = await getOnlyKey('usb');
      /*
       * No enterDigits: the default presses through the console, which this
       * suite has already established works on this key. The bracket itself -
       * OKSETPIN, the prompts, the confirmation - is the library's, and is the
       * same code the soft key was provisioned with.
       */
      await device.setPin(PIN);
      log('PIN set; the device keeps reporting UNINITIALIZED until it boots again');

      await device.restart();
      await reopenAfterReboot({log});

      const {device: fresh} = await getOnlyKey('usb');
      const state = await fresh.connect();
      const status = String(state.status || '').trim();
      log(`after restart: ${JSON.stringify(status)}`);
      assert.ok(/^INITIALIZED/i.test(status), `expected INITIALIZED (locked), got ${status}`);
    });

    it('UNLOCKS with that PIN - the first time a hard key has', async ({log, assert, skip}) => {
      if (!armed) skip('not armed - see the first test');
      const {device} = await getOnlyKey('usb');
      /*
       * unlock() resolves with the status text it SAW - the device's own
       * UNLOCKED broadcast - and rejects on a timeout. The first version of
       * this read device.status instead, which is the last connect() reply
       * and still said INITIALIZED after a successful unlock.
       */
      const seen = String(await device.unlock(PIN)).trim();
      log(`after unlock: ${JSON.stringify(seen)}`);
      assert.ok(/UNLOCKED/i.test(seen), `expected UNLOCKED, got ${seen}`);
      log(`identity: ${JSON.stringify(device.identity)}`);
      log(`capabilities: ${JSON.stringify(device.capabilities)}`);
    });

    it('and the key is handed back to the phone', async ({log, assert, skip}) => {
      if (!armed) skip('not armed - see the first test');
      await resetOnlyKey('usb');
      await UsbPipe.stop();
      log('interfaces released');
      assert.equal(UsbPipe.isRunning(), false);
    });
  });
};
