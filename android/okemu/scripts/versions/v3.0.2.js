'use strict';
const shared = require('./_shared');

/**
 * v3.0.2 - the newest release in ok-versions.json, and the first old version
 * taken all the way to a running, tested device.
 *
 * Every one of stage.js's shared patterns still matches here, so the 3.0 line
 * looked like a short job. It was not: this release needs THIRTEEN patches of
 * its own before it will run hosted, and each one was a defect present in the
 * shipped firmware that has been fixed upstream since. They are all in
 * _shared.js, with the measurement that found each.
 *
 * The one that mattered most is flashWalkStride. `unsigned long` is 8 bytes on
 * arm64 and 4 on the Teensy, so flash was walked at twice the stride of the
 * byte buffer beside it - and since the PIN hash goes through that path, a
 * CORRECT PIN read back as wrong. It is invisible on a 32-bit handset, which
 * is what the bench device happens to be.
 */
module.exports = {
  version: 'v3.0.2',
  pins: { libraries: '5d7ce7a', 'OnlyKey-Firmware': '7671d6f' },
  status: 'tested',

  notes: [
    'RUNS AND IS TESTED: 62 of 67 e2e tests pass, twice in a row, on a device',
    'this suite provisioned itself (0-provision sets the PIN, 9-cryptoSign the',
    'signing key and the touch-free derive preference).',
    '',
    'Stage it with OKEMU_DEBUG=1 or it cannot be provisioned at all: a RELEASE',
    'ships with the DEBUG gate off and the PIN bracket is a conversation held',
    'entirely in Serial.println (FINDING-provisioning-needs-a-debug-build.md).',
    '',
    'Five failures remain, and none is a defect in this release:',
    '  * the X-Wing key type, and the age file that uses it - KEYTYPE_XWING does',
    '    NOT EXIST at 5d7ce7a. The suite asks for a feature this firmware never',
    '    had, so the right fix is a capability gate in the library, not a patch',
    '    here.',
    '  * three vault tests, whose touch-free derive comes back as 65 bytes that',
    '    do not start 0x04. The derive suite and deriveParity both pass, and both',
    '    use the PRESS variant - so this is specific to the touch-free path and',
    '    is NOT yet explained. Open.',
    '',
    'Getting here took six hosting defects, all of them present in the release',
    'and all fixed upstream since. The one that mattered most was the 64-bit',
    'flash stride: it made a correct PIN read back as wrong, and it is invisible',
    'on a 32-bit handset. See _shared.js for each.',
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

  /**
   * The staged tree AS THIS RELEASE SHIPS - no gate override. OKEMU_DEBUG=1
   * and OKEMU_PRODUCTION=1 both change four files, so the comparison is
   * skipped when either is set rather than reporting a change every time.
   */
  expect: { digest: 'b0659bf14277' },
};
