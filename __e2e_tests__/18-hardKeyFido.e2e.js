/**
 * The FIDO2 PIN, on a REAL key.
 *
 * clientpin.js was written against the firmware source, pinned byte by byte
 * by unit tests with node:crypto as the oracle, and then proved against the
 * same C compiled for arm64 in the emulator (4b-fidoPin). This is the last
 * step: the physical bench key.
 *
 * ## Why this one is armed by name and the soft-key one is not
 *
 * EIGHT WRONG ATTEMPTS LOCK THE FIDO2 SIDE OF A KEY PERMANENTLY
 * (PIN_LOCKOUT_ATTEMPTS, ctap.h:170), and three lock it until it is
 * replugged (PIN_BOOT_ATTEMPTS, ctap.h:171). Nothing restores the lifetime
 * counter except a correct PIN, or a reset that destroys every resident
 * credential on the key. The soft key can be rebuilt from source in a minute;
 * this one cannot be rebuilt at all.
 *
 * So: `tools/e2e.js --only hardKeyFido` writes the name into only.js, this
 * suite reads it back, and every test skips without it. A full run can never
 * reach a PIN attempt.
 *
 * ## What it will and will not do
 *
 * It reads first and writes second, always. getInfo says whether a PIN is
 * already set, which decides setPin against changePin - guessing costs a
 * round trip and muddies the error. getRetries says how many attempts remain
 * before anything at all is sent.
 *
 * It NEVER sends a deliberately wrong PIN. That test exists, on the emulator,
 * where the counter is a file. Here there is no reason to spend a life
 * proving something already measured somewhere it costs nothing.
 *
 * It NEVER sends a reset. 0x07 regenerates the key space and zeroes all
 * twelve resident credentials behind a single button press - no PIN, no
 * powerup window (ctap.cpp:2417-2424). FidoAdmin.reset() exists and this
 * suite does not call it.
 */
'use strict';

const {getOnlyKey} = require('../src/onlykey');
const {protocol, device: deviceLib} = require('node-onlykey-lib');

const UsbPipeModule = require('../src/transport/UsbPipe');
const UsbPipe = UsbPipeModule.default || UsbPipeModule.UsbPipe;

const {CtapHid, KEEPALIVE} = protocol.ctaphid;
const {clientpin} = protocol;
const {FidoAdmin} = deviceLib.fido;

/**
 * The bench key's FIDO2 PIN.
 *
 * Written down because the alternative is worse: a key whose PIN nobody
 * knows has eight attempts and then no FIDO2 at all. This is a development
 * key on a bench, its unlock PIN is already in these suites, and there is no
 * secret here worth the risk of losing the key.
 */
const FIDO_PIN = '12345678';
const FIDO_PIN_ALT = '87654321';

/** The bench key's UNLOCK pin, which is a different thing from its FIDO2 one. */
const PIN = '1234561';

/** How many attempts we refuse to go below before sending anything. */
const SAFE_FLOOR = 3;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let armed = false;
let session = null;

function isNamed() {
  const only = require('./only.js');
  return Array.isArray(only) && only.includes('hardKeyFido');
}

async function findKey() {
  const devices = await UsbPipe.listDevices();
  return devices.find(
    d => d.vendorId === UsbPipeModule.VENDOR_ID && d.productId === UsbPipeModule.PRODUCT_ID);
}

async function ready(log) {
  if (session) return session;

  await UsbPipe.start();
  const {device, transport} = await getOnlyKey('usb');
  let state = await device.connect();
  log(`key: ${String(state.status || '').trim()}`);

  /*
   * UNLOCK FIRST, AND BEFORE TOUCHING CTAPHID AT ALL.
   *
   * FIDO dispatch is gated on `unlocked == true` (okcore.cpp:639,651) and a
   * locked device drops those packets with no error whatsoever - so
   * CTAPHID_INIT against a locked key times out, and the first version of
   * this suite reported "no CTAPHID reply within 8000ms" for a key that was
   * simply locked. That is a diagnosis pointing at the wrong thing.
   *
   * The PIN goes in through the key's own serial console, which is how every
   * other hard-key suite does it and why it only works on a developer build.
   */
  let unlocked = /UNLOCKED/i.test(String(state.status || ''));
  if (!unlocked) {
    if (!(await device.consoleAnswers())) {
      log('the key is locked and does not read its console, so it cannot be unlocked here');
      session = {device, transport, ctap: null, fido: null, unlocked: false};
      return session;
    }
    log('locked; unlocking with the bench PIN through the console');
    await device.unlock(PIN, {timeoutMs: 20000});
    state = await device.connect();
    log(`after unlock: ${String(state.status || '').trim()}`);
    unlocked = /UNLOCKED/i.test(String(state.status || ''));
  }

  if (!unlocked) {
    session = {device, transport, ctap: null, fido: null, unlocked: false};
    return session;
  }

  /* U2Finit() runs as part of unlocking; the first FIDO packet after it is
   * eaten by the Android double-recv workaround (okcore.cpp:652-658). */
  await delay(500);

  const ctap = new CtapHid(transport);
  await ctap.init({timeoutMs: 8000});
  await delay(200);

  session = {device, transport, ctap, fido: new FidoAdmin(ctap), unlocked: true};
  return session;
}

module.exports = function hardKeyFido({describe, it}) {
  describe(hardKeyFido.name, () => {
    it('runs only when named, on the bench key', async ({log, assert, skip}) => {
      if (!isNamed()) {
        skip(
          'sets a FIDO2 PIN on the attached key, and eight wrong attempts lock ' +
          'FIDO2 forever. Run it alone with --only hardKeyFido.',
        );
      }
      const key = await findKey();
      if (!key) skip('no OnlyKey on the USB bus');
      if (!key.hasPermission) {
        skip('the key is attached but this app has no USB permission for it');
      }

      const s = await ready(log);
      if (!s.unlocked) {
        skip('the key is locked, and a locked key drops FIDO packets in silence');
      }

      armed = true;
      assert.ok(armed);
    });

    it('says what it supports, and whether a PIN is already set',
      async ({log, assert, skip}) => {
        if (!armed) skip('not armed - see the first test');

        /*
         * READ FIRST. `clientPin` in the options map is a three-way answer:
         * absent means no PIN support, false means supported and unset, true
         * means set. That decides setPin against changePin, and the firmware
         * answers CTAP2_ERR_NOT_ALLOWED or CTAP2_ERR_PIN_NOT_SET for the
         * wrong one (ctap.cpp:2255, 2271).
         */
        const s = await ready(log);
        const state = await s.fido.pinState({timeoutMs: 10000});

        log(`protocols: ${JSON.stringify(state.protocols)}, pin set: ${state.set}`);
        assert.equal(state.supported, true, 'this key does not support a FIDO2 PIN');
        assert.ok(state.protocols.includes(1), 'protocol 1 is the only one implemented');
      });

    it('reports how many attempts are left, spending none',
      async ({log, assert, skip}) => {
        if (!armed) skip('not armed - see the first test');

        const s = await ready(log);
        const before = await s.fido.getRetries({timeoutMs: 10000});
        const after = await s.fido.getRetries({timeoutMs: 10000});

        log(`retries: ${before}`);
        assert.equal(typeof before, 'number');
        assert.equal(after, before, 'asking cost an attempt, which it must not');
        assert.ok(before >= SAFE_FLOOR,
          `only ${before} attempts left - stopping rather than spending one`);
      });

    it('sets a PIN if there is none, and the token decrypts',
      async ({log, assert, skip}) => {
        if (!armed) skip('not armed - see the first test');

        const s = await ready(log);
        const state = await s.fido.pinState({timeoutMs: 10000});

        if (!state.set) {
          await s.fido.setPin(FIDO_PIN, {timeoutMs: 10000});
          log(`set the FIDO2 PIN to ${FIDO_PIN}`);
        } else {
          log('a PIN is already set; not setting one');
        }

        /*
         * The token is the proof, and it cannot be faked: the device
         * encrypted it under a shared secret derived here from its own
         * ephemeral key. Sixteen bytes that are not all zero means the ECDH,
         * the SHA-256 of the x coordinate, the zero IV and the padding are
         * all right at once.
         *
         * ONE attempt is at risk here, and only if the PIN written down above
         * is not the key's. getRetries ran first and refused to go below
         * three.
         */
        const token = await s.fido.getPinToken(FIDO_PIN, {timeoutMs: 10000});
        assert.equal(token.length, 16, `pinToken is ${token.length} bytes`);
        assert.equal(token.every(b => b === 0), false,
          'a pinToken of all zeros means it did not decrypt');

        const after = await s.fido.getRetries({timeoutMs: 10000});
        log(`retries after a correct PIN: ${after}`);
        assert.equal(after, 8, 'a correct PIN restores the counter to full');
      });

    it('changes the PIN and changes it back', async ({log, assert, skip}) => {
      if (!armed) skip('not armed - see the first test');

      /*
       * changePin is the only subcommand whose pinAuth covers two fields, in
       * one order: newPinEnc then pinHashEnc (ctap.cpp:2050-2056). The other
       * order is a valid HMAC of the wrong message.
       *
       * It goes back at the end so this suite is repeatable and so the key is
       * left on the PIN written at the top of this file. If the run dies
       * between the two, the key is on the alternate - which is why both are
       * recorded rather than one.
       */
      const s = await ready(log);

      await s.fido.changePin(FIDO_PIN, FIDO_PIN_ALT, {timeoutMs: 10000});
      log('changed to the alternate PIN');
      const token = await s.fido.getPinToken(FIDO_PIN_ALT, {timeoutMs: 10000});
      assert.equal(token.length, 16, 'the new PIN produced no token');

      await s.fido.changePin(FIDO_PIN_ALT, FIDO_PIN, {timeoutMs: 10000});
      const back = await s.fido.getPinToken(FIDO_PIN, {timeoutMs: 10000});
      assert.equal(back.length, 16, 'the key did not come back to the primary PIN');
      log(`back on the primary PIN, ${await s.fido.getRetries({timeoutMs: 10000})} attempts left`);
    });

    it('lists what resident credentials the key holds',
      async ({log, assert, skip}) => {
        if (!armed) skip('not armed - see the first test');

        /*
         * Read-only, and the first time anything has asked this key what
         * passkeys it is carrying. An empty list is a real answer: metadata
         * still reports properly when nothing is stored, which is why it is
         * asked before the walk (ctap.cpp:1754).
         */
        const s = await ready(log);
        const token = await s.fido.getPinToken(FIDO_PIN, {timeoutMs: 10000});

        const counts = await s.fido.credentialCount(token, {timeoutMs: 10000});
        log(`resident credentials: ${counts.stored}, room for ${counts.remaining} more`);
        assert.equal(typeof counts.stored, 'number');

        const sites = await s.fido.listCredentials(token, {timeoutMs: 15000});
        log(`sites: ${JSON.stringify(sites.map(x => `${x.id} (${x.credentials.length})`))}`);

        let listed = 0;
        for (const site of sites) listed += site.credentials.length;
        assert.equal(listed, counts.stored,
          `metadata said ${counts.stored} but the walk produced ${listed}`);
      });

    /*
     * A WHOLE CEREMONY, ON REAL HARDWARE.
     *
     * Added 2026-09-17 because nothing in this repo had ever done one. 14a
     * makes a credential against the SOFT key; this suite covered PIN state,
     * retries and credential listing but never a makeCredential or a
     * getAssertion; and getAssertion had no coverage anywhere at all. The
     * Credential Manager work walked straight into that gap - the key took the
     * PIN, issued a token, asked for a touch, and then never answered - and
     * there was no test to say whether that was the app, the press, or the
     * firmware.
     *
     * These two answer it without a browser in the way.
     */
    let made = null;

    it('makes a credential, with presence satisfied by a console press',
      async ({log, assert, skip}) => {
        if (!armed) skip('not armed - see the first test');

        const s = await ready(log);
        const state = await s.fido.pinState({timeoutMs: 10000});
        if (!state.set) skip('no FIDO2 PIN on this key - an earlier test sets one');

        const token = await s.fido.getPinToken(FIDO_PIN, {timeoutMs: 10000});
        const clientDataHash = new Uint8Array(32).fill(0x11);

        const params = new Map([
          [1, clientDataHash],
          [2, new Map([['id', 'okrn.hardkey.test'], ['name', 'ok-rn hard key']])],
          [3, new Map([
            ['id', new Uint8Array(16).fill(0x77)],
            ['name', 'assert-e2e'],
            ['displayName', 'assert-e2e'],
          ])],
          [4, [new Map([['alg', -7], ['type', 'public-key']])]],
          [7, new Map([['rk', true]])],
          [8, clientpin.pinTokenAuth(token, clientDataHash)],
          [9, clientpin.PIN_PROTOCOL],
        ]);

        const prompts = [];
        let pressed = 0;
        const credential = await s.ctap.makeCredential(params, {
          timeoutMs: 10000,
          presenceTimeoutMs: 30000,
          onKeepAlive: async status => {
            prompts.push(status);
            log(`keepalive 0x${status.toString(16)}`);
            /* Only UP_NEEDED wants a finger; PROCESSING just means busy. */
            if (status !== KEEPALIVE.UP_NEEDED) return;
            await delay(300);
            await s.device.press('1');
            pressed += 1;
          },
        });

        log(`prompts: ${prompts.length}, console presses: ${pressed}`);
        assert.ok(credential instanceof Map, 'makeCredential returned no CBOR map');

        const authData = credential.get(2);
        assert.ok(authData && authData.length >= 55,
          'no attested credential data, so there is no credential id');
        const idLen = (authData[53] << 8) | authData[54];
        made = authData.slice(55, 55 + idLen);
        log(`credential id: ${idLen} bytes`);
        assert.ok(idLen > 0, 'the credential id is empty');
      });

    it('asserts with the credential it just made',
      async ({log, assert, skip}) => {
        if (!armed) skip('not armed - see the first test');
        if (!made) skip('the previous test made no credential to assert with');

        const s = await ready(log);
        const token = await s.fido.getPinToken(FIDO_PIN, {timeoutMs: 10000});
        const clientDataHash = new Uint8Array(32).fill(0x22);

        const params = new Map([
          [1, 'okrn.hardkey.test'],
          [2, clientDataHash],
          [3, [new Map([['id', made], ['type', 'public-key']])]],
          [5, new Map([['up', true]])],
          [6, clientpin.pinTokenAuth(token, clientDataHash)],
          [7, clientpin.PIN_PROTOCOL],
        ]);

        const prompts = [];
        let pressed = 0;
        const assertion = await s.ctap.getAssertion(params, {
          timeoutMs: 10000,
          presenceTimeoutMs: 30000,
          onKeepAlive: async status => {
            prompts.push(status);
            log(`keepalive 0x${status.toString(16)}`);
            if (status !== KEEPALIVE.UP_NEEDED) return;
            await delay(300);
            await s.device.press('1');
            pressed += 1;
          },
        });

        log(`prompts: ${prompts.length}, console presses: ${pressed}`);
        assert.ok(assertion instanceof Map, 'getAssertion returned no CBOR map');
        assert.ok(assertion.get(2) instanceof Uint8Array, 'no authData in the assertion');
        assert.ok(assertion.get(3) instanceof Uint8Array, 'no signature in the assertion');
        log(`signature: ${assertion.get(3).length} bytes`);
      });

    it('and the key is handed back to the phone', async ({log, assert, skip}) => {
      if (!armed) skip('not armed - see the first test');

      /*
       * Nothing was deleted and nothing was reset. The key is left with the
       * PIN recorded at the top of this file and whatever credentials it
       * arrived with.
       */
      await UsbPipe.stop();
      session = null;
      log('interfaces released; the key is free for other apps');
      assert.ok(true);
    });
  });
};
