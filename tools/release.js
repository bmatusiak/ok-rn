#!/usr/bin/env node
/**
 * Build the RELEASE apk, cold, with production firmware.
 *
 * ## The rule this enforces
 *
 * A production release gets a CLEAN build, so it cannot carry stale drift.
 * Not `--no-build-cache` bolted onto whatever was lying around - every
 * intermediate removed first, including the staged firmware, and no daemon
 * left holding a file it built last time.
 *
 * That rule is easy to state and easy to skip, because an incremental build
 * looks identical and finishes sooner. It was skipped once already: a retry
 * after a failure reused a half-written `.stage` from the run that crashed,
 * which is exactly the drift the rule exists to stop.
 *
 * ## The one that is not optional
 *
 *     OKEMU_PRODUCTION=1
 *
 * stage.js leaves the firmware's DEBUG gate ALONE by default (WANT_DEBUG is
 * null), and the working tree has it ON. So a release built without this flag
 * ships DEBUG firmware in a release wrapper - a build that looks production
 * and answers the debug console. The flag is set here and the result is
 * VERIFIED afterwards from the staged source, rather than trusted.
 *
 *   node tools/release.js            clean, production, assembleRelease
 *   node tools/release.js --keep     skip the wipe (for iterating; NOT a release)
 */
'use strict';

const {execSync} = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const ANDROID = path.join(ROOT, 'android');
const OKEMU = path.join(ANDROID, 'okemu');
const KEEP = process.argv.includes('--keep');

const say = (s) => console.log(s);
/*
 * ABSOLUTE, AND QUOTED. A bare `gradlew.bat` is resolved against PATH rather
 * than the working directory under cmd.exe - "not recognized as an internal
 * or external command", from a directory the wrapper is sitting in.
 */
const gradlew = JSON.stringify(
  path.join(ANDROID, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'),
);

/* Everything a previous build could have left behind. */
const DISPOSABLE = [
  path.join(OKEMU, '.stage'),
  path.join(OKEMU, 'build'),
  path.join(ANDROID, 'app', 'build'),
  path.join(ANDROID, 'build'),
];

/*
 * ONE COMMAND STRING, handed to a shell - not a file plus arguments.
 *
 * gradlew is a .bat on Windows, and Node 24 refuses to spawn a .bat from
 * execFileSync: `spawnSync gradlew.bat EINVAL`, thrown before gradle starts,
 * as part of the CVE-2024-27980 mitigation. execSync passes the whole string
 * to cmd.exe, which runs a .bat the way a command prompt does.
 */
function run(args, opts = {}) {
  return execSync(`${gradlew} ${args.join(' ')}`, {
    cwd: ANDROID,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

/* ------------------------------------------------------------------ state */

let dirty = '';
try {
  dirty = execSync('git status --short', {cwd: ROOT, encoding: 'utf8'}).trim();
} catch {
  /* not a git tree, or no git - not a reason to refuse to build */
}
let head = '';
try {
  head = execSync('git rev-parse --short HEAD', {cwd: ROOT, encoding: 'utf8'}).trim();
} catch {}

say('');
say(`release: HEAD ${head || '(unknown)'}`);
if (dirty) {
  /*
   * A WARNING, NOT A REFUSAL. Whether to ship uncommitted work is the
   * builder's call; not being able to say afterwards what went in is not.
   */
  say('release: WARNING - the tree is dirty, so this apk is not reproducible from a commit:');
  for (const line of dirty.split(/\r?\n/).slice(0, 10)) say(`  ${line}`);
}

/* ------------------------------------------------------------------- wipe */

if (KEEP) {
  say('release: --keep, so nothing was wiped. THIS IS NOT A RELEASE BUILD.');
} else {
  /*
   * The daemon goes first. It holds file handles on what it built, and on
   * Windows that surfaces as EBUSY from whatever tries to rewrite them -
   * observed on `.stage/libraries/onlykey/okcore.cpp` mid-stage.
   */
  say('release: stopping the gradle daemon');
  try { run(['--stop']); } catch { /* none running */ }

  for (const dir of DISPOSABLE) {
    if (!fs.existsSync(dir)) continue;
    say(`release: removing ${path.relative(ROOT, dir)}`);
    fs.rmSync(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  }
}

/* ------------------------------------------------------------------ build */

say('release: building with OKEMU_PRODUCTION=1, cold');
const env = {...process.env, OKEMU_PRODUCTION: '1'};
let out = '';
try {
  out = run([':app:assembleRelease', '--no-build-cache', '--no-daemon'], {env});
} catch (e) {
  out = String((e.stdout || '') + (e.stderr || ''));
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-40).join('\n');
  /*
   * ALWAYS SAY SOMETHING. A spawn failure carries no stdout at all, so this
   * printed an empty block and the word FAILED - which is worse than the
   * failure, because it looks like the build itself said nothing.
   */
  console.log(tail || `(no build output) ${e.message || e}`);
  console.error('\nrelease: BUILD FAILED');
  process.exit(1);
}

for (const line of out.split(/\r?\n/)) {
  if (/^\s*stage:|BUILD SUCCESSFUL|BUILD FAILED/.test(line)) say(`  ${line.trim()}`);
}

/*
 * Gradle can print BUILD SUCCESSFUL for a run whose real work failed earlier,
 * and has: a staging crash once exited 0 with "10 tasks up-to-date". So the
 * apk's existence is what decides, not the wording.
 */
if (!/BUILD SUCCESSFUL/.test(out)) {
  console.error('release: gradle did not report success');
  process.exit(1);
}

/* ----------------------------------------------------------------- verify */

/*
 * THE GATE IS CHECKED, NOT ASSUMED. Setting the flag and reading back what it
 * did are different things, and only the second survives someone changing how
 * stage.js reads its environment.
 */
/*
 * IN onlykey.h, where the firmware DECLARES the gate - not okcore.cpp, which
 * only reads it. An earlier version of this check looked in okcore.cpp, found
 * neither marker and reported UNKNOWN against a build that was correctly
 * production: the right refusal for the wrong reason.
 */
const staged = path.join(OKEMU, '.stage', 'libraries', 'onlykey', 'onlykey.h');
let gate = 'UNKNOWN';
if (fs.existsSync(staged)) {
  const src = fs.readFileSync(staged, 'utf8');
  const off =
    src.includes('//#define DEBUG - removed by stage.js') ||
    src.includes('//#define DEBUG //Enable Serial Monitor');
  const on = /^#define DEBUG\s/m.test(src);
  gate = off && !on ? 'OFF (production)' : on ? 'ON  (DEBUG - NOT a production build)' : 'UNKNOWN';
}

/*
 * The keyboard layouts follow the same gate. A mismatch does not fail the
 * build - it types the wrong characters on a host - so it is named here
 * rather than discovered later.
 */
const layouts = path.join(OKEMU, '.stage', 'core', 'keylayouts.h');
let layoutGate = 'UNKNOWN';
if (fs.existsSync(layouts)) {
  const src = fs.readFileSync(layouts, 'utf8');
  /*
   * WHICH WAY ROUND THE SWITCH GOES, because this was backwards and said so
   * on every release for as long as it has existed.
   *
   * keylayouts.h's own comment: "comment this out (to match #undef DEBUG in
   * onlykey.h) for a release build". So the define being ACTIVE is the DEBUG
   * build - US English only - and it being COMMENTED OUT is the release, where
   * the #else branch compiles all twenty-six guarded layouts. This read the
   * commented-out case and reported "US English only", exactly inverted.
   *
   * Nothing shipped wrong - stage.js has always gated it correctly - but this
   * line is what somebody checks before handing an apk out, and it was telling
   * them the opposite of the truth.
   */
  layoutGate = /^#define\s+KEYLAYOUTS_DEBUG_BUILD/m.test(src)
    ? 'OFF (US English only)'
    : src.includes('//#define KEYLAYOUTS_DEBUG_BUILD')
      ? 'ON  (all layouts)'
      : 'UNKNOWN';
}

/*
 * THE TESTING SURFACE IS NOT IN THE SHIPPED BUNDLE, and this is what proves it.
 *
 * A gate that makes something unreachable is not the same as it not being
 * there, and the difference is readable by anyone who unzips the apk. A
 * release was built with the runtime gate in place and its bundle still
 * contained "Enter testing mode" and "Wipe the Soft Key", because Metro puts
 * every statically imported module in the graph whether or not anything routes
 * to it.
 *
 * So metro.config.js swaps TestingScreen for a stub when `!context.dev`, the
 * `__DEV__` checks are inline so the branches fold, and this reads the bundle
 * that actually shipped. Grepping the source would only prove what was meant.
 */
const FORBIDDEN = [
  'Enter testing mode',
  'Leave testing mode',
  'PIN bypassed',
  'Wipe the Soft Key',
  'Factory reset',
  /*
   * THE DEBUG-CONSOLE SURFACES, moved off the Advanced tab on 2026-09-19.
   *
   * Both drive the 4th interface, which is a back door: over it,
   * unauthenticated, a key can be wiped, restarted, or have its PIN typed in.
   * Production firmware is compiled without it, and that is the security
   * property rather than a gap - so the controls that drive it belong to the
   * Testing tab, which this build strips.
   *
   * Listed here so the move is PROVEN rather than assumed. The strings are the
   * section titles; if either reappears in a release bundle, the build fails
   * rather than shipping a back-door control that merely looks unreachable.
   */
  'Debug console',
  'Wipe the hard key',
];
/*
 * Two places hold the same bundle and the AGP task that writes each has
 * changed name across versions, so both are tried rather than one guessed.
 * A path that is merely wrong must not read as a pass - "not found" is
 * treated as a leak below, because a check that cannot run has not passed.
 */
const BUNDLES = [
  path.join(ANDROID, 'app', 'build', 'generated', 'assets', 'react', 'release',
    'index.android.bundle'),
  path.join(ANDROID, 'app', 'build', 'intermediates', 'assets', 'release',
    'mergeReleaseAssets', 'index.android.bundle'),
];
const bundle = BUNDLES.find((p) => fs.existsSync(p));
let leaked = [];
if (bundle) {
  const js = fs.readFileSync(bundle, 'utf8');
  leaked = FORBIDDEN.filter((s) => js.includes(s));
} else {
  leaked = ['(bundle not found - could not check)'];
}

const apk = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
if (!fs.existsSync(apk)) {
  console.error(`release: no apk at ${apk}`);
  process.exit(1);
}

/*
 * Sign with the OnlyKey, BEFORE the hash is taken.
 *
 * Signing rewrites the file, so a sha256 computed above it would describe an
 * artifact nobody ever installs - and that hash is what goes in the release
 * notes for people to check against. Order is the whole point of it being
 * here rather than after the report.
 *
 * Gradle has already signed and aligned by now. apksigner strips the old
 * signature and puts ours on, preserving the alignment it found, so the two
 * stay separable: `gradlew assembleRelease` on its own still produces an
 * installable apk for anyone who never runs this script.
 *
 * Skippable with --no-sign, because a build that cannot finish because a
 * signer is unavailable is worse than one that says plainly it is unsigned.
 */
const OKSIGN = path.join(__dirname, 'oksign');
const SIGNER_CERT = path.join(OKSIGN, '.local', 'signer.crt.pem');

let signed = false;
if (!process.argv.includes('--no-sign')) {
  say('release: signing with the OnlyKey (expect two button presses, v2 and v3)');
  try {
    /*
     * Not run(): that one prefixes gradlew. apksign.cmd is its own program -
     * see its header for why apksigner cannot be invoked through the stock
     * launcher when a custom provider is involved.
     *
     * stderr inherited rather than captured: it carries the device console
     * and the helper's progress, and when a sign stalls waiting for a press
     * that output is the only thing that says so.
     */
    execSync([
      JSON.stringify(path.join(OKSIGN, 'apksign.cmd')),
      'sign', '--ks', 'NONE', '--ks-type', 'ONLYKEY',
      '--ks-provider-class', 'com.okrn.signer.OnlyKeyProvider',
      '--ks-provider-arg', JSON.stringify(SIGNER_CERT),
      '--ks-pass', 'pass:onlykey',
      '--min-sdk-version', '24', '--max-sdk-version', '36',
      JSON.stringify(apk),
    ].join(' '), {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: {...process.env, OKSIGN_CMD: path.join(OKSIGN, 'backend-device.cmd')},
    });
    signed = true;
  } catch (err) {
    console.error(`release: signing failed - ${err.message}`);
    process.exit(1);
  }
}

const bytes = fs.readFileSync(apk);
const sha = crypto.createHash('sha256').update(bytes).digest('hex');

say('');
say(`release: apk        ${path.relative(ROOT, apk)}`);
say(`release: size       ${(bytes.length / 1048576).toFixed(1)} MB`);
say(`release: sha256     ${sha}`);
say(`release: firmware   DEBUG gate ${gate}`);
say(`release: layouts    ${layoutGate}`);
say(`release: testing    ${leaked.length ? 'LEAKED: ' + leaked.join(', ') : 'absent from the bundle'}`);
/*
 * A SHIPPED OVERRIDE SAYS SO. An apk that can be told its firmware has
 * features it lacks must not hide that on the build which produced it - the
 * same reason the debug-keystore note is printed every time.
 */
const overrideOn = /export const ALLOW_OVERRIDE = true/.test(
  fs.readFileSync(path.join(ROOT, 'src', 'capabilityOverride.ts'), 'utf8'),
);
say(`release: overrides   ${overrideOn ? 'ENABLED - this apk can force capabilities on' : 'off'}`);
say(`release: commit     ${head}${dirty ? ' + uncommitted changes' : ''}`);
say('');
if (!gate.startsWith('OFF')) {
  console.error('release: the firmware gate is not OFF - do not ship this');
  process.exit(1);
}
if (leaked.length) {
  console.error(`release: the testing surface is in the bundle (${leaked.join(', ')})`);
  console.error('release: do not ship this - see metro.config.js resolveRequest');
  process.exit(1);
}
/*
 * ASK THE APK WHO SIGNED IT.
 *
 * This used to be three hardcoded lines saying "signed with the DEBUG
 * keystore", which was true when they were written and would have gone on
 * being printed word for word after the signer changed. A note that cannot be
 * wrong is a note that cannot be right either.
 *
 * apksigner verify is the only thing that actually knows, so it is asked, and
 * what it says is what gets printed.
 */
let signer = '(not checked)';
try {
  const out = execSync(
    `${JSON.stringify(path.join(OKSIGN, 'apksign.cmd'))} verify --print-certs ${JSON.stringify(apk)}`,
    {cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']},
  );
  const dn = /certificate DN: (.+)/.exec(out);
  const digest = /certificate SHA-256 digest: ([0-9a-f]+)/.exec(out);
  signer = digest ? `${digest[1]}  ${dn ? dn[1].trim() : ''}`.trim() : '(no signer found)';
} catch (err) {
  signer = `(apksigner could not verify: ${String(err.message).split('\n')[0]})`;
}
say(`release: signer     ${signer}`);
say(`release: signed by  ${signed ? 'the OnlyKey' : 'gradle (--no-sign)'}`);

/*
 * THE TEMPLATE KEY IS NOT AN IDENTITY. android/app/debug.keystore is the
 * stock React Native one - CN=Android Debug, fac61745... - and its private
 * half ships with every scaffold on GitHub, so anyone can build an update to
 * an apk it signed.
 *
 * For a pre-release that is a known, accepted cost: the emulated OnlyKey
 * holds that same key on purpose, so existing testers keep updating in place.
 * For a real release it is not, and this is the line that has to stop being
 * printed before one goes out.
 */
if (signer.startsWith('fac61745')) {
  say('release: NOTE - this is the React Native template key. Its private half is');
  say('release: public, so anyone can sign an update to this apk. Fine for a');
  say('release: pre-release; never for a real one.');
}
say('');
