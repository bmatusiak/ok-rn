/**
 * Resident credentials - passkeys - made, listed, deleted, and then all of
 * them erased.
 *
 * The library could count, list and delete them and nothing had ever done it
 * against a device. This makes one first, because a listing that returns
 * nothing proves only that nothing is there.
 *
 * ## Why the reset is safe to run HERE and nowhere near the bench key
 *
 * `ctap_reset()` (ctap.cpp:2758) regenerates `STATE.key_space` and reloads
 * the master secret from it, which is what FIDO2 credentials derive from. It
 * does NOT touch slot 128, and slot 128 is what the OnlyKey derive path reads
 * (`okcore_flashget_ECC(RESERVED_KEY_WEB_DERIVATION)`, okcrypto.cpp:604). So
 * every derived X-Wing identity and every vault blob sealed under one survives
 * this, and the derive suites that run before it are unaffected.
 *
 * Checked rather than assumed, because the alternative failure is silent: a
 * reset that changed the derive key would leave every stored vault record
 * sealed to a key that no longer exists, and nothing would say so until
 * somebody tried to open one.
 *
 * ## Where it sits in the order
 *
 * After everything that derives, because of the paragraph above, and BEFORE
 * 14b-pqcSlots, which ends in config mode - config mode silences CTAPHID
 * entirely and nothing here would answer.
 *
 * The reset takes the FIDO2 PIN with it, and the last test sets the same one
 * again - both to leave the key where the other suites expect it, and because
 * asking whether anything is stored REQUIRES a real pinToken even when no PIN
 * is set (see that test).
 */
'use strict';

const {getOnlyKey} = require('../src/onlykey');
const {pressDigits} = require('./helpers/pressDigits');
const {protocol, device: deviceLib} = require('node-onlykey-lib');

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;

const {CtapHid, CTAP2_CMD} = protocol.ctaphid;
const {clientpin, credmgmt} = protocol;
const {FidoAdmin, RESET_CONFIRMATION} = deviceLib.fido;

const PIN = '1234561';
/** Set by 4b-fidoPin, which runs earlier in every full run. */
/* The SOFT key's FIDO2 PIN, matching onlykey-testing and 4b-fidoPin. The HARD
 * key keeps 12345678 - see 18-hardKeyFido, which drives a physical device. */
const FIDO_PIN = '9137';

const RP_ID = 'passkeys.e2e';
const USER_NAME = 'somebody';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const fill = (n, b) => new Uint8Array(n).fill(b);

const {needsCtaphid} = require('./helpers/needsCtaphid');

let shared = null;

async function ready(log, skip) {
  if (shared) return shared;
  if (!OkEmu.isRunning()) await OkEmu.start();

  const {device, transport} = await getOnlyKey();
  let state = await device.connect();
  log(`device: ${String(state.status).trim()}`);

  if (!/UNLOCKED/i.test(String(state.status))) {
    await device.unlock(PIN, {timeoutMs: 20000, enterDigits: pressDigits({log})});
    state = await device.connect();
    log(`unlocked: ${String(state.status).trim()}`);
  }

  /*
   * BEFORE the CtapHid init, which is the 8000ms this would otherwise spend
   * learning nothing: config mode answers the vendor interface and goes silent
   * here, so every test in this suite would time out in turn.
   */
  needsCtaphid(skip, device);

  /* U2Finit() runs during unlock and the first FIDO packet after it is eaten
   * by the Android double-recv workaround (okcore.cpp:652-658). */
  await delay(500);

  const ctap = new CtapHid(transport);
  await ctap.init({timeoutMs: 8000});
  await delay(200);

  shared = {device, transport, ctap, fido: new FidoAdmin(ctap), token: null};
  return shared;
}

/**
 * A makeCredential that asks the key to KEEP the credential.
 *
 * `rk: true` in the options is what makes it resident - without it the
 * credential is wrapped into the id the site stores and the key keeps
 * nothing, which is the default and is why a key can serve unlimited sites
 * while holding only twelve passkeys.
 *
 * pinUvAuthParam is required once a PIN is set: CTAP2 refuses a
 * makeCredential without one (`CTAP2_ERR_PIN_REQUIRED`, ctap.cpp:937), and it
 * is HMAC-SHA256(pinToken, clientDataHash) truncated to 16.
 */
function makeCredentialParams(pinToken, clientDataHash) {
  return new Map([
    [1, clientDataHash],
    [2, new Map([['id', RP_ID], ['name', 'Passkey e2e']])],
    [3, new Map([
      ['id', fill(16, 0x5a)],
      ['name', USER_NAME],
      ['displayName', USER_NAME],
    ])],
    [4, [new Map([['alg', -7], ['type', 'public-key']])]],
    [7, new Map([['rk', true]])],
    [8, clientpin.pinTokenAuth(pinToken, clientDataHash)],
    [9, clientpin.PIN_PROTOCOL],
  ]);
}

module.exports = function passkeys({describe, it}) {
  describe(passkeys.name, () => {
    it('gets a pinToken, which everything else here needs',
      async ({log, assert, skip}) => {
        const s = await ready(log, skip);
        const state = await s.fido.pinState({timeoutMs: 10000});
        log(`pin set: ${state.set}`);
        if (!state.set) {
          skip('no FIDO2 PIN on this key - 4b-fidoPin sets one, run the full suite');
        }

        const before = await s.fido.getRetries({timeoutMs: 10000});
        log(`retries: ${before}`);

        s.token = await s.fido.getPinToken(FIDO_PIN, {timeoutMs: 10000});
        assert.equal(s.token.length, 16);
        assert.equal(s.token.every(b => b === 0), false, 'the token did not decrypt');
      });

    it('starts from a KNOWN count, whatever the key was carrying',
      async ({log, assert, skip}) => {
        /*
         * Asked before anything is made, because the assertions below are
         * about a DIFFERENCE. A key that already held passkeys from some
         * browser would otherwise make "there is one" either trivially true
         * or wrong, depending on luck.
         */
        const s = await ready(log, skip);
        if (!s.token) skip('no pinToken');

        const counts = await s.fido.credentialCount(s.token, {timeoutMs: 10000});
        log(`before: ${counts.stored} stored, room for ${counts.remaining}`);
        s.before = counts.stored;
        assert.equal(typeof counts.stored, 'number');
      });

    it('MAKES a resident credential, which needs a finger',
      async ({log, assert, skip}) => {
        const s = await ready(log, skip);
        if (!s.token) skip('no pinToken');

        const clientDataHash = fill(32, 0x24);
        const pressed = [];
        const response = await s.ctap.makeCredential(
          makeCredentialParams(s.token, clientDataHash),
          {
            timeoutMs: 20000,
            presenceTimeoutMs: 25000,
            onKeepAlive: async status => {
              /* 0x02 is UP_NEEDED: the key is waiting for a touch. */
              if (status !== 0x02 || pressed.length) return;
              pressed.push(1);
              await delay(300);
              await OkEmu.pressQueue('1');
            },
          },
        );

        log(`made a credential for ${RP_ID}, presses: ${pressed.length}`);
        assert.ok(response instanceof Map, 'makeCredential returned no map');

        const counts = await s.fido.credentialCount(s.token, {timeoutMs: 10000});
        log(`after: ${counts.stored} stored`);
        assert.equal(counts.stored, s.before + 1, 'the key did not keep it');
        s.made = true;
      });

    it('LISTS it, under the site that owns it', async ({log, assert, skip}) => {
      const s = await ready(log, skip);
      if (!s.made) skip('nothing was made');

      const sites = await s.fido.listCredentials(s.token, {timeoutMs: 20000});
      log(`sites: ${JSON.stringify(sites.map(x => `${x.id} (${x.credentials.length})`))}`);

      const site = sites.find(x => x.id === RP_ID);
      assert.ok(site, `${RP_ID} is not in the listing`);

      const names = site.credentials.map(c => credmgmt.describeUser(c.user));
      log(`users at ${RP_ID}: ${JSON.stringify(names)}`);
      assert.ok(names.includes(USER_NAME), `${USER_NAME} is not among them`);

      /* The count the walk produced must agree with what metadata said. */
      const counts = await s.fido.credentialCount(s.token, {timeoutMs: 10000});
      let listed = 0;
      for (const x of sites) listed += x.credentials.length;
      assert.equal(listed, counts.stored,
        `metadata said ${counts.stored}, the walk produced ${listed}`);
    });

    it('DELETES it, by the descriptor the listing returned',
      async ({log, assert, skip}) => {
        /*
         * By the descriptor and never by an index: the enumeration cursors
         * are firmware statics shared by every channel (ctap.cpp:1736-1741),
         * so a remembered position can name a different credential by the
         * time it is used. The listing is taken immediately before.
         */
        const s = await ready(log, skip);
        if (!s.made) skip('nothing was made');

        const sites = await s.fido.listCredentials(s.token, {timeoutMs: 20000});
        const site = sites.find(x => x.id === RP_ID);
        const mine = site.credentials.find(
          c => credmgmt.describeUser(c.user) === USER_NAME);
        assert.ok(mine, 'could not find the credential just made');

        await s.fido.deleteCredential(s.token, mine.credentialId, {timeoutMs: 10000});
        log('deleted');

        const counts = await s.fido.credentialCount(s.token, {timeoutMs: 10000});
        assert.equal(counts.stored, s.before, 'the count did not come back down');

        const after = await s.fido.listCredentials(s.token, {timeoutMs: 20000});
        const still = after.find(x => x.id === RP_ID);
        assert.equal(still, undefined, `${RP_ID} is still in the listing`);
        s.deleted = true;
      });

    it('refuses a reset without the exact words', async ({log, assert, skip}) => {
      const s = await ready(log, skip);
      if (!s.token) skip('no pinToken');

      for (const attempt of [true, 'yes', RESET_CONFIRMATION.toLowerCase(), '']) {
        let refused = false;
        try {
          await s.fido.reset(attempt, {timeoutMs: 5000});
        } catch (e) {
          refused = /exact confirmation/.test(e.message);
        }
        assert.ok(refused, `reset accepted ${JSON.stringify(attempt)}`);
      }
      log('only the exact words get through');
    });

    it('RESETS, and the key forgets its passkeys and its PIN',
      async ({log, assert, skip}) => {
        /*
         * LAST in this file, because it destroys what every test above made.
         * Safe on the soft key for the reason in this file's header: the
         * derive path reads slot 128, which a reset does not touch.
         *
         * It takes ONE button press and nothing else - no PIN, no powerup
         * window (ctap.cpp:2417-2424). The typed word is the only other thing
         * between a caller and this.
         */
        const s = await ready(log, skip);
        if (!s.token) skip('no pinToken');

        const pressed = [];
        await s.fido.reset(RESET_CONFIRMATION, {
          timeoutMs: 30000,
          presenceTimeoutMs: 25000,
          onKeepAlive: async status => {
            if (status !== 0x02 || pressed.length) return;
            pressed.push(1);
            await delay(300);
            await OkEmu.pressQueue('1');
          },
        });
        log(`reset done, presses: ${pressed.length}`);

        /* The PIN is gone with it, which is how the next run knows to set one. */
        const state = await s.fido.pinState({timeoutMs: 10000});
        log(`pin set after the reset: ${state.set}`);
        assert.equal(state.set, false, 'the reset left a PIN behind');

        /*
         * PROVING IT IS EMPTY COSTS A NEW PIN, and that is not a detour.
         *
         * The first version asked for the count with a throwaway all-zero
         * token, on the assumption that metadata needs no real one when no
         * PIN is set. It does: ctap_cred_mgmt_pinauth verifies METADATA
         * against PIN_TOKEN unconditionally (ctap.cpp:1598-1607), the reset
         * had just regenerated PIN_TOKEN, and the answer was
         * CTAP2_ERR_PIN_AUTH_INVALID - which ALSO DECREMENTS the attempt
         * counter (ctap.cpp:1611). So "just ask with a dummy token" is not a
         * free question; it is one of eight lives.
         *
         * Setting a PIN again is the honest way to ask, and it proves
         * something on its own: setPin works on a key that has just been
         * reset, which is the state a person is in after using this.
         */
        await s.fido.setPin(FIDO_PIN, {timeoutMs: 10000});
        const token = await s.fido.getPinToken(FIDO_PIN, {timeoutMs: 10000});

        const counts = await s.fido.credentialCount(token, {timeoutMs: 10000});
        log(`stored after the reset: ${counts.stored}`);
        assert.equal(counts.stored, 0, 'credentials survived a reset');

        const sites = await s.fido.listCredentials(token, {timeoutMs: 15000});
        assert.equal(sites.length, 0, 'a site survived a reset');

        shared = null;
      });
  });
};
