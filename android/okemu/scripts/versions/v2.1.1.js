'use strict';

/**
 * v2.1.1 - the older generation. Expect more trouble here than in the 3.0 line;
 * this is where the library's version branches actually differ.
 *
 * NO Profile_Offset patch, and that is measured rather than assumed:
 * `git show 0dc7cf0:password/password.cpp` declares the extern `uint8_t` in
 * BOTH places. The disagreement that breaks the 3.0 line was introduced after
 * this release, so applying the patch here would find no pattern and fail -
 * correctly.
 */
module.exports = {
  version: 'v2.1.1',
  pins: { libraries: '0dc7cf0', 'OnlyKey-Firmware': '0fe8d3a' },
  status: 'untried',

  notes: [
    'Probed, never staged. 8/8 version-pinned patterns match - including the',
    'four flash-layout defines, which match only because stage.js stopped',
    'carrying the trailing `//22528 - 23551` comment in its pattern. The 2.1',
    'line writes that define without it.',
    'Profile_Offset is already uint8_t in both places at 0dc7cf0.',
  ].join('\n'),

  patches: [],
};
