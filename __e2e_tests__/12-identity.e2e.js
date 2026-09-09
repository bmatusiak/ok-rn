/**
 * Does the version and capability detection agree with the real firmware?
 *
 * test/version.test.js in the library drives every branch of this from canned
 * status lines, which is the only way old firmware can be covered at all - the
 * emulator is built from current firmware, so CI can never produce an old
 * device. What a fixture cannot prove is that the CURRENT generation is being
 * read correctly, because a fixture is a string somebody typed.
 *
 * This is the other half: the same parser, against the string a running
 * firmware actually emits.
 *
 * ## What it pins
 *
 * The firmware names its own build, because onlykey.h composes the version
 * with a keyword that depends on the gate:
 *
 *   #ifdef DEBUG
 *   #define OKversionkeyword "-test"
 *   #else
 *   #define OKversionkeyword "-prod"
 *   #endif
 *
 * So these run against EITHER build without being edited. They assert that the
 * build is identified and that the identification agrees with the bus - a
 * debug build has SEREMU traffic, a production build has none - rather than
 * asserting which build is staged, which only OKEMU_PRODUCTION decides.
 *
 * Both have been run: `-testc` with SEREMU present, `-prodc` with it absent.
 */
'use strict';

const {device: okdevice} = require('node-onlykey-lib');
const {getOnlyKey} = require('../src/onlykey');

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;

/*
 * One connect for the whole suite. Each connect() rekeys the session, and the
 * status is the same string every time, so four of them would be three waits
 * for no new information.
 */
let shared = null;
async function connected(log) {
  if (shared) return shared;
  if (!OkEmu.isRunning()) await OkEmu.start();
  const {device} = await getOnlyKey();
  const result = await device.connect();
  log(`connect: ${JSON.stringify(String(result.status).trim())}`);
  shared = {device, result, status: String(result.status).trim()};
  return shared;
}

module.exports = function identity({describe, it}) {
  describe(identity.name, () => {
    it('the running firmware announces a version we can parse', async ({log, assert}) => {
      /*
       * connect() sends OKCONNECT, which over the vendor interface is
       * set_time() - and set_time answers with the status string. That is the
       * one reply guaranteed to carry a version, which is why detection hangs
       * off it rather than off the once-a-second broadcast.
       */
      const {status, result} = await connected(log);
      log(`status: ${JSON.stringify(status)}`);

      const info = okdevice.version.parseStatus(status);

      /*
       * connect() parses this itself now, so the two must agree. If they ever
       * do not, the library is handing callers something other than what the
       * device said.
       */
      assert.equal(
        result.identity.version, info.version,
        'connect() reports the same identity this parse produces',
      );
      log(`state=${info.state} version=${info.version} model=${info.model} build=${info.build}`);

      assert.equal(info.state, 'unlocked', 'the suite runs against an unlocked key');
      assert.ok(info.version, 'a version was found after the state word');
      assert.ok(
        info.release && info.release.major >= 3,
        `the release parsed as numbers: ${JSON.stringify(info.release)}`,
      );
    });

    it('the model is read from the letter the firmware appends', async ({log, assert}) => {
      /*
       * HW_MODEL() appends one unconditionally (okcore.cpp:7978-8005), so an
       * unknown model here means the parse is wrong, not that the device is shy.
       */
      const {status} = await connected(log);
      const info = okdevice.version.parseStatus(status);
      log(`model: ${info.model}`);

      assert.notEqual(
        info.model, 'unknown',
        'HW_MODEL always appends a letter, so unknown means we failed to read it',
      );

      const caps = okdevice.version.capabilities(info);
      log(`slots=${caps.slots} profiles=${caps.profiles} buttons=${caps.buttons}`);

      // The emulator is the Color hardware path, so these are the Classic numbers.
      assert.equal(info.model, 'classic');
      assert.equal(caps.slots, 12);
      assert.equal(caps.buttons, 6);
      assert.equal(caps.challengeFormula, 'modern', 'six buttons means mod 6');
    });

    it('the build is named, and it is one of the two that exist', async ({log, assert}) => {
      /*
       * NOT "this is a debug build". That is what this test said first, and it
       * failed the moment the DEBUG-off variant was staged - correctly, but a
       * suite that has to be edited to run against the other build is a suite
       * that will not be run against it.
       *
       * The claim that holds either way is that the build is IDENTIFIED. Which
       * one it is depends on OKEMU_PRODUCTION, and the next test checks the
       * answer against the bus rather than trusting it.
       */
      const {status} = await connected(log);
      const info = okdevice.version.parseStatus(status);
      const caps = okdevice.version.capabilities(info);
      log(`build=${info.build} console=${caps.debugConsole}`);

      assert.ok(
        info.build === 'debug' || info.build === 'production',
        `the version keyword named neither build: ${JSON.stringify(info.version)}`,
      );
      assert.equal(
        caps.debugConsole, info.build === 'debug',
        'a debug build has the console and a production build does not',
      );
    });

    it('the console the build claims is actually there', async ({log, assert}) => {
      /*
       * The claim above is read off a string. This checks it against the bus:
       * a debug build enumerates SEREMU and prints to it, a production build
       * has no such interface. Two independent signals agreeing is the point -
       * if they ever disagree, the string is what to distrust, because the
       * traffic is the device itself.
       */
      const {status} = await connected(log);
      const caps = okdevice.version.capabilities(okdevice.version.parseStatus(status));

      const seen = await new Promise(resolve => {
        let done = false;
        const off = OkEmu.on('stream', event => {
          if (event.iface === OkEmuModule.IFACE.SEREMU && !done) {
            done = true;
            off();
            resolve(true);
          }
        });
        setTimeout(() => {
          if (!done) {
            done = true;
            off();
            resolve(false);
          }
        }, 4000);
      });

      log(`SEREMU traffic seen: ${seen}, build says console: ${caps.debugConsole}`);
      assert.equal(
        seen, caps.debugConsole,
        'the version keyword and the actual bus traffic must agree about the console',
      );
    });
  });
};
