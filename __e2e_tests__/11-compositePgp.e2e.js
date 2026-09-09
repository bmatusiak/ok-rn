/**
 * The vendored OpenPGP fork does NOT load under Hermes, and this pins that.
 *
 * Composite PQC PGP is the last of the web app's four crypto areas and the only
 * one needing the 1.2 MB openpgp fork rather than @noble alone. The fork is
 * byte-for-byte verified against upstream and its unit tests pass - IN NODE.
 * Nothing had ever loaded it on the phone, and it was recorded as "Hermes-safe"
 * on the strength of those Node tests.
 *
 * It is not. See FINDING-the-openpgp-fork-does-not-load-under-hermes.md.
 *
 * ## What was measured, in order
 *
 *   require('node-onlykey-lib/crypto/pgp')            -> undefined
 *   require('.../src/vendor/openpgp/openpgp.js')      -> undefined
 *   require('../../node-onlykey-lib/src/vendor/...')  -> undefined
 *   require('node-onlykey-lib/definitely-not-here')   -> THROWS
 *   require('node-onlykey-lib/crypto').composite      -> works
 *   a file with the fork's exact top-level shape, tiny -> works
 *
 * So it is not the exports map, not the symlink, not the resolver, and not the
 * IIFE construction: an unresolvable module throws, and this one resolves,
 * runs, and yields `undefined`. What is left is the size - one 31,000-line
 * function - which Hermes fails to produce a value for WITHOUT RAISING
 * ANYTHING. No error in logcat, no rejected promise, no bundler warning.
 *
 * ## Why this suite asserts the failure
 *
 * A skipped test says nothing, and a red suite for a condition nobody is fixing
 * today trains people to ignore red. So this asserts what is TRUE now, and is
 * written to break loudly when that changes.
 */
'use strict';

const okcrypto = require('node-onlykey-lib/crypto');

module.exports = function compositePgp({describe, it}) {
  describe(compositePgp.name, () => {
    it('the composite blob format works without the fork', async ({log, assert}) => {
      /*
       * The parts costing only @noble DO work, and they are most of it: the
       * blob layout, its offsets, and the device operations that consume it.
       * Only key GENERATION needs the fork, and only because a composite key is
       * a PGP key - not because the device asks for one.
       */
      const composite = okcrypto.composite;
      log(`BLOB_LEN ${composite.BLOB_LEN}, key type 0x${composite.PQC_KEY_TYPE_BYTE.toString(16)}`);

      assert.equal(typeof composite.packBlob, 'function');
      assert.equal(typeof composite.unpackBlob, 'function');
      assert.equal(typeof composite.registerCompositeHooks, 'function');

      const blob = composite.packBlob(
        new Uint8Array(composite.ED25519_SK_LEN).fill(1),
        new Uint8Array(composite.MLDSA_SEED_LEN).fill(2),
        new Uint8Array(composite.X25519_SK_LEN).fill(3),
        new Uint8Array(composite.MLKEM_SEED_LEN).fill(4),
      );
      assert.equal(blob.length, composite.BLOB_LEN);

      const back = composite.unpackBlob(blob);
      assert.equal(back.ed25519Sk[0], 1);
      assert.equal(back.mlkemSeed[0], 4, 'the four halves came back in order');
    });

    it('the fork still does not load, so key generation stays blocked', async ({log, assert}) => {
      /*
       * WHEN THIS TEST FAILS, THAT IS GOOD NEWS. It means the fork has started
       * loading - re-bundled into ordinary modules, or Hermes grew the limit,
       * or someone precompiled it. Delete this test and write the real ones:
       * generate a composite key, check the blob is BLOB_LEN with no 32-byte
       * run of zeroes, armour the public key and read it back.
       */
      const fork = require('node-onlykey-lib/crypto/pgp');
      log(`require returned: ${typeof fork}`);

      assert.equal(
        typeof fork, 'undefined',
        'the OpenPGP fork LOADS now - delete this test and write the real ones ' +
          '(see the comment above it)',
      );
    });
  });
};
