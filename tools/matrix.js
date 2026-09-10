#!/usr/bin/env node
/*
 * matrix.js - build every pinned firmware release and run the suite against it.
 *
 * The version matrix is the point of android/okemu/scripts/versions/: each
 * release gets its own storage slot, its own patches and its own status, so
 * `node-onlykey-lib/src/device/version.js`'s branches become measurements
 * instead of transcriptions. Doing that one release at a time by hand is how it
 * does not get done, so this drives the whole sweep.
 *
 *   node tools/matrix.js                 every release with a script
 *   node tools/matrix.js v2.1.0 v3.0.2   just those
 *   node tools/matrix.js --dry-run       say what it would do
 *   node tools/matrix.js --no-restore    leave the last version installed
 *
 * Set ANDROID_SERIAL when more than one device is attached; it is passed
 * through to gradle and to tools/e2e.js unchanged.
 *
 * ## Why each version takes several runs
 *
 * A fresh slot is an UNPROVISIONED device, and provisioning is not one step -
 * that is the firmware's design, not a flaw here:
 *
 *   1. 0-provision sets the PIN. `initialized` is recomputed from flash only in
 *      setup(), so the device reports its old state until it boots again, and
 *      an in-process firmware restart is not implemented. The runner
 *      force-stops the app between runs, which IS that boot.
 *   2. The first full run has 9-cryptoSign take config mode for the signing key
 *      and the touch-free derive preference. Config mode ends only at restart,
 *      so everything CTAPHID after it in that run is lost.
 *   3. The next run is the real measurement.
 *
 * So a version is run up to RUNS_PER_VERSION times and the LAST result is the
 * one reported, with every attempt printed so a version that only passes on the
 * third try is visible as exactly that.
 *
 * ## The .cxx directory is deleted between versions, deliberately
 *
 * Switching versions swaps the staged sources under a warm CMake build
 * directory, and ninja happily links new sources against old objects. Measured:
 * a working-tree build that had passed minutes earlier failed with nine
 * undefined okeeprom symbols, purely because the previous build had been
 * v2.1.0. A stale object is not worth the minute it saves.
 */
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OKEMU = path.join(ROOT, 'android', 'okemu');
const versions = require(path.join(OKEMU, 'scripts', 'versions'));

/** Attempts per version. See the header: a fresh slot needs three. */
const RUNS_PER_VERSION = 3;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const wanted = args.filter((a) => !a.startsWith('--'));

/**
 * The working tree is included FIRST and by name.
 *
 * It is the generation ahead of every release, it is what the app ships
 * against, and a sweep that measured only the old ones would not notice the
 * current one breaking. `stage.js` takes no OKEMU_VERSION for it.
 */
const WORKING_TREE = 'working-tree';

function plan() {
  if (wanted.length) return wanted;
  return [WORKING_TREE, ...versions.list()];
}

function run(cmd, argv, env) {
  const r = spawnSync(cmd, argv, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  return r.status === null ? 1 : r.status;
}

/** gradle and the e2e runner, with this version's environment. */
function envFor(version) {
  if (version === WORKING_TREE) return {};
  return {
    OKEMU_VERSION: version,
    /*
     * A RELEASE SHIPS WITH THE DEBUG GATE OFF, and a production build cannot be
     * given a PIN at all - the bracket is a conversation held entirely in
     * Serial.println (FINDING-provisioning-needs-a-debug-build.md). So every
     * pinned version is staged with the gate forced on, or its fresh storage
     * slot would stay UNINITIALIZED forever.
     *
     * The working tree already has it on, so it is left alone.
     */
    OKEMU_DEBUG: '1',
  };
}

function sweep(version) {
  const env = envFor(version);
  const label = version === WORKING_TREE ? 'working tree' : version;

  if (version !== WORKING_TREE) {
    let release;
    try {
      release = versions.load(version);
    } catch (e) {
      return { version, outcome: 'no script', detail: e.message.split('\n')[0] };
    }
    if (release.status === 'blocked') {
      return {
        version,
        outcome: 'blocked',
        detail: release.notes.split('\n')[0],
      };
    }
  }

  console.log(`\n${'='.repeat(72)}\n  ${label}\n${'='.repeat(72)}\n`);

  if (dryRun) return { version, outcome: 'dry run' };

  /* See the header: stale objects link against the wrong sources. */
  fs.rmSync(path.join(OKEMU, '.cxx'), { recursive: true, force: true });

  const built = run(path.join(ROOT, 'android', 'gradlew'),
    ['-p', path.join(ROOT, 'android'), ':app:installDebug', '-q'], env);
  if (built !== 0) return { version, outcome: 'build failed' };

  /*
   * Provisioning is attempted every time and costs one status read on a device
   * that already has a PIN, so there is no need to know in advance which case
   * this is.
   */
  run('node', [path.join(ROOT, 'tools', 'e2e.js'), '--only', 'provision'], env);

  /*
   * The counts come from a file rather than from stdout: this runs e2e.js with
   * its output inherited so the progress dots appear live, which leaves only an
   * exit code here. A version that SKIPS eleven tests and one that passes them
   * are both exit code 0, and the table has to be able to tell them apart.
   */
  const readVerdict = () => {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(ROOT, 'tools', '.last-e2e.json'), 'utf8'));
    } catch (_) {
      return null;
    }
  };

  let last = null;
  let verdict = null;
  for (let attempt = 1; attempt <= RUNS_PER_VERSION; attempt++) {
    const code = run('node', [path.join(ROOT, 'tools', 'e2e.js')], env);
    last = code;
    verdict = readVerdict();
    console.log(`\n  ${label}: run ${attempt} exited ${code}\n`);
    if (code === 0) break;      // green; nothing later would be more true
  }

  return {
    version,
    outcome: last === 0 ? 'PASS' : last === 2 ? 'runner error' : 'FAIL',
    detail: verdict
      ? `${verdict.passed} passed`
        + (verdict.failed ? `, ${verdict.failed} failed` : '')
        + (verdict.skipped ? `, ${verdict.skipped} skipped` : '')
      : '',
  };
}

/*
 * The sweep ENDS on the working tree, not on whichever release ran last.
 *
 * Two reasons, and the second is the one that costs an hour. The phone is left
 * running the app's own firmware rather than a two-year-old release; and
 * `src/generated/firmware.json` is left describing what is actually installed.
 * Metro serves that file LIVE while the native library is baked into the APK,
 * so a stale one means the JS opens a storage slot the firmware is not using -
 * a device that boots, answers, and is quietly the wrong one.
 */
function restoreWorkingTree() {
  if (dryRun) return;
  console.log(`\n${'='.repeat(72)}\n  restoring the working tree\n${'='.repeat(72)}\n`);
  fs.rmSync(path.join(OKEMU, '.cxx'), { recursive: true, force: true });
  run(path.join(ROOT, 'android', 'gradlew'),
    ['-p', path.join(ROOT, 'android'), ':app:installDebug', '-q'], {});
}

function main() {
  const list = plan();
  console.log(
    `matrix: ${list.length} to sweep - ${list.join(', ')}\n` +
    `Each is a clean native build plus up to ${RUNS_PER_VERSION} runs; a fresh\n` +
    'storage slot needs all of them. See this file\'s header for why.');

  const results = [];
  for (const version of list) results.push(sweep(version));

  if (!process.argv.includes('--no-restore')) restoreWorkingTree();

  console.log(`\n${'='.repeat(72)}\n  matrix\n${'='.repeat(72)}`);
  for (const r of results) {
    console.log(`  ${String(r.version).padEnd(14)} ${String(r.outcome).padEnd(14)}${r.detail || ''}`);
  }

  const bad = results.filter((r) => r.outcome === 'FAIL' || r.outcome === 'build failed');
  process.exit(bad.length ? 1 : 0);
}

if (require.main === module) main();
