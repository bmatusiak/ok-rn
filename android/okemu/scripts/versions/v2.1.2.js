'use strict';

/**
 * v2.1.2 - BLOCKED, and the missing commit is on a BRANCH, not missing by
 * accident.
 *
 * ok-versions.json pins libraries@12eb5b0 and `git cat-file -e` fails on it, so
 * nothing about this release can be measured: not the patches, not a build, not
 * a boot.
 *
 * That pin is RIGHT. Upstream tags its releases, and
 * `libraries` tag `v2.1.2-prod` points at exactly 12eb5b0 - the local checkouts
 * are forks with no tags, which is why it took the GitHub API to see it. The
 * release was cut from the branch `remove-touchsense`, not from master, which
 * is the whole reason a fork of master does not carry the commit.
 *
 * This file briefly said something else. It was repinned to `8f74eac` on the
 * reasoning that 12eb5b0 "is not one of the three commits that declare 2.1.2"
 * and that the pin should be the last commit of that range. Both halves were
 * wrong: the range rule was a guess read off three rows that happened to agree,
 * and the tags settle it directly. The pin is back to what it was.
 *
 * TO UNBLOCK: fetch the branch the release was cut from, in the `libraries`
 * checkout. That adds objects and leaves the working tree alone, but it is a
 * read-only reference checkout, so it needs asking first.
 *
 *     git -C ../libraries fetch origin remove-touchsense
 *     git -C ../libraries fetch origin tag v2.1.2-prod
 *
 * Then set status to 'untried' and run stage.js. `OnlyKey-Firmware@bbb910a` is
 * already present and also matches its tag.
 */
module.exports = {
  version: 'v2.1.2',
  pins: { libraries: '12eb5b0', 'OnlyKey-Firmware': 'bbb910a' },
  status: 'blocked',

  notes: [
    'libraries@12eb5b0 is absent from the local checkout - `git cat-file -e`',
    'fails. OnlyKey-Firmware@bbb910a is present and matches its tag.',
    '',
    'The pin is confirmed correct: upstream tag v2.1.2-prod IS 12eb5b0. The',
    'release was cut from the branch remove-touchsense rather than master,',
    'so a fork of master does not have it. Fetch that branch to unblock.',
  ].join('\n'),

  patches: [],
};
