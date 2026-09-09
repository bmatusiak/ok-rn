'use strict';
const shared = require('./_shared');

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
    /*
     * EEPROM setters handed a null pointer - fatal hosted. See _shared.js.
     * NO hmac_challengemode and NO wipe_slot entries: both were measured
     * absent at 8687474 by version-probe.js. This release has the sketch and
     * timeout sites and nothing else.
     */
    ...shared.nullSetterPointers,
  ],

  /* Applied because a release ships with the DEBUG gate OFF - see _shared.js. */
  debugOffPatches: [shared.okconnectBufferGuard],
};
