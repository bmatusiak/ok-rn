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

  patches: [
    /* The 64-bit flash stride - without this the PIN never matches. */
    shared.flashWalkStride,
    /* Replies dropped when the TX queue is busy - one request after another. */
    shared.droppedTransportResponse,
    /* HW_MODEL returned a pointer into its own dead frame. */
    shared.hwModelStackBuffer,
    /* Non-void functions falling off the end - one hangs FIDO2 registration. */
    ...shared.missingReturns,
    /* byteprint() reads through a null argument on a DEBUG build. */
    shared.byteprintNullArgument,
    /* The FULLWIPE debug dump starts at page zero, which is unmapped. */
    shared.pageZeroDebugDump,
    shared.profileOffsetType,
    /*
     * EEPROM setters handed a null pointer. Fatal hosted, and the
     * failedlogins one is on the successful-login path - without this the
     * device cannot be unlocked at all. See _shared.js.
     */
    ...shared.nullSetterPointers,
    shared.wipeSlotNullSetters,
    shared.hmacChallengeModeNullSetter,
  ],

  /* Applied because a release ships with the DEBUG gate OFF - see _shared.js. */
  debugOffPatches: [shared.okconnectBufferGuard],
};
