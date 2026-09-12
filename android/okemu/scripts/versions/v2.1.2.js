'use strict';

/**
 * v2.1.2 - and the pin it was blocked on was never a 2.1.2 commit.
 *
 * This file used to say BLOCKED: ok-versions.json pinned libraries@12eb5b0,
 * `git cat-file -e` failed on it, and the conclusion drawn was that the fork
 * did not carry every commit upstream released from. The advice was to fetch
 * and confirm.
 *
 * Reading the version out of every commit's onlykey.h says otherwise. Exactly
 * three commits declare 2.1.2 - de9b78e, d285d8b and 8f74eac - and all three
 * are present. 12eb5b0 is not among them, so the fetch would have found
 * nothing to the point: it is not that the commit is missing, it is that it
 * was the wrong thing to look for.
 *
 * The pin is now `8f74eac` (2021-11-23, "cleanup"), the last of the three,
 * which is the rule the 3.0.x pins follow - see versions/index.js. It fits a
 * second way: the v2.1.1 pin `0dc7cf0` is also a commit called "cleanup", in
 * the same position of the same cycle by the same author.
 *
 * The other two cannot be told apart from it on the build staged here. Their
 * diffs against 8f74eac are Serial.println lines moving in and out of DEBUG
 * blocks, and a production image compiles those out, so the released 2.1.2
 * image cannot say which of the three it came from. Recorded rather than
 * guessed at.
 *
 * `OnlyKey-Firmware@bbb910a` is unchanged and was always right: it is the last
 * sketch commit before the 2.1.3 version bump.
 *
 * The patch list starts EMPTY, as versions/index.js describes: run stage.js,
 * read what it names, add the one patch that fixes it, run again. v2.1.1 is
 * the nearest neighbour and its list is the first place to look when one is
 * needed.
 */
module.exports = {
  version: 'v2.1.2',
  pins: { libraries: '8f74eac', 'OnlyKey-Firmware': 'bbb910a' },
  status: 'untried',

  notes: [
    'UNBLOCKED BY CORRECTING THE PIN, not by fetching anything. The old pin',
    'libraries@12eb5b0 is not one of the three commits that declare 2.1.2 -',
    'de9b78e, d285d8b, 8f74eac - and all three are in the checkout.',
    '',
    'Pinned to 8f74eac, the last of them, per the rule in versions/index.js.',
    'The other two differ from it only in DEBUG prints, which a -prod image',
    'compiles out, so the signed release cannot say which one it came from.',
    '',
    'Not yet staged. Nothing below has been measured.',
  ].join('\n'),

  patches: [],
};
