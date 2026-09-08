/**
 * A FIDO2 ceremony, completed on the phone.
 *
 * This is the point of the whole soft-key idea, and until the button bridge
 * existed it could not be reached: authenticatorMakeCredential BLOCKS on a
 * finger. ctap_user_presence_test() (device.cpp:345-395) spins
 *
 *     do { if (touch_sense_loop()) u2f_button=1; ... }
 *     while (! IS_BUTTON_PRESSED());
 *
 * so with nothing able to press a button, every credential this device could
 * make timed out after 19 seconds and no amount of protocol work would have
 * changed that.
 *
 * ANY BUTTON WILL DO, and that is worth being precise about. The three-digit
 * challenge - SHA256 of the request, mod 6 - guards OKSIGN, OKDECRYPT and
 * OKSETPRIV. FIDO2 is not one of those: `packet_buffer_details[0] == OKWEBAUTHN
 * && isfade` completes the challenge on any press (OnlyKey.ino:821), and the
 * presence test above just wants `touch_sense_loop()` to return non-zero. So a
 * single Confirm control is the correct affordance here, not a keypad.
 *
 * THE DEVICE MUST BE UNLOCKED - okcore.cpp:639,651 drop FIDO packets silently
 * otherwise - which is why this runs after the device-flow suite.
 */
'use strict';

const {getOnlyKey} = require('../src/onlykey');
const {protocol} = require('node-onlykey-lib');

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;

const {CtapHid} = protocol.ctaphid;

const delay = ms => new Promise(r => setTimeout(r, ms));

/** Deterministic, so a failure is about the device and not about the input. */
const fill = (n, b) => new Uint8Array(n).fill(b);

function makeCredentialParams() {
  /*
   * The minimum a CTAP2 authenticator accepts: hash, rp, user, algorithms.
   * A Map rather than an object because CTAP2 keys are INTEGERS, and an
   * object would stringify them.
   */
  return new Map([
    [1, fill(32, 0x42)],
    [2, new Map([['id', 'okrn.test'], ['name', 'ok-rn e2e']])],
    [3, new Map([
      ['id', fill(16, 0x01)],
      ['name', 'e2e'],
      ['displayName', 'e2e'],
    ])],
    [4, [new Map([['alg', -7], ['type', 'public-key']])]],
  ]);
}

module.exports = function presence({describe, it}) {
  describe(presence.name, () => {
    it('a credential ceremony blocks for a finger, and a press completes it', async ({
      log,
      assert,
    }) => {
      if (!OkEmu.isRunning()) await OkEmu.start();
      const {device, transport} = await getOnlyKey();

      const state = await device.connect();
      log(`device: ${String(state.status).trim()}`);
      assert.ok(
        /UNLOCKED/i.test(String(state.status)),
        'the device is locked, so FIDO packets are dropped without a word',
      );

      const ctap = new CtapHid(transport);
      await ctap.init({timeoutMs: 8000});
      await delay(200);

      /*
       * The press happens FROM THE KEEPALIVE, not on a timer.
       *
       * The firmware sends exactly one KEEPALIVE when the status changes to
       * UP_NEEDED and then goes quiet for up to 19 seconds
       * (device.cpp:172, ctap.h:173), so that frame is the only signal that it
       * is actually waiting. Pressing on a fixed delay instead would race the
       * ceremony: too early and touch_sense_loop() has already returned, too
       * late and the window has closed.
       */
      /*
       * WHAT THIS ASSERTS DEPENDS ON WHETHER THE KEY HAS A CLIENT PIN.
       *
       * CTAP2 requires pinUvAuthParam on makeCredential once one is set, and
       * refuses without it - so a bare ceremony is CORRECT to fail on a
       * PIN-protected key and correct to succeed on a bare one. A test that
       * only passes in one of those states is testing the bench, not the code.
       *
       * A client PIN appears the moment a real host registers a credential:
       * Windows sets one during its first WebAuthn registration.
       */
      const info = await ctap.getInfo({timeoutMs: 10000});
      const hasPin = info.get(4)?.get('clientPin') === true;
      log(`clientPin: ${hasPin}`);

      if (hasPin) {
        let refused = null;
        try {
          await ctap.makeCredential(makeCredentialParams(), {timeoutMs: 10000});
        } catch (e) {
          refused = e;
        }
        log(`refused with: ${refused && refused.message}`);
        assert.ok(refused, 'a PIN-protected key made a credential without one');
        assert.ok(
          /PIN_AUTH_INVALID|PIN_REQUIRED/i.test(String(refused.message)),
          `expected a PIN error, got: ${refused.message}`,
        );
        return;
      }

      const prompts = [];
      let pressed = 0;

      const credential = await ctap.makeCredential(makeCredentialParams(), {
        timeoutMs: 10000,
        presenceTimeoutMs: 25000,
        onKeepAlive: async status => {
          prompts.push(status);
          log(`keepalive status 0x${status.toString(16)} - device wants a finger`);
          // A short settle first: the presence loop has to reach its `do`
          // before a press can be seen by it.
          await delay(300);
          await OkEmu.pressButton(1, 150);
          pressed += 1;
        },
      });

      log(`prompts: ${prompts.length}, presses: ${pressed}`);
      assert.ok(prompts.length > 0, 'the device never asked for user presence');
      assert.equal(ctap.askedForUserPresence, true, 'no UP_NEEDED keepalive');

      assert.ok(credential instanceof Map, 'makeCredential returned no CBOR map');

      const fmt = credential.get(1);
      const authData = credential.get(2);
      log(`fmt: ${fmt}, authData: ${authData && authData.length} bytes`);

      assert.equal(typeof fmt, 'string', 'no attestation format in the response');
      assert.ok(authData instanceof Uint8Array, 'no authData');
      assert.ok(authData.length >= 37, `authData is too short: ${authData.length}`);

      /*
       * Bit 0 of the flag byte is UP - the authenticator asserting that a user
       * was present. It is the whole reason this suite exists, and the device
       * sets it only after the press above.
       */
      const flags = authData[32];
      log(`flags: 0x${flags.toString(16)} (UP=${(flags & 0x01) !== 0}, AT=${(flags & 0x40) !== 0})`);
      assert.equal(flags & 0x01, 0x01, 'the authenticator did not assert user presence');
      assert.equal(flags & 0x40, 0x40, 'no attested credential data in authData');
    });
  });
};
