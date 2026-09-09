'use strict';

/**
 * v2.1.0 - the furthest back ok-versions.json goes, and therefore the release
 * that decides how far the version matrix can reach at all.
 *
 * Worth staging EARLY rather than last: if the oldest release builds, the ones
 * between it and the working tree are very unlikely to be harder, and the whole
 * matrix is reachable. If it does not, the failure names the boundary.
 *
 * No Profile_Offset patch - measured uint8_t in both places at 8687474, same
 * as v2.1.1.
 */
module.exports = {
  version: 'v2.1.0',
  pins: { libraries: '8687474', 'OnlyKey-Firmware': '159c0f2' },
  status: 'untried',

  notes: [
    'Probed, never staged. 8/8 version-pinned patterns match.',
    'Profile_Offset is already uint8_t in both places at 8687474.',
  ].join('\n'),

  patches: [],
};
