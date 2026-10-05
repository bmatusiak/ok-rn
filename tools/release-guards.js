#!/usr/bin/env node
'use strict';
/*
 * WHAT A RELEASE BUILD REFUSES - one place, run by Gradle before every release
 * build (android/app/build.gradle, preReleaseBuild) and tested by jest
 * (__tests__/releaseGuards.test.ts). Whoever runs `gradlew assembleRelease`,
 * with or without tools/release.js:
 *
 * 1. DEBUG FIRMWARE (log audit, spec order 2026-10-04): the staged soft key's
 *    onlykey.h with `#define DEBUG` active would print key bytes, RNG output
 *    and PIN digits to its console. release.js sets OKEMU_PRODUCTION=1.
 *
 * 2. THE DEBUGGING LOCK OFF (Brad, 2026-10-05): src/generated/firmware.json
 *    with debugLock false is a TEST build - with adb on, a computer could
 *    approve and press. It is built only when THIS build asked for it
 *    (OKRN_DEBUG_LOCK=off in its environment), never from a staging left over
 *    from an earlier TEST build (seen 2026-10-05: a debug build picked up the
 *    last TEST staging's lock-off). Gradle then names the version
 *    "<version>-TEST-nolock", so such an apk can never pass for a pre-release.
 *
 * node tools/release-guards.js  -> exit 0, or 1 with the reasons on stderr
 */
const fs = require('fs');
const path = require('path');

/** The reasons a release build must stop (empty: go on). Pure: tested. */
function releaseRefusals({onlykeyH, firmwareJson, env = {}}) {
  const out = [];
  if (onlykeyH === null || onlykeyH === undefined) {
    out.push('no staged soft-key firmware (okemu/.stage/libraries/onlykey/onlykey.h) to check the DEBUG gate of');
  } else if (/^#define DEBUG\s/m.test(onlykeyH)) {
    out.push('the staged soft-key firmware has DEBUG on (it would print key material to its console). ' +
      'Build releases with `node tools/release.js` (it sets OKEMU_PRODUCTION=1), or set OKEMU_PRODUCTION=1 yourself.');
  }
  let fw = null;
  try { fw = firmwareJson === null || firmwareJson === undefined ? null : JSON.parse(firmwareJson); } catch { fw = null; }
  if (!fw) {
    out.push('cannot read src/generated/firmware.json - is the debugging lock on? Stage the firmware first.');
  } else if (fw.debugLock === false && env.OKRN_DEBUG_LOCK !== 'off') {
    out.push('the staged firmware has the debugging lock OFF (a TEST build: with adb on, a computer could approve and press), ' +
      'but this build did not ask for one. Stage again without OKRN_DEBUG_LOCK=off for a production build, ' +
      'or set OKRN_DEBUG_LOCK=off for a TEST build (named <version>-TEST-nolock, never a pre-release).');
  }
  return out;
}

/** Is the staged lock off (the Gradle versionName suffix reads the same file)? */
function stagedLockOff(firmwareJson) {
  try { return JSON.parse(firmwareJson).debugLock === false; } catch { return false; }
}

module.exports = {releaseRefusals, stagedLockOff};

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
  const reasons = releaseRefusals({
    onlykeyH: read(path.join(root, 'android', 'okemu', '.stage', 'libraries', 'onlykey', 'onlykey.h')),
    firmwareJson: read(path.join(root, 'src', 'generated', 'firmware.json')),
    env: process.env,
  });
  for (const r of reasons) process.stderr.write(`release build refused: ${r}\n`);
  process.exit(reasons.length ? 1 : 0);
}
