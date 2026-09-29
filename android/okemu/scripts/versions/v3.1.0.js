/*
 * v3.1.0 - the proposed release, treated like the signed release, for the Android build.
 *
 * trustcrypto/libraries PR #33 and trustcrypto/OnlyKey-Firmware PR #183,
 * branch release-3.1.0, one squashed commit each, pinned in
 * node-onlykey-lib/versions at their heads (2026-09-28). Not tagged yet:
 * re-pin here and in the library when the PRs move or the tag lands - the
 * cross-check in versions/index.js refuses a script whose `pins` disagree.
 *
 * 3.1.0 re-indented and re-spaced the sources; with the two re-spaced lines
 * listed as alternative spellings in stage.js the working-tree patch set
 * applies unchanged (the working tree staged as 3.1.0: 17 literal patches, no
 * warnings) - which is why this spreads working-tree. It ships with the DEBUG
 * gate OFF, and it does NOT carry the CTAPHID wipe fix (0c-coder/libraries
 * #20) - bm-ok's libraries master is this release plus that fix.
 *
 * 'untried' on Android until the e2e matrix builds and runs it here.
 * node-onlykey-emulator's matrix built this SIGNED release on Linux and passed
 * stage, build, press and compat (2026-09-28).
 */
'use strict';

const workingTree = require('./working-tree');

module.exports = {
  ...workingTree,
  version: 'v3.1.0',
  pins: { libraries: 'eb25290', 'OnlyKey-Firmware': '9fceea1' },
  status: 'untried',
  slot: 'v3.1.0',
  notes: [
    'The release candidate: trustcrypto release-3.1.0 (libraries PR #33,',
    'OnlyKey-Firmware PR #183), pinned at the PR heads eb25290 / 9fceea1.',
    'Stages with the working-tree patch set. Ships DEBUG off. Lacks the',
    'CTAPHID wipe fix (0c-coder/libraries #20).',
  ].join('\n'),
};
