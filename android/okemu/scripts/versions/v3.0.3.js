'use strict';
const shared = require('./_shared');

/**
 * v3.0.3 - one cycle on from v3.0.2, and the first release with no libraries
 * tag to pin it by.
 *
 * OnlyKey-Firmware tags v3.0.3-prod at 9600daa, which is also where
 * v3.0.4-prod points: the sketch did not change between the two releases, so
 * everything that distinguishes them is on the libraries side.
 *
 * And the libraries repository stops tagging at v3.0.2-prod. So this pin is
 * derived rather than read, by the rule in versions/index.js - the last commit
 * declaring the version at or before the release date. v3.0.3 was published on
 * 2022-11-08; a133bea "testing release" is 2022-11-04; the next commit
 * declaring 3.0.3 is 9c99922 on 2022-11-26, which is after the release and
 * therefore cannot be in it. That rule reproduces all seven tagged libraries
 * pins, which is the only reason to trust it here.
 *
 * The patch list starts as v3.0.2's, because that is the nearest measured
 * neighbour and a133bea is two commits later. Every entry is mandatory - a
 * pattern that does not match is an error, not a shrug - so the first stage
 * run says which of these this tree no longer needs, and `absentPatterns` is
 * where a deliberate gap gets declared.
 */
module.exports = {
  version: 'v3.0.3',
  pins: { libraries: 'a133bea', 'OnlyKey-Firmware': '9600daa' },
  status: 'tested',

  notes: [
    'RUNS AND NEARLY PASSES: 60 passed, 5 failed, 3 skipped, on a device the',
    'suite provisioned itself. It boots, completes OKCONNECT, takes a PIN,',
    'unlocks, types slots, loads and uses a signing key, and answers CTAPHID.',
    '',
    'ALL FIVE FAILURES ARE THE LIBRARY, NOT THIS FIRMWARE. Two capability',
    'fields in version.js guess about the release after v3.0.2, and this is',
    'that release:',
    '',
    '  touchFreeDerive  claims "preference", measured BROKEN. The preference',
    '                   is written to EEPROM and the derive still demands a',
    '                   press, so the three vault tests get no answer at all.',
    '  postQuantum      claims true from v3.0.3, measured FALSE. X-Wing and',
    '                   the age file run instead of skipping, and fail.',
    '',
    'Confirmed separately from the sweep: rebuilt alone and run with',
    '--no-bail --only derive against the EEPROM that already had the',
    'preference set, reproducing all five.',
    '',
    'The fix is NOT to move the thresholds. The development tree still',
    'declares 3.0.4, so no threshold can separate it from released 3.0.4',
    'without breaking one of them. See',
    'ok-rn/FINDING-two-capability-guesses-about-the-next-release-were-both-wrong.md',
    '',
    'Stage it with OKEMU_DEBUG=1 or it cannot be provisioned at all.',
  ].join(String.fromCharCode(10)),

  /* v3.0.2's list. Every one still applies here - measured, not assumed. */
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
  debugOffPatches: [shared.okconnectBufferGuardWithChallengeMode],
};
