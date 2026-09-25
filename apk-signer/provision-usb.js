#!/usr/bin/env node
/*
 * Put the signing key into an OnlyKey on USB: a physical key, or the
 * Raspberry Pi presenting the emulator as a USB device.
 *
 *   node provision-usb.js --presser pi       press.js on the Pi presses the buttons
 *   node provision-usb.js --presser human    you press them; each step is printed
 *
 * The same steps as provision.js, which does this to the emulated key - set a
 * PIN if the key has none, unlock, config mode, stored-challenge mode 1, the
 * debug keystore's key into RSA slot 2, restart, and read the modulus back -
 * but with NO debug console. provision.js drives state through the kit's
 * console; a key on USB is driven the non-debug way, by its buttons, which is
 * the only way a production key can be. So every press is a `presser` call:
 * press.js over ssh while the Pi stands in for a key, a person otherwise.
 *
 * The key loaded is debug.keystore's, as for the emulated key, so the
 * certificate apksigner embeds stays fac61745... Refused if the certificate
 * this produces differs from .local/signer.crt.pem.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const okdevice = require('node-onlykey-lib/device');
const {openUsb, requireKit, LOCAL} = require('./session');
const {extractKey} = require('./keystore');

const SLOT = okdevice.keys.ROLE_SLOT.SIGNATURE;
const CERT = path.join(LOCAL, 'signer.crt.pem');

const say = (...a) => console.error('[provision-usb]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Who presses: press.js on the Pi, or a person - see presser.js. */
const {presserFrom} = require('./presser');

/* ---- the steps ------------------------------------------------------- */

async function connected() {
  /* A restart drops the key off the bus for a moment; keep trying briefly. */
  for (let i = 1; ; i++) {
    try {
      const s = await openUsb();
      const r = await s.device.connect();
      return {s, status: String(r.status).trim()};
    } catch (e) {
      if (i >= 10) throw e;
      await sleep(1500);
    }
  }
}

async function main() {
  const which = (process.argv[process.argv.indexOf('--presser') + 1]) || '';
  const presser = presserFrom(which);
  const {PINS} = requireKit();
  const pin = PINS.primary;
  const enterDigits = (digits) => presser.press(String(digits).split(''));
  const human = presser.name === 'you';

  /*
   * A PERSON'S PIN NEVER PASSES THROUGH THIS PROGRAM. With press.js on the
   * Pi the emulated key uses the kit's PIN, and the library drives the
   * unlock. With a person, they enter their own PIN on the key's buttons and
   * this only watches for the key to say UNLOCKED - it neither knows the PIN
   * nor prints one.
   */
  async function unlockKey(session) {
    if (!human) {
      await session.device.unlock(pin, {enterDigits, timeoutMs: 60000});
      return;
    }
    await presser.press(['your PIN']);
    for (let i = 0; i < 120; i++) {
      const now = String((await session.device.connect()).status).trim();
      if (/^UNLOCKED/i.test(now)) return;
      await sleep(1000);
    }
    throw new Error('the key did not report UNLOCKED within two minutes');
  }

  say('reading debug.keystore');
  const key = extractKey();
  /*
   * By fingerprint, not text: the stored PEM has CRLF endings and openssl's
   * "Bag Attributes" lines, so the same certificate rarely matches as a string.
   */
  if (fs.existsSync(CERT)) {
    const fp = (pem) => new crypto.X509Certificate(pem).fingerprint256;
    if (fp(fs.readFileSync(CERT)) !== fp(key.cert)) {
      throw new Error(`${CERT} is not debug.keystore's certificate - refusing to provision a different key`);
    }
  }

  let {s, status} = await connected();
  say(`key says ${status}; buttons pressed by ${presser.name}`);
  /*
   * --verify: the key has been loaded, replugged and unlocked; just read
   * slot 2 back. --from-config-mode: the owner put the key into config mode
   * themselves (hold button 6, PIN again) - load it and stop; the replug that
   * ends config mode and the unlock after it are theirs.
   */
  if (process.argv.includes('--verify')) {
    try {
      if (!/^UNLOCKED/i.test(status)) await unlockKey(s);
      await checkModulus(s);
    } finally {
      await s.stop();
    }
    return;
  }
  const fromConfig = process.argv.includes('--from-config-mode');
  if (fromConfig && !/^UNLOCKED/i.test(status)) {
    await s.stop();
    throw new Error(`--from-config-mode needs the key unlocked in config mode, but it says ${status}`);
  }

  try {
    if (fromConfig) {
      say('the key is in config mode already - skipping PIN and config mode');
    } else {
    if (/^UNINITIALIZED/i.test(status) && human) {
      throw new Error('this key has no PIN - set one in the app first; a PIN of yours is never set from here');
    }
    if (/^UNINITIALIZED/i.test(status)) {
      say('no PIN yet - setting one');
      await s.device.setPin(pin, {enterDigits, timeoutMs: 60000});
      /*
       * The PIN is saved, but the key keeps reporting UNINITIALIZED until it
       * boots again (ok-rn __e2e_tests__/0-provision.e2e.js), and nothing
       * unlocks before then - measured here: "Successfully set PIN", then
       * UNINITIALIZED, then an unlock that waited forever.
       */
      await s.stop();
      say('restarting so the key boots as initialized');
      await presser.restart();
      ({s, status} = await connected());
      say(`key says ${status}`);
    }
    say('unlocking');
    await unlockKey(s);

    say('entering config mode (it relocks the key)');
    await s.device.enterConfigMode({hold: (b, t) => presser.hold(b, t)});
    await unlockKey(s);
    }

    say('stored challenge mode = 1 (one press per signature)');
    await s.device.setPreference('storedChallengeMode', 1);

    say(`loading the key into RSA slot ${SLOT}`);
    const material = okdevice.keys.prepareKey(
      {kind: 'rsa', p: key.p, q: key.q},
      {slot: SLOT, signature: true},
    );
    await s.device.loadKey(SLOT, {type: material.type, key: material.key});
  } finally {
    await s.stop();
  }

  if (fromConfig) {
    say('loaded. Now unplug the key and plug it back in (that ends config mode),');
    say('unlock it with your PIN, and run: node provision-usb.js --presser human --verify');
    return;
  }

  say('restarting to leave config mode');
  await presser.restart();
  ({s, status} = await connected());
  try {
    say(`key says ${status}; unlocking`);
    await unlockKey(s);
    await checkModulus(s);
  } finally {
    await s.stop();
  }

  async function checkModulus(session) {
    const pub = await session.device.getPublicKey(SLOT, {bytes: 256, keyType: 0});
    const got = Buffer.from(pub.bytes || pub);
    if (!got.equals(key.n)) {
      throw new Error('the modulus read back does not match debug.keystore - the key did not land');
    }
    say('modulus matches debug.keystore - provisioned');
  }
}

main().catch((err) => {
  console.error(`[provision-usb] ${err && (err.stack || err.message)}`);
  process.exit(1);
});
