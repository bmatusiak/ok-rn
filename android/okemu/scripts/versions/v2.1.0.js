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
  status: 'tested',

  notes: [
    'RUNS AND FULLY PASSES: 67 of 67. The furthest-back release works, so the',
    'whole matrix is reachable.',
    '',
    'Unlike the 3.0 line it ships with the DEBUG gate ON, so OKEMU_DEBUG=1',
    'changes nothing here.',
    '',
    'Three differences from the newer firmware, all of them fixed by knowing',
    'about them rather than by patching:',
    '  * A PRESS-REQUIRED derive BLOCKS. ctap_user_presence_test(5000) waits',
    '    five seconds with no keepalive and then denies, where the 3.0 line',
    '    returns CTAP2_ERR_PROCESSING and lets the host keep polling. A host',
    '    that presses only when asked never presses at all. This is',
    '    capabilities().presenceTest, and the suite presses on a timer for it.',
    '  * A request issued immediately after another one is DROPPED. The first',
    '    key write produced no answer and no console output; the same write',
    '    1.5s later succeeded. device.loadKey now waits for its acknowledgement',
    '    and retries, which every other command in that plugin already did.',
    '  * It has no sess_counter or may_block. Those are newer firmware globals',
    '    that our own core-override references, and v2.1.0 writes the same two',
    '    constants inline instead - see okemu_usb.cpp, which now defines them',
    '    weakly so it links against either.',
    '',
    'INTERMITTENT: one run in this pair failed a single vault test with "the',
    'device did not answer this derive" and the next passed. The derive retry',
    'covers most of it; a residual flake on back-to-back derives is not yet',
    'explained and is recorded rather than dismissed.',
  ].join(String.fromCharCode(10)),

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
