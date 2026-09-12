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
 *
 * ## How the pins were chosen, and why that is a convention rather than a fact
 *
 * NOBODY RECORDED THEM AT RELEASE TIME. There are no tags in either checkout,
 * and no release note names a commit, so every pin here was worked out
 * afterwards. The rule used is: the LAST commit that declares that version.
 *
 * Declares is meant literally. `libraries/onlykey/onlykey.h` carries
 * OKversionmaj/min/pat, so reading the header at every commit gives the range
 * of commits that called themselves v3.0.1, v3.0.2 and so on, and the pin is
 * the end of that range - the state the cycle finished in. It is what 3.0.0,
 * 3.0.1, 3.0.3 and 3.0.4 point at. v3.0.2 is the exception and says so in its
 * own file.
 *
 * The three oldest releases predate those macros entirely, so the header
 * cannot confirm them at all; their pins are the last code commit before the
 * next version's work began, which is a weaker argument and is the honest
 * state of them.
 *
 * ## What was tried to do better, and why it did not work
 *
 * `ok-rn/signed_firmware/` holds the signed release images, and they are
 * readable: word-swap the block data and the firmware's string table appears.
 * Every image declares its own version, which confirms the `file` column in
 * ok-versions.json - but a version string only narrows a release to the range
 * above, which is what we already had.
 *
 * Two ways past that, both closed:
 *
 *   * REBUILD AND COMPARE. `arduino-1.6.5-r5-teensy_127/` is a Docker build of
 *     the pinned Arduino 1.6.5 + Teensyduino 1.27 whose compiler is a Linux
 *     ELF. The development machine has no Docker, no working WSL and cannot
 *     take a Linux toolchain. node-onlykey-emulator builds here, but an x86
 *     addon cannot byte-match a Teensy image.
 *   * COMPARE STRING TABLES. A commit that added or removed a literal would
 *     show up in the image. None of the in-range candidates does anything a
 *     production image keeps - they touch DEBUG prints, which -prod compiles
 *     out, or guards around non-STD builds.
 *
 * Which leaves the useful conclusion: for the CLASSIC STD build this matrix
 * stages, the candidates inside a version's range are the same code. The pin
 * is a convention, the convention cannot be confirmed from the release, and
 * on what is actually measured here it does not change the answer. Written
 * down so the next person spends the afternoon on something else.
 */

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
/* versions -> scripts -> okemu -> android -> ok-rn -> the checkouts root. */
const APP = path.resolve(HERE, '..', '..', '..', '..');
const ROOT = path.resolve(APP, '..');

/**
 * The pins, preferring the copy inside this repo.
 *
 * They started life at the checkouts root, beside the firmware checkouts
 * they name commits in. That put a file this app depends on outside the
 * only tree that is version-controlled with it: clone ok-rn alone and the
 * matrix cannot say what v3.0.2 even means.
 *
 * So `ok-rn/ok-versions.json` wins when it exists, and the root copy stays
 * as the fallback for a working tree that still has one there. Which was
 * read is not a detail to guess at, so `PIN_FILE` is exported and the
 * errors below name it.
 */
const APP_PIN_FILE = path.join(APP, 'ok-versions.json');
const ROOT_PIN_FILE = path.join(ROOT, 'ok-versions.json');
const PIN_FILE = fs.existsSync(APP_PIN_FILE) ? APP_PIN_FILE : ROOT_PIN_FILE;

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
    /**
     * Where this release keeps its sketch, when it is not OnlyKey/OnlyKey.ino.
     *
     * The 2019 beta line has OnlyKey_Beta/OnlyKey_Beta.ino - a different
     * directory and a different file name. stage.js stages it AS
     * OnlyKey.ino whatever it was called, because okemu_sketch.cpp includes
     * that name and the name is not the part that varies.
     */
    sketch: mod.sketch || null,
    /**
     * Base-patch patterns this release's tree does not contain.
     *
     * Old trees predate some of the patterns the base patches look for, and
     * a stage that fails for that reason puts a floor under how far back the
     * matrix can reach. Declaring one is a claim stage.js CHECKS: a pattern
     * declared absent that turns out to be present is an error, because the
     * tree would otherwise be built unpatched on a stale note.
     */
    absentPatterns: mod.absentPatterns || [],
    /**
     * Build options this release must be staged with to be comparable, when
     * its pinned commit does not have them set.
     *
     * `std: true` is v2.1.1's case: that commit has STD_VERSION commented out,
     * so it builds as the IN TRVL edition and almost nothing the suite
     * exercises exists. Declaring it here means the release is staged the same
     * way whoever runs it, rather than depending on somebody remembering an
     * environment variable - and the notes say the commit itself is travel, so
     * nobody reads a standard result and concludes the commit was standard.
     *
     * An environment variable still wins, so a deliberate travel build is one
     * OKEMU_STD=0 away.
     */
    gates: mod.gates || {},
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
