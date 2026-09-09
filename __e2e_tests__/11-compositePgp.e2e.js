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
 * So it is not the exports map, not the symlink and not the resolver: an
 * unresolvable module THROWS, and this one resolves.
 *
 * Nor is it the shape or the size, both of which I first blamed and then
 * disproved - 30,000 generated lines inside a single IIFE, 1.9 MB, loads and
 * returns its exports. Metro builds the real file too: asked for it as a bundle
 * entry, the dev server answers 200 with 1.5 MB.
 *
 * What is established is narrower and stranger. A copy of the fork whose LAST
 * LINE was replaced with `module.exports = {markerRan: true}` also comes back
 * undefined - so the export never ran, and since Metro initialises exports to
 * {}, undefined cannot come from a factory that merely did nothing. Nothing
 * throws: not through require, not in logcat, not as a rejected promise.
 *
 * The cause is open. See the finding for what to try next.
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

    it('CAPTURES the error Metro swallows when the fork is required', async ({log, assert}) => {
      /*
       * `require()` returning undefined with nothing thrown is not a mystery,
       * it is Metro's design. metro-runtime/src/polyfills/require.js:
       *
       *     function guardedLoadModule(moduleId, module) {
       *       if (!inGuard && global.ErrorUtils) {
       *         inGuard = true;
       *         let returnValue;
       *         try {
       *           returnValue = loadModuleImplementation(moduleId, module);
       *         } catch (e) {
       *           global.ErrorUtils.reportFatalError(e);   // <- not rethrown
       *         }
       *         inGuard = false;
       *         return returnValue;                        // <- still undefined
       *
       * So a module whose factory throws comes back undefined at the call site
       * and its error goes to the global handler instead. Every probe in the
       * finding was looking at the call site.
       *
       * This installs a handler around the require to read what was actually
       * thrown. It is a DIAGNOSTIC and is expected to keep passing once the
       * fork loads - at that point it captures nothing and says so.
       */
      const ErrorUtils = global.ErrorUtils;
      assert.ok(ErrorUtils, 'no ErrorUtils to install a handler on');

      const previous = ErrorUtils.getGlobalHandler && ErrorUtils.getGlobalHandler();
      const caught = [];
      ErrorUtils.setGlobalHandler((err, isFatal) => {
        caught.push({err, isFatal});
      });

      let returned;
      try {
        /*
         * A fresh path, so Metro's module cache cannot hand back the undefined
         * a previous require already stored. The other tests in this file use
         * the exports-map path; this one goes at the file.
         */
        returned = require('node-onlykey-lib/src/vendor/openpgp/openpgp.js');
      } finally {
        if (previous) ErrorUtils.setGlobalHandler(previous);
      }

      log(`require returned: ${typeof returned}`);
      log(`errors captured: ${caught.length}`);
      for (const {err, isFatal} of caught) {
        log(`  fatal=${isFatal} name=${err && err.name}`);
        log(`  message: ${String(err && err.message).slice(0, 400)}`);
        const NL = String.fromCharCode(10);
        const stack = String((err && err.stack) || '').split(NL).slice(0, 8);
        for (const line of stack) log(`    ${line.trim().slice(0, 160)}`);
      }

      if (returned !== undefined) {
        log('the fork LOADS - there is nothing left to capture');
        assert.ok(true);
        return;
      }

      assert.ok(
        caught.length > 0,
        'the fork came back undefined and NOTHING was reported to ErrorUtils - ' +
          'that would mean the factory never ran at all, which is a different ' +
          'problem from a factory that throws',
      );
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
