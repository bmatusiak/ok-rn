'use strict';

/**
 * v2.1.2 - BLOCKED. ok-versions.json pins libraries@12eb5b0 and that object is
 * not in the local checkout, so nothing about this release can be measured:
 * not the patches, not a build, not a boot.
 *
 * The checkout is a fork, and a fork does not necessarily carry every commit
 * the release list names. `d285d8b` ("testing 2.1.2") is a CANDIDATE and is
 * deliberately not used - substituting a commit that merely looks right would
 * make every result attributed to v2.1.2 a result for something else, which is
 * worse than having none.
 *
 * To unblock: fetch the upstream `libraries` remote and confirm 12eb5b0 is a
 * commit there. Then set status to 'untried' and run stage.js.
 */
module.exports = {
  version: 'v2.1.2',
  pins: { libraries: '12eb5b0', 'OnlyKey-Firmware': 'bbb910a' },
  status: 'blocked',

  notes: [
    'libraries@12eb5b0 is absent from the local checkout - `git cat-file -e`',
    'fails. OnlyKey-Firmware@bbb910a is present.',
    'Not substituted with d285d8b "testing 2.1.2", which is only a candidate.',
  ].join('\n'),

  patches: [],
};
