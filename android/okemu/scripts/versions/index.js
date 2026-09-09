'use strict';
/*
 * One stage script per firmware release.
 *
 *     OKEMU_VERSION=v3.0.2 node scripts/stage.js
 *
 * stage.js is the ENGINE - the patches every version needs, the flash rebase,
 * the system-block rewrite. What differs release to release lives in
 * `scripts/versions/<version>.js`, one file per entry in ok-versions.json, and
 * this module loads it.
 *
 * ## Why per-version files rather than one table
 *
 * A single VERSION_PATCHES array cannot say WHICH release each entry is for
 * without a comment nobody can check, and an `optional` patch that silently
 * misses looks identical to one that was never needed. Splitting them means a
 * version script lists exactly what that release needs, so applying it is
 * mandatory - a miss is an error, not a shrug - and the file is also the place
 * to write down how far that version has actually been taken.
 *
 * ## What a version script exports
 *
 *   version   must equal the filename, so a copied file cannot lie about itself
 *   pins      optional; cross-checked against ok-versions.json and NOT trusted
 *             over it. Present so that editing the pin list fails loudly here
 *             instead of quietly invalidating everything measured below.
 *   status    how far this release has been taken - see STATUS
 *   notes     what is known, and what the evidence was
 *   patches   staged edits this release needs. Applied like any other patch:
 *             a pattern that does not match is an ERROR.
 *   drop      extra core files to delete, if a release ships one that later
 *             ones do not. Usually absent.
 *   expect    optional { digest } from the last successful stage of this
 *             version. A mismatch is reported, not fatal - the toolchain and
 *             stage.js are both inputs and both move.
 *
 * Adding a release is copying the nearest neighbour, changing `version`,
 * setting `status: 'untried'`, and emptying `notes`.
 */

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
/* versions -> scripts -> okemu -> android -> ok-rn -> the checkouts root. */
const ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');
const PIN_FILE = path.join(ROOT, 'ok-versions.json');

/**
 * How far a release has been taken, weakest first.
 *
 * Each rung is a thing somebody watched happen, not a thing that ought to
 * follow from the rung below. "Patches apply" is not "it links", and "it links"
 * is not "it boots" - both of those have already been the difference between a
 * version that works and one that does not.
 */
const STATUS = [
  'blocked',   // cannot be staged at all - a pinned commit is not in the checkout
  'untried',   // nobody has run stage.js for it
  'stages',    // stage.js completes, every patch applies
  'builds',    // :okemu:externalNativeBuild links a libokemu.so
  'boots',     // the firmware starts on a phone and completes OKCONNECT
  'tested',    // the e2e suite has been run against it and the result recorded
];

/** What OKEMU_VERSION is unset. Every build has a script; this is its name. */
const WORKING_TREE = 'working-tree';

/** Every RELEASE that has a script here, newest name first. */
function list() {
  return fs
    .readdirSync(HERE)
    .filter((f) => f.endsWith('.js') && !f.startsWith('_') && f !== 'index.js')
    .map((f) => f.slice(0, -3))
    .filter((name) => name !== WORKING_TREE)
    .sort()
    .reverse();
}

/**
 * The pinned commits for one release, from ok-versions.json.
 *
 * Null for the working tree, which is pinned to nothing - it is whatever the
 * checkouts are at.
 */
function pinsFor(version) {
  if (version === WORKING_TREE) return null;
  if (!fs.existsSync(PIN_FILE)) {
    throw new Error(`OKEMU_VERSION=${version} but ${PIN_FILE} does not exist`);
  }
  const all = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8'));
  const pins = all[version];
  if (!pins) {
    throw new Error(
      `OKEMU_VERSION=${version} is not in ok-versions.json; known: ` +
      Object.keys(all).join(', '),
    );
  }
  return pins;
}

/**
 * Load one release's stage script.
 *
 * Throws rather than falling back to a default. A typo'd version silently
 * building the working tree under another name is the one outcome a version
 * matrix must never produce - every measurement after it would be attributed to
 * the wrong firmware.
 */
function load(version) {
  const file = path.join(HERE, `${version}.js`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `no stage script for ${version}.\n` +
      `  expected: ${path.relative(ROOT, file)}\n` +
      `  have:     ${list().join(', ') || '(none)'}\n` +
      `  Copy the nearest neighbour and set status: 'untried'.`,
    );
  }

  const mod = require(file);

  if (mod.version !== version) {
    throw new Error(
      `${version}.js declares version "${mod.version}" - a copied file that was ` +
      `not renamed inside. Fix the export, not the filename.`,
    );
  }
  if (!STATUS.includes(mod.status)) {
    throw new Error(
      `${version}.js has status "${mod.status}"; expected one of ${STATUS.join(', ')}`,
    );
  }

  const pins = pinsFor(version);

  /*
   * The script may restate the pins it was written against. ok-versions.json
   * stays the source of truth; this only catches the two drifting apart, which
   * would otherwise invalidate every note in the file without changing a line
   * of it.
   */
  if (mod.pins && pins) {
    for (const repo of Object.keys(mod.pins)) {
      if (mod.pins[repo] !== pins[repo]) {
        throw new Error(
          `${version}.js was written against ${repo}@${mod.pins[repo]}, but ` +
          `ok-versions.json now pins ${repo}@${pins[repo]}. Re-measure this ` +
          `release, then update the script - its notes describe the old commit.`,
        );
      }
    }
  }

  return {
    version,
    pins,
    status: mod.status,
    notes: mod.notes || '',
    patches: mod.patches || [],
    /**
     * Applied only when the DEBUG gate ends up OFF, whichever way it got
     * there - OKEMU_PRODUCTION=1, or a release that simply ships that way.
     * Per-version because the lines they patch do not all exist at every
     * release.
     */
    debugOffPatches: mod.debugOffPatches || [],
    drop: mod.drop || [],
    expect: mod.expect || null,
    /**
     * Where this version's flash.bin and eeprom.bin live, under the app's
     * files/okemu directory. A v2.1 firmware reading a v3.0.4 flash is not a
     * measurement of v2.1, so each release gets its own state and switching
     * back finds what it left.
     *
     * The working tree - no OKEMU_VERSION - keeps the bare `okemu` directory it
     * has always used, so nothing already on a phone moves.
     */
    slot: mod.slot !== undefined ? mod.slot : version,
  };
}

module.exports = { list, load, pinsFor, STATUS, PIN_FILE, WORKING_TREE };
