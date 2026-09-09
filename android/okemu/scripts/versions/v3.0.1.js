'use strict';
const shared = require('./_shared');

/**
 * v3.0.1 - same generation as v3.0.2, one release back.
 *
 * Probed only. version-probe.js reports 8/8 version-pinned patterns matching,
 * and `git show a27ffa6:password/password.cpp` has the same `int`/`uint8_t`
 * disagreement the 3.0 line carries throughout, so it takes the same shared
 * patch. Neither of those is a build.
 */
module.exports = {
  version: 'v3.0.1',
  pins: { libraries: 'a27ffa6', 'OnlyKey-Firmware': 'c3929eb' },
  status: 'untried',

  notes: [
    'Probed, never staged. 8/8 version-pinned patterns match.',
    'Needs the Profile_Offset patch: measured present at a27ffa6.',
  ].join('\n'),

  patches: [shared.profileOffsetType],
};
