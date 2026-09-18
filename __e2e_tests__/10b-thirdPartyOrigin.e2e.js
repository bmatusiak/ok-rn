/**
 * Per-origin key separation, which nothing else exercises.
 *
 * The origin is not an access check. `okcrypto_hkdf()` reads the rpId out of
 * the CTAP buffer, SHA-256s it, and mixes that hash into the HKDF expand step,
 * so the SAME slot and the SAME label derive a DIFFERENT key at a different
 * origin. That is what makes per-site derived keys work: a third-party site
 * asks under its own hostname and gets keys only it can ask for again.
 *
 * `webcryptcheck()` (fido2/device.cpp) answers with three values, and the
 * middle one is this feature:
 *
 *   2  the rpId matches stored_apprpid, or the appid hash matches a stored
 *      one. The full extension, no device setting needed.
 *   1  ANY other origin, for the 0xFFFFFFFF OKCONNECT bootstrap alone, when
 *      bit 2 of derived_key_challenge_mode is set. Third-party mode.
 *   0  otherwise, and the device answers nothing at all.
 *
 * MEASURED, once the bits were set (setting 21, config mode only). Same label,
 * one device, two origins:
 *
 *   apps.crp.to   04c69f1643bf92c71556f0d8…   65 bytes
 *   example.test  04ab5ed0ee3560e9037a70cf…   65 bytes
 *
 * REPEATS ARE THE POINT, not decoration. A key that varied between calls would
 * make "the two differ" meaningless, so each origin is derived twice and the
 * stability assertions run before the difference one. An earlier version of
 * this probe extracted the key wrongly, got empty strings for all four, and
 * reported "two origins derived the SAME key" - which was a bug in the reader,
 * not a finding about the device. Hence publicKeyFrom() and a throw when the
 * payload carries no key.
 *
 * REQUIRES BITS 2 AND 3 of derivedChallengeMode, written in config mode by
 * 9-cryptoSign. Config mode kills CTAPHID for the rest of the run it is
 * entered in, so this suite only ever sees them on a later run - which is the
 * same three-run climb a fresh device already needs.
 */
'use strict';
const {getOnlyKey} = require('../src/onlykey');
const {protocol} = require('node-onlykey-lib');
const okconnect = require('node-onlykey-lib/src/crypto/okconnect');
const {CtapHid} = protocol.ctaphid;
const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;
const rand = n => { const o = new Uint8Array(n); global.crypto.getRandomValues(o); return o; };
const hex = b => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
const LABEL = 'origin.probe';

async function deriveUnder(transport, rpId, log) {
  const ctap = new CtapHid(transport);
  await ctap.init({timeoutMs: 8000});
  const bound = protocol.tunnel.createTunnel(ctap, {randomBytes: rand, rpId});
  const app = okconnect.newTransitKeypair();
  const data = okconnect.buildMessage({
    transitPublicKey: app.publicKey,
    label: LABEL,
    publicKey: null,
    keytype: okconnect.KEYTYPE.P256R1,
  });
  /* The device asks for presence; press once when it does. */
  let pressed = 0;
  const answer = await bound.send(
    {cmd: okconnect.OKCONNECT, opt1: okconnect.KEYACTION.DERIVE_PUBLIC_KEY,
     opt2: okconnect.KEYTYPE.P256R1, opt3: 1, data},
    {timeoutMs: 45000,
     onKeepAlive: async () => {
       if (pressed) return;
       pressed += 1;
       await OkEmu.pressQueue('1');
       log(`  pressed button 1 for the ${rpId} derive`);
     }});
  if (!answer || !answer.data || !answer.data.length) {
    throw new Error(`no data (status ${answer && answer.status})`);
  }
  const opened = okconnect.openResponse(answer.data, app.secretKey);
  const pub = okconnect.publicKeyFrom(opened.payload, okconnect.KEYTYPE.P256R1);
  if (!pub || !pub.length) {
    throw new Error(`no public key in the payload (status "${opened.status}")`);
  }
  log(`  ${rpId} -> status "${opened.status}", key ${hex(pub).slice(0, 24)}… (${pub.length} bytes)`);
  return hex(pub);
}

module.exports = function thirdParty({describe, it}) {
  describe(thirdParty.name, () => {
    it('the same label derives a different key under a different origin', async ({log, assert, skip}) => {
      const {transport, device} = await getOnlyKey();

      /*
       * The same origin gate as 10-derive: if this firmware does not treat the
       * library's origin as first-party, the control derive below cannot run
       * and nothing here would mean anything.
       */
      const caps = device && device.capabilities;
      if (caps && caps.vendorOrigin === false) {
        skip('this firmware does not accept the origin this library derives under');
      }

      /*
       * THIRD-PARTY MODE IS A DEVICE SETTING, not a firmware capability, so a
       * device without bit 2 is not a failure - it is a device nobody has
       * turned it on for. 9-cryptoSign writes the bits in config mode, and
       * config mode kills CTAPHID for the rest of that run, so this only sees
       * them on a later one.
       */
      let first;
      try {
        first = await deriveUnder(transport, 'apps.crp.to', log);
      } catch (e) {
        skip(`the first-party derive did not answer, so there is no control to compare against: ${e.message}`);
      }
      const again = await deriveUnder(transport, 'apps.crp.to', log);
      const other = await deriveUnder(transport, 'example.test', log);
      const other2 = await deriveUnder(transport, 'example.test', log);

      assert.equal(first, again, 'the first-party key is not stable');
      assert.equal(other, other2, 'the third-party key is not stable');
      assert.notEqual(first, other, 'two origins derived the SAME key - no separation');
      log('per-origin separation holds: stable within an origin, different across');
    });
  });
};
