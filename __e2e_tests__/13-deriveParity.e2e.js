/**
 * Is the shared secret the RIGHT secret, or just a stable one?
 *
 * 10-derive.e2e.js already asserts determinism: the same label derives the same
 * key twice, two labels differ, and the secret is stable across calls. Every one
 * of those passes for a WRONG answer, as long as the wrongness is deterministic
 * - and a mis-framed public key is exactly that. The device computes an ECDH
 * against whatever point it read, gets a perfectly stable 32 bytes, and nothing
 * in that suite can tell.
 *
 * This computes the answer independently and compares.
 *
 * ## The oracle
 *
 * ECDH is symmetric, so a host that holds a private scalar can check the
 * device's arithmetic without knowing the device's:
 *
 *   device holds d, publishes P = d·G      (derive_public_key)
 *   host generates k, sends Q = k·G        (the peer key)
 *   device returns x(d·Q)
 *   host computes  x(k·P)                  -- the same point
 *
 * So `p256.getSharedSecret(k, P)` is the expected value, computed here from
 * primitives that have nothing to do with the device. If the device read our Q
 * as a different point - one byte out, say - the two disagree immediately, and
 * they disagree no matter how stable either side is.
 *
 * ## Why a byte matters here
 *
 * The firmware hands the peer key to micro-ecc:
 *
 *     uECC_shared_secret(pub, ecc_private_key, secret, curve)   okcrypto.cpp:955
 *
 * micro-ecc's convention is a RAW 64-byte point, `x || y`, with no 0x04 prefix.
 * The device's own derived key is emitted the other way round - okcore's
 * ok_extension.cpp:330 does `memmove(ecc_public_key+1, ecc_public_key, 64);
 * ecc_public_key[0] = 4;` - so a caller that echoes the device's 65-byte key
 * straight back hands micro-ecc `04 || x[0..62]`: a point shifted by one byte,
 * which is still a point, and still deterministic.
 *
 * The web app builds the peer key as `x || y || 04` instead
 * (EPUB_TO_ONLYKEY_ECDH_P256, onlykey-3rd-party.js:102). That looks like a typo
 * and is not: micro-ecc reads the first 64 bytes and the trailing 0x04 is never
 * looked at.
 *
 * THE DEVICE MUST BE UNLOCKED, and every derive here asks for the press variant
 * - see 10-derive for both reasons.
 */
'use strict';

const {p256} = require('@noble/curves/nist.js');
const {getOnlyKey} = require('../src/onlykey');
const {bytes: okbytes} = require('node-onlykey-lib');

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;

const P256R1 = 1;
const LABEL = 'parity.example';

/**
 * Press when the device asks - or, on the 2.1 line, before it can ask.
 *
 * The same split 10-derive documents at length: 'keepalive' firmware returns
 * CTAP2_ERR_PROCESSING and can be answered from the keepalive, while 'blocking'
 * firmware sits inside ctap_user_presence_test(5000) with nothing to answer and
 * then denies. On the latter the press has to go out on a timer.
 */
function pressing(log, capabilities = null) {
  let pressed = 0;
  let timer = null;

  const press = async (why) => {
    if (pressed) return;
    pressed += 1;
    await OkEmu.pressQueue('1');
    log(`pressed button 1 for the derive (${why})`);
  };

  if (capabilities && capabilities.presenceTest === 'blocking') {
    timer = setTimeout(() => { void press('timer - this firmware does not keepalive'); }, 900);
  }

  return {
    done: () => { if (timer) clearTimeout(timer); },
    onKeepAlive: async () => {
      if (timer) { clearTimeout(timer); timer = null; }
      await press('keepalive');
    },
  };
}

const {needsCtaphid} = require('./helpers/needsCtaphid');

let shared = null;
async function connected(log) {
  if (shared) return shared;
  if (!OkEmu.isRunning()) await OkEmu.start();
  const {device, okcrypto} = await getOnlyKey();
  await device.connect();
  shared = {device, okcrypto};
  return shared;
}

/*
 * THE SAME ORIGIN GATE AS 10-derive. ok_extension.cpp:137 wraps the whole
 * OnlyKey extension in `if (webcryptcheck(_appid, client_handle))`, and a
 * firmware that does not recognise the request's origin answers nothing at
 * all - which surfaces as "the device did not answer this derive".
 *
 * The library now sends the origin every firmware from 2019 to HEAD treats as
 * first-party, so this reads true and skips nothing. Kept for the same reason
 * as its twin: an origin that moves again should stop this suite by name,
 * because it would not merely lose access - it would derive a different key
 * for the same label and the parity check would fail as a crypto mismatch.
 * ok-rn/FINDING-the-vendor-path-is-origin-gated.md
 */
function needsVendorOrigin(skip) {
  const caps = shared && shared.device && shared.device.capabilities;
  if (caps && caps.vendorOrigin === false) {
    skip('this firmware does not accept the origin this library derives under');
  }
}

module.exports = function deriveParity({describe, it}) {
  describe(deriveParity.name, () => {
    it('the shared secret matches one computed independently', async ({log, assert, skip}) => {
      const {okcrypto} = await connected(log);
      needsVendorOrigin(skip);
      needsCtaphid(skip, shared && shared.device);

      const pub = await okcrypto.derivePublicKey(LABEL, {
        keytype: P256R1,
        requirePress: true,
        ...pressing(log, shared && shared.device && shared.device.capabilities),
      });
      const devicePoint = pub.publicKey;
      log(`device point: ${okbytes.toHex(devicePoint).slice(0, 24)}… (${devicePoint.length} bytes)`);
      assert.equal(devicePoint.length, 65, 'the device emits 0x04 || x || y');
      assert.equal(devicePoint[0], 0x04);

      /*
       * Our own keypair. The scalar never leaves this test, which is what makes
       * the comparison below independent rather than circular.
       */
      const ours = p256.keygen();
      const ourPoint = p256.getPublicKey(ours.secretKey, false); // 0x04 || x || y

      const answer = await okcrypto.deriveSharedSecret(LABEL, ourPoint, {
        keytype: P256R1,
        requirePress: true,
        ...pressing(log, shared && shared.device && shared.device.capabilities),
      });

      /*
       * getSharedSecret returns the compressed-point form of x(k·P): a 0x02/0x03
       * parity byte then the 32-byte x coordinate. The device returns the x
       * coordinate alone, which is the same value.
       */
      const expected = p256.getSharedSecret(ours.secretKey, devicePoint).slice(1);

      log(`device secret: ${okbytes.toHex(answer.secret)}`);
      log(`host expected: ${okbytes.toHex(expected)}`);

      assert.equal(
        okbytes.toHex(answer.secret), okbytes.toHex(expected),
        'the device computed an ECDH against a different point than the one we ' +
          'meant to send - see the peer key framing note at the top of this file',
      );
    });

    it('a second host key gives a second secret, both correct', async ({log, assert, skip}) => {
      /*
       * One agreement could be luck in a way a second cannot: a framing bug that
       * happened to line up for one point will not line up for another, and a
       * cached answer would show as the same secret twice.
       */
      const {okcrypto} = await connected(log);
      needsVendorOrigin(skip);
      needsCtaphid(skip, shared && shared.device);

      const pub = await okcrypto.derivePublicKey(LABEL, {
        keytype: P256R1,
        requirePress: true,
        ...pressing(log, shared && shared.device && shared.device.capabilities),
      });

      const ours = p256.keygen();
      const ourPoint = p256.getPublicKey(ours.secretKey, false);

      const answer = await okcrypto.deriveSharedSecret(LABEL, ourPoint, {
        keytype: P256R1,
        requirePress: true,
        ...pressing(log, shared && shared.device && shared.device.capabilities),
      });
      const expected = p256.getSharedSecret(ours.secretKey, pub.publicKey).slice(1);

      log(`second secret: ${okbytes.toHex(answer.secret).slice(0, 24)}…`);
      assert.equal(okbytes.toHex(answer.secret), okbytes.toHex(expected));
    });
  });
};
