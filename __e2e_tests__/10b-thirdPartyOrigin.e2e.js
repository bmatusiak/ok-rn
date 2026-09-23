/**
 * Per-origin key separation - and from firmware 3.0.5 there is none.
 *
 * WHAT THIS FILE USED TO PIN. okcrypto_hkdf() v1 read the rpId out of the CTAP
 * buffer, SHA-256'd it and mixed that hash into the HKDF expand step, so the
 * same slot and the same label derived a DIFFERENT key at a different origin.
 * Third-party sites asked under their own hostname and got keys only they
 * could ask for again.
 *
 * WHAT 3.0.5 DOES INSTEAD. libraries@40464ca replaced that with a fixed info
 * string, "onlykey/derive/ecc/v2", and no origin at all, because per-origin
 * keyspaces were "too confusing and complicated for the user" (the maintainer,
 * 2026-09). Access control replaces key separation: webcryptcheck() admits
 * exactly apps.crp.to and apps.onlykey.io, and everything else gets no
 * extension at all rather than a different key.
 *
 * So the assertion inverts, and it inverts rather than being deleted: a file
 * that used to pin separation should end up pinning that separation is
 * deliberately absent, where someone looking for it will find out why.
 *
 * Third-party browser use is closed by the same change - a page cannot assert
 * an rpId that is not a registrable suffix of its own origin, so it can never
 * name one of the two admitted ones. On a DEBUG build webcryptcheck() returns 2
 * before the table is read, which is why example.test still answers here at all.
 *
 * SO THERE ARE THREE STATES, not two, and the third is the one a shipped key
 * is actually in:
 *
 *   pre-3.0.5          the origin is in the HKDF info - different keys
 *   3.0.5, debug       trust-all: example.test is served, same key as crp.to
 *   3.0.5, ENFORCING   example.test is REFUSED; there is no key to compare
 *
 * Only the third describes a device a user will ever hold, and until
 * OKEMU_ENFORCE_ORIGINS existed this file could not reach it: an ordinary
 * debug build returns the most permissive answer webcryptcheck() has, so
 * "example.test derived a key" proved nothing about the origin table either
 * way. Staging with OKEMU_ENFORCE_ORIGINS=1 cuts that return and the table
 * decides, which is what makes the third branch below testable at all.
 *
 * The refusal is asserted by SHAPE rather than by a predicted error string.
 * `if (wc_level)` in ok_extension.cpp skips the whole extension block, so what
 * the host sees is whatever the ordinary FIDO2 path then makes of a credential
 * id that is not one - an error, an empty answer, or nothing. All three mean
 * the same thing here and the test says which it got; what must not happen is
 * a usable key coming back.
 *
 * REPEATS ARE THE POINT, and they earned their keep twice now. A key that
 * varied between calls would make any comparison meaningless, so each origin is
 * derived twice and the stability assertions run BEFORE the comparison.
 *
 * The first time, an earlier probe extracted the key wrongly, got empty strings
 * for all four and reported "two origins derived the SAME key" - a bug in the
 * reader wearing the costume of a finding about the device.
 *
 * The second time was 2026-09-23 and it came through a different door: this
 * file builds its own tunnel and calls openResponse() itself, so it never got
 * the transitV2 flag that plugins/okcrypto's derive() passes. v1 framing over a
 * v2 frame decrypts to noise - empty status, different "key" bytes every call -
 * and it surfaced as "the first-party key is not stable", which reads like a
 * NON-DETERMINISTIC DERIVATION and would be far worse than anything this file
 * is about. The stability assertions are what caught it.
 *
 * The lesson both times: a probe that decodes the device's answer itself can be
 * wrong about the answer, and its wrongness will look like a device defect.
 *
 * NO LONGER REQUIRES a device setting. It used to need bits 2 and 3 of
 * derivedChallengeMode, written in config mode by 9-cryptoSign - but 3.0.5
 * made fields 21/22/30 a 0/1/2 enum with no such bits, and admission is now the
 * compiled-in origin table, which no setting can extend.
 */
'use strict';
const {getOnlyKey} = require('../src/onlykey');
const {protocol} = require('node-onlykey-lib');
const okconnect = require('node-onlykey-lib/src/crypto/okconnect');
const {CtapHid} = protocol.ctaphid;
const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;
const {buildInfo} = require('../src/buildInfo');
const rand = n => { const o = new Uint8Array(n); global.crypto.getRandomValues(o); return o; };
const hex = b => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
const LABEL = 'origin.probe';

/*
 * `timeoutMs` exists for the refusal case. 45 s is right when an answer is
 * expected and a press has to be waited out; when the point is that NOTHING
 * comes back, 45 s of silence is most of the runner's own 90 s stall watchdog
 * (tools/e2e.js) spent proving something a fraction of it proves as well.
 */
async function deriveUnder(transport, rpId, log, {transitV2 = false, timeoutMs = 45000} = {}) {
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
    {timeoutMs,
     onKeepAlive: async () => {
       if (pressed) return;
       pressed += 1;
       await OkEmu.pressQueue('1');
       log(`  pressed button 1 for the ${rpId} derive`);
     }});
  if (!answer || !answer.data || !answer.data.length) {
    throw new Error(`no data (status ${answer && answer.status})`);
  }
  /*
   * THE FRAMING HAS TO BE PASSED, and this file has its own tunnel so nothing
   * passes it for free.
   *
   * plugins/okcrypto's derive() reads the device's transitV2 capability and
   * hands it to openResponse(); this file builds its own CtapHid and decodes
   * the answer itself, so the fix that taught the library transit v2 never
   * reached here.
   *
   * What that looked like: v1 framing over a v2 frame decrypts to noise, so
   * `status` came back EMPTY and the "public key" was different bytes on every
   * call - including two calls to the SAME origin. It read as "the first-party
   * key is not stable", i.e. as a non-deterministic derivation, which would be
   * a far worse defect than the one this file is about.
   */
  const opened = okconnect.openResponse(answer.data, app.secretKey, {transitV2});
  const pub = okconnect.publicKeyFrom(opened.payload, okconnect.KEYTYPE.P256R1);
  if (!pub || !pub.length) {
    throw new Error(`no public key in the payload (status "${opened.status}")`);
  }
  log(`  ${rpId} -> status "${opened.status}", key ${hex(pub).slice(0, 24)}… (${pub.length} bytes)`);
  return hex(pub);
}

module.exports = function thirdParty({describe, it}) {
  describe(thirdParty.name, () => {
    it('the same label derives the SAME key under a different origin, from 3.0.5', async ({log, assert, skip}) => {
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
       * WHICH FRAMING to decode with. This used to be a note about third-party
       * mode being a device setting that 9-cryptoSign turned on in config
       * mode; there is no such setting on 3.0.5 - fields 21/22/30 are a 0/1/2
       * enum with no third-party bit, and admission is the compiled-in origin
       * table, which nothing on the device can extend.
       */
      const framing = {transitV2: caps && caps.transitV2 === true};

      /*
       * WHICH BUILD IS THIS. Not a device capability and not readable from the
       * wire: an unenforcing build serves a third-party origin and an
       * enforcing one refuses it, and the only difference is a line cut at
       * staging time. stage.js records it, buildInfo reads it.
       */
      const enforcing = buildInfo.enforcingOrigins === true;

      let first;
      try {
        first = await deriveUnder(transport, 'apps.crp.to', log, framing);
      } catch (e) {
        skip(`the first-party derive did not answer, so there is no control to compare against: ${e.message}`);
      }
      const again = await deriveUnder(transport, 'apps.crp.to', log, framing);

      /* Stability within an origin is the control, and it is what proves the
       * framing is right: a mis-decoded answer is different bytes every call. */
      assert.equal(first, again, 'the first-party key is not stable');

      /*
       * THE ENFORCING BRANCH ENDS HERE, because there is no third-party key to
       * be stable. Asserted as "no key came back", by whatever route: a
       * refusal, an error, an empty answer or silence all mean the origin
       * table did its job, and pinning one of those spellings would turn an
       * upstream change in how a refusal is reported into a failure about
       * origins.
       */
      if (enforcing) {
        let leaked = null;
        try {
          leaked = await deriveUnder(transport, 'example.test', log,
            {...framing, timeoutMs: 15000});
        } catch (e) {
          log(`example.test was refused: ${e.message}`);
        }
        assert.equal(leaked, null,
          'an ENFORCING build derived a key for example.test - the origin '
          + 'table admits apps.crp.to and apps.onlykey.io only, so either the '
          + 'trust-all return was not cut or the table is not being read');
        log('the trusted-origin table holds: first-party derives, third-party gets nothing');
        return;
      }

      const other = await deriveUnder(transport, 'example.test', log, framing);
      const other2 = await deriveUnder(transport, 'example.test', log, framing);
      assert.equal(other, other2, 'the third-party key is not stable');

      if (framing.transitV2) {
        assert.equal(first, other,
          'two origins derived DIFFERENT keys - the origin is back in the '
          + 'derivation, which 3.0.5 removed');
        log('no per-origin separation, by design: one label, one key, every origin');
        log('(this build trusts every origin - stage with OKEMU_ENFORCE_ORIGINS=1 '
          + 'to test the table that a shipped key actually applies)');
      } else {
        assert.notEqual(first, other,
          'two origins derived the SAME key - no separation');
        log('per-origin separation holds: stable within an origin, different across');
      }
    });
  });
};
