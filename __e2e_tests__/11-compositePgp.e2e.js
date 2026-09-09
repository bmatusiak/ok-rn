/**
 * Composite PQC PGP on the phone: the fork loads, and a key can be made.
 *
 * This suite spent a long time asserting the OPPOSITE - that the vendored
 * OpenPGP fork does not load under Hermes - and that header outlived the
 * condition it described. It is worth saying what it used to claim, because the
 * shape of the mistake is the useful part.
 *
 * ## What it looked like, and why every probe missed it
 *
 * `require('node-onlykey-lib/crypto/pgp')` returned `undefined`. Not an error,
 * not a rejected promise, nothing in logcat. Ruling things out went: the
 * exports map (an unresolvable module THROWS, and this one resolved), the
 * symlink, the resolver, the IIFE shape, and the file's SIZE - the last of
 * which was blamed and then disproved with a generated 1.9 MB single-IIFE file
 * that loaded fine.
 *
 * The answer was not a property of the file at all. OpenPGP.js v6 reads
 * WebCrypto at MODULE SCOPE, React Native has none, so the factory threw - and
 * Metro's `guardedLoadModule` caught that, handed it to
 * `ErrorUtils.reportFatalError`, and returned `undefined` WITHOUT rethrowing.
 * Every probe was inspecting the call site, which is the one place the
 * information was not.
 *
 * Installing a global error handler around the require produced the cause in a
 * single run. That capture is still the first test below, and it stays: it
 * passes either way and says which.
 *
 * ## What this suite asserts now
 *
 * That the fork loads, that a composite key generates with all four halves
 * carrying real material, that its armour survives two round trips, and that a
 * message encrypts and decrypts ON THE PHONE. The last matters because the
 * library's Node tests cannot see the class of bug that bites here: a global
 * Hermes lacks, surfacing as a ReferenceError deep inside openpgp rather than
 * as a wrong answer. TextDecoder was exactly that, and it only appeared once
 * the WebCrypto gap was closed.
 *
 * See FINDING-the-openpgp-fork-does-not-load-under-hermes.md.
 */
'use strict';

const okcrypto = require('node-onlykey-lib/crypto');

/** Carried between the generate step and the armour step that reads it back. */
const shared = {key: null};

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

    it('the fork LOADS, and exports the openpgp API', async ({log, assert}) => {
      /*
       * This test used to assert the opposite, and was written to fail loudly
       * the day the fork started loading. It did. What made the difference was
       * a `crypto.subtle`: OpenPGP.js v6 reads WebCrypto at module scope, React
       * Native has none, and the shim installed by src/installWebCrypto.js
       * supplies one backed by @noble.
       */
      const fork = require('node-onlykey-lib/crypto/pgp');
      log(`require returned: ${typeof fork}`);
      assert.notEqual(fork, undefined, 'the fork is back to not loading');
      assert.equal(typeof fork.generateKey, 'function', 'no generateKey on the fork');
      assert.equal(typeof fork.readKey, 'function');
    });

    it('generates a composite key, and the blob is real key material', async ({log, assert}) => {
      /*
       * The thing that has been blocked all along. Ed25519 + ML-DSA-65 for
       * signing, X25519 + ML-KEM-768 for encryption, packed into the 160-byte
       * blob okpqc.h expects.
       *
       * The assertion is NOT that the blob is 160 bytes. A buffer of zeroes is
       * also 160 bytes, and that is exactly what a half-failed extraction
       * produces - so each of the four halves is checked for a run of zeroes
       * where its seed should be. Every one of them has to have come from
       * somewhere.
       */
      const openpgp = require('node-onlykey-lib/crypto/pgp');
      const composite = okcrypto.composite;

      const started = Date.now();
      const result = await composite.generateCompositeKey(openpgp, {
        userId: {name: 'e2e', email: 'e2e@example.invalid'},
      });
      log(`generated in ${Date.now() - started}ms`);

      assert.equal(result.blob.length, composite.BLOB_LEN,
        `blob is ${result.blob.length} bytes, expected ${composite.BLOB_LEN}`);

      const parts = composite.unpackBlob(result.blob);
      for (const [name, half] of Object.entries(parts)) {
        const allZero = half.every(b => b === 0);
        log(`  ${name}: ${half.length} bytes, ${allZero ? 'ALL ZERO' : 'has content'}`);
        assert.equal(allZero, false, `${name} is all zeroes - the extraction failed silently`);
      }

      shared.key = result;
      assert.ok(true);
    });

    it('the generated public key armours and reads back', async ({log, assert}) => {
      /*
       * Armour is the format anything else would receive this key in, so a key
       * that cannot be written out and parsed again is not usable no matter
       * what its blob looks like.
       */
      assert.ok(shared.key, 'the previous test did not produce a key');
      const openpgp = require('node-onlykey-lib/crypto/pgp');

      const armored = shared.key.armoredPublicKey;
      log(`armored public key: ${String(armored).length} chars`);
      /*
       * assert.ok with a test(), not assert.match - this harness provides only
       * ok, equal and notEqual. Reaching for Node's assert API here fails as
       * "undefined is not a function" pointing at the assertion line, which
       * reads like the thing being asserted about is broken.
       */
      assert.ok(
        /BEGIN PGP PUBLIC KEY BLOCK/.test(String(armored)),
        'the generated key is not PGP armour',
      );

      const back = await openpgp.readKey({armoredKey: armored});
      assert.ok(back, 'readKey returned nothing');

      /*
       * Each accessor is checked BEFORE it is called. A bare `back.foo()` on a
       * missing method fails as "undefined is not a function" with no clue
       * which one, and the fork's surface is exactly what is under test here.
       */
      const present = ['getFingerprint', 'getKeyID', 'getAlgorithmInfo', 'armor']
        .filter(m => typeof back[m] === 'function');
      log(`key methods present: ${present.join(', ')}`);
      assert.ok(present.includes('getFingerprint'), 'the re-read key has no getFingerprint');

      const fingerprint = back.getFingerprint();
      log(`fingerprint: ${String(fingerprint).slice(0, 16)}…`);
      assert.ok(fingerprint && String(fingerprint).length >= 32, 'no usable fingerprint');

      /*
       * Re-armour and read AGAIN. One parse could succeed on a key the fork
       * cannot reproduce; a second round trip that yields the same fingerprint
       * says the key survives the format it will actually travel in.
       */
      const again = await openpgp.readKey({armoredKey: back.armor()});
      assert.equal(again.getFingerprint(), fingerprint, 'the key did not survive a second round trip');
    });

    it('a message encrypts and decrypts ON THE PHONE', async ({log, assert}) => {
      /*
       * The library has seventeen Node tests for this. They cannot see the
       * class of bug that actually bites here: Hermes is missing globals Node
       * has, and the failure is a ReferenceError deep inside openpgp rather
       * than a wrong answer. TextDecoder was exactly that - key generation
       * worked and reading armour did not.
       *
       * So this runs the same round trip where it matters. It uses a key
       * generated in-process rather than the device's, because the device path
       * needs a composite key loaded into a slot; that is a separate test and
       * a separate setup.
       */
      const openpgp = require('node-onlykey-lib/crypto/pgp');
      const messages = okcrypto.messages;

      const key = await openpgp.generateKey({
        type: 'pqc',
        userIDs: [{name: 'e2e', email: 'e2e@example.invalid'}],
        subkeys: [{}],
        format: 'object',
        config: {v6Keys: true},
      });

      const text = 'the ciphertext is not the message';
      const armored = await messages.encryptText(openpgp, {
        text,
        recipients: key.publicKey,
      });
      log(`armoured message: ${String(armored).length} chars`);
      assert.ok(
        !String(armored).includes(text),
        'the plaintext is sitting in the output',
      );

      const result = await messages.decryptMessage(openpgp, {
        armored,
        decryptWith: key.privateKey,
      });
      log(`decrypted: ${JSON.stringify(result.data)}`);
      assert.equal(result.data, text);
    });

    it('a signature verifies, and a bad one says so rather than throwing', async ({log, assert}) => {
      const openpgp = require('node-onlykey-lib/crypto/pgp');
      const messages = okcrypto.messages;

      const mine = await openpgp.generateKey({
        type: 'pqc', userIDs: [{name: 'a', email: 'a@example.invalid'}],
        subkeys: [{}], format: 'object', config: {v6Keys: true},
      });
      const other = await openpgp.generateKey({
        type: 'pqc', userIDs: [{name: 'b', email: 'b@example.invalid'}],
        subkeys: [{}], format: 'object', config: {v6Keys: true},
      });

      const signed = await messages.signText(openpgp, {
        text: 'signed on a phone',
        signWith: mine.privateKey,
      });

      const good = await messages.verifyText(openpgp, {
        armored: signed, verifyWith: mine.publicKey,
      });
      log(`own key: valid=${good.valid}`);
      assert.equal(good.valid, true);

      /*
       * openpgp's signature results are promises that REJECT, so a wrong key
       * has to come back as a verdict rather than as an unhandled rejection
       * somewhere else in the app.
       */
      const bad = await messages.verifyText(openpgp, {
        armored: signed, verifyWith: other.publicKey,
      });
      log(`other key: valid=${bad.valid}, error=${bad.signatures[0] && bad.signatures[0].error}`);
      assert.equal(bad.valid, false);
      assert.ok(bad.signatures[0] && bad.signatures[0].error, 'no reason given');
    });
  });
};