'use strict';
const shared = require('./_shared');

/**
 * v3.0.0 - the first of the 3.0 line, and the interesting one for the version
 * matrix: node-onlykey-lib/src/device/version.js draws its capability boundary
 * between the 2.1 and 3.0 generations, so this release and v2.1.2 are the pair
 * that decides whether those branches are right.
 */
module.exports = {
  version: 'v3.0.0',
  pins: { libraries: '5515974', 'OnlyKey-Firmware': 'dc24867' },
  status: 'untried',

  notes: [
    'Probed, never staged. 8/8 version-pinned patterns match.',
    'Needs the Profile_Offset patch: measured present at 5515974.',
  ].join('\n'),

  patches: [shared.profileOffsetType],
};
