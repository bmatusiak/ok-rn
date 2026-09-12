'use strict';
const shared = require('./_shared');

/**
 * v3.0.4 - the last release, and the version the DEVELOPMENT TREE STILL CALLS
 * ITSELF.
 *
 * That is the reason this one is worth having in the matrix. OnlyKey-Firmware
 * tags v3.0.4-prod at 9600daa, the same commit as v3.0.3-prod, and on the
 * libraries side the release is c8804e3 (2022-11-30, published 2022-12-14).
 * Everything since - the 2024 DUO challenge change and the whole 2026
 * post-quantum line - still declares 3.0.4 in onlykey.h, because nobody has
 * bumped the macro in four years.
 *
 * So the bench key reports `v3.0.4-testc` and the released firmware reports
 * `v3.0.4-prod`, and they are not remotely the same software. Pinning this is
 * what lets the matrix SHOW that rather than assert it: "no released firmware
 * has post-quantum support" is a claim about c8804e3, and until this entry
 * existed there was nothing to run it against.
 *
 * The libraries repository stops tagging at v3.0.2-prod, so this pin is
 * derived by the rule in versions/index.js - the last commit declaring the
 * version at or before the release date. c8804e3 is the only candidate before
 * 2022-12-14; the next commit declaring 3.0.4 is from 2024.
 *
 * The patch list starts as v3.0.2's, the nearest measured neighbour. Every
 * entry is mandatory, so the first stage run says which this tree no longer
 * needs.
 */
module.exports = {
  version: 'v3.0.4',
  pins: { libraries: 'c8804e3', 'OnlyKey-Firmware': '9600daa' },
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
    'The fix is NOT to move the thresholds. The development tree declares',
    '3.0.4 as well, and under OKEMU_DEBUG=1 this release reports exactly',
    'v3.0.4-testc - character for character what the bench key reports. See',
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

  /*
   * Kept from v3.0.2, and INERT here: these sources carry the DEBUG gate ON
   * already, where v3.0.2's have it off. Upstream left it enabled in the
   * committed source after 3.0.2 and turned it off when building the
   * release - the signed image declares -prod, which is that gate being
   * off. Listed anyway so a later release shipping with it off is covered
   * without anyone having to notice.
   */
  debugOffPatches: [shared.okconnectBufferGuardWithChallengeMode],

  /*
   * The release AS IT SHIPS, which is a production build.
   *
   * First recorded from a plain stage.js, which for these two leaves the
   * DEBUG gate ON - their committed sources carry it, unlike v3.0.2's. That
   * digest described a tree nobody receives: the signed image declares
   * -prod, so the release was built with the gate off. Re-recorded from
   * OKEMU_PRODUCTION=1, and the check now compares whenever the gate ends
   * up off however it got there.
   */
  expect: { digest: '916a6c70b37e' },
};
