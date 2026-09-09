'use strict';
const shared = require('./_shared');

/**
 * v3.0.2 - the newest release in ok-versions.json, and the first old version
 * taken all the way to a running device.
 *
 * The 3.0 line is close enough to the working tree that every one of stage.js's
 * eight version-pinned patterns still matches (scripts/version-probe.js). The
 * one thing it needs on top is the Profile_Offset type disagreement, which the
 * current libraries checkout has already fixed behind `#ifdef OK_EMULATOR` and
 * these sources have not.
 */
module.exports = {
  version: 'v3.0.2',
  pins: { libraries: '5d7ce7a', 'OnlyKey-Firmware': '7671d6f' },
  status: 'boots',

  notes: [
    'stage.js completes: 12 firmware files, 352 library files, 17 patches.',
    ':okemu:externalNativeBuildDebug links libokemu.so for every ABI.',
    'On a Pixel it starts and completes OKCONNECT:',
    '  okemu   : firmware started, storage=/data/user/0/com.okrn/files/okemu',
    '  softkey : OKCONNECT ok: "INITIALIZED"',
    'OKCONNECT is the pass condition rather than "it booted" - it performs the',
    'NaCl key exchange, so it exercises the flash mapping that a bad rebase',
    'leaves broken until the first time the device encrypts anything.',
    '',
    'NOT YET tested: the e2e suite has not produced a readable result against',
    'this version. The one attempt ran against a flash.bin written by v3.0.4,',
    'before per-version state existed, so it would not have measured v3.0.2',
    'either way.',
  ].join('\n'),

  patches: [shared.profileOffsetType],

  /* The staged tree this version's notes above were measured against. */
  expect: { digest: 'b5ccd3d568f1' },
};
