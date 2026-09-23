'use strict';

/**
 * v3.0.5 - NAMED BUT NOT CUT.
 *
 * `libraries/onlykey/onlykey.h` declares OKversionmaj/min/pat as 3/0/5, so
 * every build of the current checkouts answers `UNLOCKEDv3.0.5-testc` on the
 * wire. Upstream has a `release/v3.0.5` branch in 0c-coder/libraries; there is
 * no `v3.0.5-prod` tag in either repo, and OnlyKey-Firmware's newest tag is
 * still v3.0.4-prod.
 *
 * So this version exists as a name before it exists as a commit. Its row in
 * ok-versions.json is deliberately BLANK, which pinsFor() reads as "the
 * working tree" - see the note there. That makes `OKEMU_VERSION=v3.0.5` build
 * what the checkouts hold, which is what v3.0.5 currently is, and it means the
 * row is already in place to fill in on release day rather than being
 * remembered then.
 *
 * ## While it is blank, this IS the working tree
 *
 * Everything here is working-tree.js's, spread rather than copied, because two
 * lists that must agree and are maintained separately eventually do not. In
 * particular it inherits:
 *
 *   - the sketch yield() patch, which no pinned release needs
 *   - the four guards upstream fixed, declared absent rather than deleted
 *   - `slot: ''`, the unnamed storage slot, so a device provisioned under the
 *     working tree is the same device here. That is the point: selecting
 *     v3.0.5 today must not look like a different key.
 *
 * `unreleased` stays true throughout, because `unreleased: !release.pins` and
 * the pins are null. That is correct and not a gap - this is ahead of every
 * release until the day it is one.
 *
 * ## On release day
 *
 * Fill both hashes into ok-versions.json. pinsFor() then returns them, the
 * sources are materialised from git instead of the checkouts, `unreleased`
 * becomes false, and THIS FILE STOPS INHERITING: replace the spread with a
 * measured patch list of its own, the way v3.0.4.js has one. A release whose
 * patches are "whatever the tree happens to need" has not been measured.
 */
const workingTree = require('./working-tree');

module.exports = {
  ...workingTree,
  version: 'v3.0.5',

  /*
   * Not 'tested' yet. It is the same sources the working tree runs, and those
   * pass, but this entry has not been swept UNDER THIS NAME and saying
   * otherwise would put a claim in the matrix that nobody made.
   */
  status: 'boots',

  notes: [
    'NAMED BUT NOT CUT. onlykey.h declares 3.0.5 and upstream has a',
    'release/v3.0.5 branch, but neither repo has a v3.0.5 tag, so the pins in',
    'ok-versions.json are blank and this builds the working tree.',
    '',
    'Identical to working-tree by construction - same patches, same storage',
    'slot - so it is not a second thing to keep in step while it is blank.',
    '',
    'On release day: fill in both hashes, then give this file its own',
    'measured patch list instead of the spread.',
  ].join('\n'),
};
