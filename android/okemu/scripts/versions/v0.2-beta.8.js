'use strict';

const shared = require('./_shared');

/**
 * v0.2-beta.8 - the 2019 beta line, and the only firmware whose OKCONNECT
 * reply uses the layout the library calls 'legacy'.
 *
 * WHY IT IS WORTH REACHING FOR. Every other release in the matrix answers
 * OKCONNECT with the device public key at bytes 0..32. This one - it
 * defines `OKversion "v0.2-beta.8c"` at OnlyKey_Beta.ino:135 - puts it at
 * 21..53 with the version string in the clear before it, and the web app
 * has branched on that string since it was written
 * (onlykey-api.js:168-198). node-onlykey-lib learned to parse it in
 * transit.js and could not verify the branch against anything real,
 * because until this pin existed the matrix went back only to v2.1.0.
 *
 * WHAT IS DIFFERENT ABOUT STAGING IT. The sketch is at
 * OnlyKey_Beta/OnlyKey_Beta.ino rather than OnlyKey/OnlyKey.ino - a
 * different directory and a different file name - which is why stage.js
 * takes a `sketch` from the release rather than assuming one. Its library
 * pin has okcore, okcrypto, okeeprom and onlykey.h and no okpqc or
 * utility/, which is expected for 2019 and not by itself a problem: the
 * PQC paths are compiled from the newer tree or not at all.
 *
 * The patch list starts EMPTY on purpose. Every entry in _shared.js was
 * written against a specific line of a specific release, and guessing that
 * a 2019 tree needs the same ones would produce a pile of patches that
 * fail to apply and say nothing about why. The way this is meant to go is
 * the way the rungs in versions/index.js describe: run stage.js, read what
 * it names, add the one patch that fixes it, run again. Each rung is
 * something somebody watched happen.
 */
/*
 * THE SKETCH SEEDS ITS RNG FROM AN ADDRESS THAT IS A READING.
 *
 *   unsigned int analog1 = analogRead(ANALOGPIN1);
 *   RNG.stir((uint8_t *)analog1, sizeof(analog1), sizeof(analog1)*2);
 *
 * `analog1` is the sample, not a buffer. The cast turns a number between 0
 * and 1023 into a pointer and stir() reads four bytes from it. On a Teensy
 * that address is inside mapped flash, so it returns the same four bytes of
 * the device's own program image every boot - the seeding is wrong in a way
 * that still produces plausible output, which is why it shipped. On Android
 * the page is unmapped and the firmware thread dies in setup().
 *
 * The two fault addresses this was seen at, 0xe7 and 0x2e4, are 231 and 740.
 * They differ between runs because they are ADC samples, and that is what
 * identified the cast rather than the unrebased hardware register the notes
 * first suspected.
 *
 * Fixed by the firmware itself in OnlyKey-Firmware@926b052 (2020-05-22), the
 * commit that renamed the sketch: `RNG.stir((uint8_t *)&analog1, 2, 4)`. The
 * length drops to 2 because the reading is 16-bit after
 * analogReadResolution(16), and the entropy credit halves with it. This
 * patch takes only the ADDRESS, leaving the length and the credit as the
 * beta had them - the crash is the cast, and rewriting the rest would be
 * this repository deciding how much entropy a 2019 release was entitled to
 * claim.
 *
 * Version-local, not shared: no other release in the matrix contains the
 * line. See ok-rn/FINDING-the-beta-seeded-its-rng-from-an-address-that-was-a-number.md
 */
const rngStirsAnAddressNotAValue = {
  /* Staged under the canonical name, whatever the release called it. */
  file: 'sketch/OnlyKey.ino',
  edits: [
    ['RNG.stir((uint8_t *)analog1, sizeof(analog1), sizeof(analog1)*2);',
     'RNG.stir((uint8_t *)&analog1, sizeof(analog1), sizeof(analog1)*2);'],
    ['RNG.stir((uint8_t *)analog2, sizeof(analog2), sizeof(analog2)*2);',
     'RNG.stir((uint8_t *)&analog2, sizeof(analog2), sizeof(analog2)*2);'],
  ],
};

/*
 * THE SAME CAST, EIGHT MORE TIMES, IN THE LOOP THAT RUNS FOREVER.
 *
 * rngloop() stirs every touch pad and both analog pins into the pool on
 * every pass, and every one of them casts the READING to a pointer. The
 * sketch's two in setup() are only where it is reached first; this is where
 * it would have kept happening.
 *
 * Same fix, same reason, and the same upstream: today's okcore.cpp writes
 * `RNG.stir((uint8_t *)&analog1, 2, 2)`. Address only - the lengths and
 * credits stay as the beta had them.
 */
const rngloopStirsAddressesNotValues = {
  file: 'libraries/onlykey/okcore.cpp',
  edits: [
    ['RNG.stir((uint8_t *)analog1, sizeof(analog1), sizeof(analog1) * 4);',
     'RNG.stir((uint8_t *)&analog1, sizeof(analog1), sizeof(analog1) * 4);'],
    ['RNG.stir((uint8_t *)touchread1, sizeof(touchread1), sizeof(touchread1));',
     'RNG.stir((uint8_t *)&touchread1, sizeof(touchread1), sizeof(touchread1));'],
    ['RNG.stir((uint8_t *)touchread2, sizeof(touchread2), sizeof(touchread2));',
     'RNG.stir((uint8_t *)&touchread2, sizeof(touchread2), sizeof(touchread2));'],
    ['RNG.stir((uint8_t *)touchread3, sizeof(touchread3), sizeof(touchread3));',
     'RNG.stir((uint8_t *)&touchread3, sizeof(touchread3), sizeof(touchread3));'],
    ['RNG.stir((uint8_t *)touchread4, sizeof(touchread4), sizeof(touchread4));',
     'RNG.stir((uint8_t *)&touchread4, sizeof(touchread4), sizeof(touchread4));'],
    ['RNG.stir((uint8_t *)touchread5, sizeof(touchread5), sizeof(touchread5));',
     'RNG.stir((uint8_t *)&touchread5, sizeof(touchread5), sizeof(touchread5));'],
    ['RNG.stir((uint8_t *)touchread6, sizeof(touchread6), sizeof(touchread6));',
     'RNG.stir((uint8_t *)&touchread6, sizeof(touchread6), sizeof(touchread6));'],
    ['RNG.stir((uint8_t *)analog2, sizeof(analog2), sizeof(analog2) * 4);',
     'RNG.stir((uint8_t *)&analog2, sizeof(analog2), sizeof(analog2) * 4);'],
  ],
};

/**
 * The 32-bit flash stride, spelled for the 2019 tree.
 *
 * IDENTICAL IN KIND to `_shared.js:flashWalkStride`, which every 2.x and 3.x
 * script imports and whose comment reads "without this the PIN never
 * matches". It cannot simply be imported here: this release predates the
 * rename, so its functions are `onlykey_flashget_common` /
 * `onlykey_flashset_common` where later ones are `okcore_*`, and stage.js
 * refuses a literal that does not match.
 *
 * Kept version-local rather than added to _shared.js on that file's own rule:
 * it holds patches MORE THAN ONE release needs, and exactly one release uses
 * this spelling.
 *
 * WHY IT IS ALMOST CERTAINLY WHAT AILS THIS RELEASE. v2.1.2 was staged with
 * an empty patch list and showed precisely the symptom recorded below -
 * boots, provisions, reports INITIALIZED, every button arrives as itself, and
 * the unlock times out. Dumping flash.bin off the phone showed the nonce and
 * the PIN hash present at the right offsets with every other 32-bit word
 * missing, because `unsigned long` is 8 bytes on a 64-bit host and the walk
 * advances twice as far as the byte buffer beside it. Importing the shared
 * list took that release from blocked to 87 passed.
 * ok-rn/FINDING-v2.1.2-sets-a-pin-it-will-not-accept.md
 */
const flashWalkStride2019 = {
  file: 'libraries/onlykey/okcore.cpp',
  edits: [
    ['void onlykey_flashget_common(uint8_t *ptr, unsigned long *adr, int len)\n{\n',
     'void onlykey_flashget_common(uint8_t *ptr, unsigned long *adr_in, int len)\n{\n' +
     '\t/* Injected by ok-rn stage.js - see scripts/versions/v0.2-beta.8.js.\n' +
     '\t   unsigned long is 8 bytes on a 64-bit host, which walks flash at\n' +
     '\t   twice the stride of the byte buffer beside it. */\n' +
     '\tuint32_t *adr = (uint32_t *)adr_in;\n'],
    ['void onlykey_flashset_common(uint8_t *ptr, unsigned long *adr, int len)\n{\n',
     'void onlykey_flashset_common(uint8_t *ptr, unsigned long *adr_in, int len)\n{\n' +
     '\t/* Same 32-bit stride as onlykey_flashget_common above. */\n' +
     '\tuint32_t *adr = (uint32_t *)adr_in;\n'],
  ],
};

module.exports = {
  version: 'v0.2-beta.8',
  pins: { libraries: '307ba86', 'OnlyKey-Firmware': '697c4c0' },
  sketch: { dir: 'OnlyKey_Beta', file: 'OnlyKey_Beta.ino' },
  /*
   * Base patches whose patterns this 2019 tree does not contain. Declared
   * rather than silently skipped, and stage.js throws if one of them turns
   * out to be present after all.
   *
   *   factorysectoradr   arrived after this release; okcore.h has
   *                      fwstartadr, flashstorestart and flashend, which
   *                      are rebased as usual, and no factory sector at all.
   *   the ctap_parse.cpp CBOR span - this release predates that line in the
   *                      fido2 library; the file is there, the cast is not.
   */
  absentPatterns: [
    '#define factorysectoradr 0x5800',
    'uint32_t length = (uint32_t)end_byte - (uint32_t)start_byte;',
  ],
  status: 'boots',
  notes: [
    'BOOTS, PROVISIONS, DOES NOT UNLOCK - and the reason is now half known.',
    '',
    'THE FLASH STRIDE IS FIXED. This release carried no shared patches at all,',
    'so it never got flashWalkStride - the fix whose own comment in _shared.js',
    'reads "without this the PIN never matches". It could not simply be',
    'imported: this tree predates the rename, so its walkers are',
    'onlykey_flashget_common / onlykey_flashset_common where every later',
    'release has okcore_*. A version-local copy is above.',
    '',
    'PROVED BY THE ARTEFACT, not by reading. flash.bin pulled off the phone',
    'after a provision now shows a contiguous 64-byte run at sector 118 +0 -',
    'the nonce and the PIN hash written whole. v2.1.2 without this patch wrote',
    'four bytes and skipped four, all the way down, and that was exactly why',
    'it stored a PIN it then refused.',
    '',
    'WHAT IS STILL WRONG. With the flash correct the failure MOVED rather than',
    'went away. It used to time out at 20 s on the unlock and carry on; now',
    'the app leaves the screen during PIN entry, always after the sixth press',
    'and before the seventh completes 1234561. Three runs, identical.',
    '',
    'Ruled out so far: no SIGSEGV, no tombstone, no abort in logcat, and the',
    'AIRCR trap never fires - so this is NOT the CPU_RESTART path that',
    'FINDING-cpu-restart-writes-to-unmapped-memory.md covers, and',
    'CPU_RESTART_ADDR is correctly rebased in the staged tree.',
    '',
    'Next measurement: capture logcat across the sixth press with the firmware',
    'thread named, and find out whether the process dies or is merely',
    'backgrounded. The distinction decides whether this is the firmware, the',
    'HAL, or the runner.',
  ].join(String.fromCharCode(10)),
  patches: [
    flashWalkStride2019,
    rngStirsAnAddressNotAValue,
    rngloopStirsAddressesNotValues,
  ],
};
