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
/* What the staging step recorded, to check the device against. */
const {buildInfo} = require('../src/buildInfo');

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
      /*
       * That the version PARSES, not that it is any particular one.
       *
       * This used to assert `major >= 3`, which is a claim about the key on the
       * bench rather than about the parser - and it failed the moment the suite
       * was run against v2.1.0, on a release whose version had parsed perfectly.
       * Every release in ok-versions.json is 2.x or 3.x, so the parse is what
       * matters and the number is what varies.
       */
      assert.ok(info.release, `the version did not parse: ${JSON.stringify(info.version)}`);
      assert.ok(
        Number.isInteger(info.release.major) && info.release.major >= 2,
        `the release parsed as numbers: ${JSON.stringify(info.release)}`,
      );
      assert.ok(
        Number.isInteger(info.release.minor),
        `the minor version is not a number: ${JSON.stringify(info.release)}`,
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

      /*
       * The numbers must MATCH THE MODEL, not match the bench.
       *
       * This used to assert `classic`, 12 slots and 6 buttons - a claim about
       * the device that happened to be plugged in rather than about the parse.
       * The emulator can now be staged as either (OKEMU_MODEL=duo), and on a
       * DUO those assertions failed against a device that was reporting itself
       * perfectly.
       *
       * The pairs below are the whole point of the model letter: reading it
       * wrong means enumerating 12 of 24 slots with no error, or showing a
       * three-button device a challenge with a 4 in it.
       */
      if (info.model === 'duo') {
        assert.equal(caps.slots, 24, 'a DUO is 24 slots across 4 profiles');
        assert.equal(caps.profiles, 4);
        assert.equal(caps.buttons, 3);

        /*
         * THE FIRMWARE ITSELF STOPPED DOING MOD 3, and this assertion is where
         * that shows up rather than something to work around.
         *
         * `okcore_prime_user_confirmation()` computes the three digits as
         * `(temp[n] % 6) + '0' + 1`, with an `if (onlykeyhw==OK_HW_DUO)` branch
         * taking `% 3` because a DUO has three buttons. That branch is present
         * v2.1.0 through v3.0.1, ABSENT in v3.0.2, v3.0.3 and v3.0.4, and
         * restored in master. v3.0.1's okcore.cpp carries 27 OK_HW_DUO
         * references and v3.0.2's carries 26; the missing one is this branch.
         *
         * So on those three SIGNED releases a DUO is asked for digits in 1..6
         * while holding three buttons, and 4, 5 and 6 cannot be pressed -
         * exactly the thing the note above warns about, done by the firmware.
         * P(all three land in 1..3) is 1/8, so seven signing or decryption
         * attempts in eight cannot be completed.
         *
         * A HOST CANNOT REPAIR THAT. It can only predict what will actually be
         * asked, which is what capabilities() now does. Predicting mod 3 there
         * would make the host wrong as well, and two wrongs surface as "Error
         * incorrect challenge was entered" with nothing to say which side
         * produced it.
         *
         * The window is stated here from the VERSION rather than read back from
         * the capability, so this stays an independent check: if the gate ever
         * claims 'modern' for a DUO outside v3.0.2..v3.0.4, this fails.
         */
        const at = okdevice.version.atLeast;
        const duoBranchGone =
          at(info.release, [3, 0, 2]) && !at(info.release, [3, 0, 5]);
        log(`duo challenge branch present in firmware: ${!duoBranchGone}`);

        assert.equal(
          caps.challengeFormula, duoBranchGone ? 'modern' : 'duo',
          duoBranchGone
            ? 'v3.0.2-v3.0.4 dropped the DUO branch, so the device asks for '
              + 'digits 1-6 and the host must predict the same'
            : 'three buttons means mod 3',
        );
        assert.equal(caps.configModeGesture.button, 1, 'a DUO takes config mode on button 1');
      } else {
        assert.equal(info.model, 'classic');
        assert.equal(caps.slots, 12);
        assert.equal(caps.profiles, 2);
        assert.equal(caps.buttons, 6);
        assert.equal(caps.challengeFormula, 'modern', 'six buttons means mod 6');
        assert.equal(caps.configModeGesture.button, 6);
      }

      /*
       * And the model must agree with what was STAGED. buildInfo comes from
       * src/generated/firmware.json, which the staging step writes; the status
       * comes from the firmware itself. If those two disagree, the JS is
       * talking to a device it does not think it is talking to - which is the
       * failure that made a v3.0.2 library open the working tree's flash and
       * look perfectly healthy.
       */
      log(`staged model: ${buildInfo.model}`);
      assert.equal(
        info.model, buildInfo.model,
        'the firmware reports a different model than the one that was staged',
      );
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
      const info = okdevice.version.parseStatus(status);
      const caps = okdevice.version.capabilities(info);

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

      /*
       * v2.1.0 IS THE ONE RELEASE WHERE THEY DISAGREE, AND THE DEVICE IS WRONG.
       *
       * It announces -prod, so debugConsole is false, and it prints anyway.
       * Not our staging: v2.1.1 is the commit that WRAPPED those calls in
       * `#ifdef DEBUG` - prints like "Generating Yubico OTP..." were bare
       * before it - so turning the gate off never silenced them. And the
       * shipped binary had the gate off: Signed_OnlyKey_2_1_0_STD declares
       * `v2.1.0-prod` in its own string table, which is what the firmware
       * composes when DEBUG is undefined. Those prints went out to users.
       *
       * Named rather than relaxed. The assertion is right and the firmware is
       * wrong, so weakening it would record a real defect as absent; skipping
       * the whole test would lose the check everywhere else. This says which
       * release, why, and where it is written down.
       * ok-rn/FINDING-v2.1.0-prints-to-the-console-on-a-production-build.md
       */
      const leaks = /^v2\.1\.0-/.test(String(info.versionField || ''));
      if (leaks && seen && caps.debugConsole === false) {
        log(
          'v2.1.0 prints on a production build - upstream, fixed in v2.1.1. ' +
            'See FINDING-v2.1.0-prints-to-the-console-on-a-production-build.md',
        );
        return;
      }

      assert.equal(
        seen, caps.debugConsole,
        'the version keyword and the actual bus traffic must agree about the console',
      );
    });
  });
};
