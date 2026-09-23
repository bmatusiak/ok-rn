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
 *   node tools/matrix.js --summary LOG   one line per failure, no stacks
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

/*
 * THE DUO IS A BUILD, NOT A SETTING. stage.js reads OKEMU_MODEL while it
 * stages the firmware, so a DUO emulator is a separate native build of the
 * same working tree - 24 slots, 4 profiles, 3 buttons, its own storage slot.
 * Nothing exercised it automatically until this entry: the suites already
 * branch on the model the firmware reports (identity asserts 24/4/3 on a
 * DUO), so the sweep's own pass/skip table says what a DUO cannot do.
 */
const WORKING_TREE_DUO = 'working-tree-duo';

function plan() {
  if (wanted.length) return wanted;
  return [WORKING_TREE, WORKING_TREE_DUO, ...versions.list()];
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

/**
 * gradle and the e2e runner, with this version's environment.
 *
 * THE DEFAULT IS WHAT SHIPS. A release is a production build - the DEBUG gate
 * off, and with it every keyboard layout compiled in rather than US English
 * alone - and that is the thing worth measuring. Forcing the gate on measures a
 * configuration no user has.
 *
 * `debug` asks for the other one, and provisioning needs it: a production build
 * cannot be given a PIN at all, because the bracket is a conversation held
 * entirely in Serial.println
 * (FINDING-provisioning-needs-a-debug-build.md). That is what
 * `provisioningPass` below is for - one debug build to set the PIN, then back
 * to what ships for everything that is actually being measured.
 *
 * The working tree is left alone in both cases. It is not a release, its gate
 * is whatever the sources have, and forcing it either way would measure
 * something nobody builds.
 */
function envFor(version, {debug = false} = {}) {
  if (version === WORKING_TREE) return {};
  if (version === WORKING_TREE_DUO) return { OKEMU_MODEL: 'duo' };
  return debug
    ? { OKEMU_VERSION: version, OKEMU_DEBUG: '1' }
    : { OKEMU_VERSION: version, OKEMU_PRODUCTION: '1' };
}

function sweep(version) {
  const env = envFor(version);
  const label = version === WORKING_TREE ? 'working tree'
    : version === WORKING_TREE_DUO ? 'working tree (DUO)' : version;

  if (version !== WORKING_TREE && version !== WORKING_TREE_DUO) {
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
  const build = (buildEnv) => {
    fs.rmSync(path.join(OKEMU, '.cxx'), { recursive: true, force: true });
    return run(path.join(ROOT, 'android', 'gradlew'),
      ['-p', path.join(ROOT, 'android'), ':app:installDebug', '-q'], buildEnv);
  };

  if (build(env) !== 0) return { version, outcome: 'build failed' };

  /*
   * Provisioning is attempted every time and costs one status read on a device
   * that already has a PIN, so there is no need to know in advance which case
   * this is.
   */
  const provisioned = run(
    'node', [path.join(ROOT, 'tools', 'e2e.js'), '--only', 'provision'], env);

  /*
   * A FRESH STORAGE SLOT NEEDS ONE DEBUG BUILD, and only one.
   *
   * The PIN bracket is a conversation in Serial.println, so a production build
   * - which is what everything here is measured as - cannot set a first PIN at
   * all. It refuses by name rather than timing out, which is what makes this
   * detectable in seconds instead of minutes.
   *
   * So: build debug, set the PIN, throw that build away and go back to what
   * ships. Flash and EEPROM are files and outlive the APK, so the production
   * build that follows finds a provisioned device and never needs this again -
   * the cost is two extra builds the first time a version is ever swept.
   *
   * The working tree is not eligible: its gate is whatever the sources have,
   * and envFor returns the same environment either way, so a debug pass there
   * would rebuild the identical thing.
   */
  const pinned = version !== WORKING_TREE && version !== WORKING_TREE_DUO;
  if (provisioned !== 0 && pinned) {
    console.log(
      `\n  ${label}: no PIN yet, and a production build cannot set one.` +
      `\n  One debug build to provision, then back to what ships.\n`);
    const debugEnv = envFor(version, { debug: true });
    if (build(debugEnv) !== 0) return { version, outcome: 'build failed' };
    run('node', [path.join(ROOT, 'tools', 'e2e.js'), '--only', 'provision'], debugEnv);
    if (build(env) !== 0) return { version, outcome: 'build failed' };
  }

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

/**
 * --summary: read a sweep's LOG and print one line per failure.
 *
 * The sweep runs e2e.js with stdio inherited, so matrix.js never sees a word of
 * it - the output goes straight to whatever captured the process. That is the
 * right call while it runs (the progress dots have to be live) and it is why
 * this is a log reader rather than something the sweep accumulates.
 *
 * It exists because the log is not readable by hand. Every failed assertion
 * carries its full JS stack, and under Metro each frame is a ~200-character
 * `http://localhost:8081/index.bundle?platform=android&dev=true&...` URL. One
 * version's failures are forty such lines apiece; pulling the actual messages
 * out of a single block cost about ten thousand tokens of bundle URLs once,
 * which is the whole reason this is here.
 *
 *   node tools/matrix.js --summary <logfile>
 *
 * Nothing is thrown away - the log keeps the stacks. This prints the first line
 * of each message, which is the part that says what went wrong.
 */
function summarize(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);

  let version = '(before any version)';
  let suite = '?';
  let attempt = 0;
  let atRule = false;
  const rows = [];

  for (const line of lines) {
    /*
     * A block header is the label alone BETWEEN two rules of '='. Matching the
     * label's SHAPE instead also matched 'v3.0.3: no PIN yet...' and
     * 'v3.0.3: run 1 exited 1' as new versions, and missed working-tree
     * entirely - so the rule is what identifies a header, not the text.
     */
    if (/^={10,}$/.test(line)) { atRule = true; continue; }
    if (atRule) {
      atRule = false;
      const label = line.trim();
      if (label) { version = label; suite = '?'; attempt = 0; }
      continue;
    }
    const s = /^\s*suite:\s*(\S+)/.exec(line);
    if (s) { suite = s[1]; continue; }

    const v = /^(PASS|FAIL)\s+passed=(\d+)(?:\s+failed=(\d+))?(?:\s+skipped=(\d+))?/.exec(line);
    if (v) {
      attempt++;
      rows.push({ kind: 'run', version, attempt, verdict: v[1],
        passed: v[2], failed: v[3] || '0', skipped: v[4] || '0',
        bail: /bailed after (\S+)/.exec(line) });
      continue;
    }

    const f = /✗\s+(.*)$/.exec(line);
    if (!f) continue;
    /*
     * "<test name> -> <message>", and the message runs on into an escaped
     * stack: the runner ships it through as a single line with literal \n.
     * Cut at the first one.
     */
    const body = f[1];
    const arrow = body.indexOf(' -> ');
    const name = arrow === -1 ? body : body.slice(0, arrow);
    let msg = arrow === -1 ? '' : body.slice(arrow + 4);
    msg = msg.split('\n')[0].split(/\s+at\s+\S+\s+\(http/)[0].trim();
    msg = msg.replace(/\\n$/, '').trim();
    rows.push({ kind: 'fail', version, suite, attempt: attempt + 1, name, msg });
  }

  let shown = null;
  let fails = 0;
  for (const r of rows) {
    if (r.version !== shown) {
      console.log(`\n${r.version}`);
      shown = r.version;
    }
    if (r.kind === 'run') {
      const b = r.bail ? `  (bailed after ${r.bail[1]})` : '';
      console.log(`  run ${r.attempt}: ${r.verdict} ${r.passed}p/${r.failed}f/${r.skipped}s${b}`);
    } else {
      fails++;
      console.log(`    ${r.suite} - ${r.name}`);
      if (r.msg) console.log(`      ${r.msg.slice(0, 150)}`);
    }
  }
  console.log(`\n${fails} failed test${fails === 1 ? '' : 's'} across the log.`);
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

if (require.main === module) {
  const i = args.indexOf("--summary");
  if (i !== -1) summarize(args[i + 1] || args.find((a) => !a.startsWith("--")));
  else main();
}
