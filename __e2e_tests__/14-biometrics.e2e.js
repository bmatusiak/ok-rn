/**
 * Biometric-gated storage, as far as it can be tested without a finger.
 *
 * The prompt itself cannot be driven from here - it is a system dialog, and
 * adb can tap it but the sensor cannot be satisfied by a test. So this covers
 * the half that does not need one, which is the half where mistakes hide:
 *
 *   the module answers at all, and says WHY it cannot be used
 *   `has()` never prompts, so a screen can decide what to show
 *   forgetting something that was never stored is not an error
 *   loading something that was never stored fails by NAME, not by prompting
 *
 * What is deliberately not asserted is that a stored secret comes back. That
 * needs a real authentication, and a test that could pass without one would be
 * testing a code path this design exists to prevent.
 */
'use strict';

const NativeSecretsModule = require('../specs/NativeSecrets');
const NativeSecrets = NativeSecretsModule.default || NativeSecretsModule;

const KNOWN = ['available', 'none-enrolled', 'no-hardware', 'unavailable'];

module.exports = function biometrics({describe, it}) {
  describe(biometrics.name, () => {
    it('reports a status this app knows how to explain', async ({log, assert}) => {
      /*
       * The set is closed on purpose. A screen maps each of these to a sentence
       * someone can act on - "no fingerprint set up yet" is fixable and "no
       * hardware" is not - and an unmapped value would render as nothing.
       */
      const status = await NativeSecrets.biometricStatus();
      log(`status: ${status}`);
      assert.ok(
        KNOWN.includes(status),
        `unknown biometric status "${status}" - src/biometrics.ts has no text for it`,
      );
    });

    it('answers whether something is stored WITHOUT prompting', async ({log, assert}) => {
      /*
       * If this prompted, every launch would ask for a fingerprint just to
       * decide whether to draw a button.
       */
      const stored = await NativeSecrets.biometricHas('e2e-never-stored');
      log(`has(e2e-never-stored): ${stored}`);
      assert.equal(stored, false);
    });

    it('forgetting something that was never stored is not an error', async ({log, assert}) => {
      const result = await NativeSecrets.biometricForget('e2e-never-stored');
      log(`forget returned: ${result}`);
      assert.equal(result, true);
    });

    it('loading a secret that does not exist fails by name', async ({log, assert}) => {
      /*
       * By NAME, and without a prompt. Showing a prompt for a secret that is
       * not there asks someone to authenticate for nothing, and then fails
       * anyway.
       */
      let message = null;
      try {
        await NativeSecrets.biometricLoad('e2e-never-stored', 'title', 'subtitle');
      } catch (e) {
        message = String((e && e.message) || e);
      }
      log(`load rejected with: ${message}`);
      assert.ok(message, 'loading a missing secret resolved instead of failing');
      assert.ok(
        /nothing is stored/i.test(message),
        `the refusal should name the cause, got: ${message}`,
      );
    });
  });
};
