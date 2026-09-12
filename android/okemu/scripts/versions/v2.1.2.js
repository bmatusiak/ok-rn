'use strict';

/**
 * v2.1.2 - the pin was right all along, and it was on a BRANCH.
 *
 * ok-versions.json pins libraries@12eb5b0, and for most of this project's life
 * `git cat-file -e` failed on it, so nothing about this release could be
 * measured: not the patches, not a build, not a boot.
 *
 * The pin was never wrong. Upstream tags its releases, and `libraries` tag
 * `v2.1.2-prod` points at exactly 12eb5b0. The local checkouts are FORKS of
 * master with no tags, which is why it took the GitHub API to see it, and the
 * release was cut from the branch `remove-touchsense` rather than from master
 * - which is the whole reason a fork of master does not carry the commit.
 *
 * This file briefly said something else. It was repinned to `8f74eac` on the
 * reasoning that 12eb5b0 "is not one of the three commits that declare 2.1.2"
 * and that the pin should be the last commit of that range. Both halves were
 * wrong: the range rule was a guess read off three rows that happened to
 * agree, and the tags settle it directly. The pin is back to what it was.
 *
 * UNBLOCKED 2026-09-12, with the user's word, by fetching the branch upstream
 * cut it from. The fork's `origin` is bm-ok/0c-coder-libraries; the original
 * is trustcrypto, so that went in as a second remote:
 *
 *     git -C ../libraries remote add trustcrypto https://github.com/trustcrypto/libraries
 *     git -C ../libraries fetch trustcrypto remove-touchsense
 *
 * Objects only. `libraries` stayed on master with a clean working tree, which
 * is what makes this compatible with it being a read-only reference checkout.
 * `OnlyKey-Firmware@bbb910a` was already present and also matches its tag.
 */
module.exports = {
  version: 'v2.1.2',
  pins: { libraries: '12eb5b0', 'OnlyKey-Firmware': 'bbb910a' },
  status: 'boots',

  notes: [
    'The pin is confirmed correct: upstream tag v2.1.2-prod IS 12eb5b0. The',
    'release was cut from the branch remove-touchsense rather than master, so',
    'a fork of master did not have it. Fetched from the trustcrypto remote on',
    '2026-09-12 and the commit now resolves.',
    '',
    'STAGES, BUILDS AND BOOTS with no version patches at all - the eighteen',
    'shared literal patches are enough, which no other 2.x release manages.',
    'It completes OKCONNECT and answers the vendor interface throughout.',
    '',
    'IT CANNOT BE UNLOCKED, and that is the whole reason it is not tested.',
    'Provisioning completes every step of the firmware\'s own PIN bracket -',
    'armed, entered, stored, confirming, re-entered, committed - both entries',
    '1234561, and the device reports INITIALIZED afterwards. Entering that',
    'same PIN never unlocks it. Three production runs and one deliberate',
    'debug build, identical each time: bails after deviceFlow, 10 passed,',
    '3 failed.',
    '',
    'Ruled out by measurement, not by reasoning: stale flash (the slot was',
    'deleted and it provisioned itself from nothing), the button mapping',
    '(buttonProbe on the same build: all six buttons arrive as themselves),',
    'the production gate (it fails on debug too), the 2.1 line (v2.1.0 as',
    'production unlocks on the first try), and the touch threshold this',
    'release changed (the HAL reports 1000 idle / 6000 held, which clears the',
    'old fixed +40 and the new proportional one alike).',
    '',
    'AND IT IS PROBABLY OURS, NOT THE RELEASE. A signed Signed_OnlyKey_2_1_2',
    '_STD image exists and its own string table declares v2.1.2-prod, so this',
    'release SHIPPED - and a firmware nobody can unlock would have been caught',
    'by its first user. The two live candidates are the staging (this is the',
    'only 2.x release that needs no version patches, and "needs none" looks',
    'exactly like "needs one nobody found") and the OnlyKey-Firmware half of',
    'the pin, which no tag verifies.',
    '',
    'See ok-rn/FINDING-v2.1.2-sets-a-pin-it-will-not-accept.md for the next',
    'measurement worth taking.',
  ].join('\n'),

  patches: [],
};
