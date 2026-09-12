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
    'BOOTS, PROVISIONS, DOES NOT UNLOCK. The .so links, the firmware thread',
    'runs, OKCONNECT completes, the PIN bracket sets a PIN and the next boot',
    'reports INITIALIZED. All six buttons arrive as themselves. Unlocking with',
    'that PIN then times out at 20 s, and the main loop stops answering',
    'afterwards ("button 1 still owes 10 of 10 ticks").',
    '',
    'WHAT THE CRASH WAS. The firmware thread used to die in setup() before',
    'any of that:',
    '',
    '  F libc: Fatal signal 11 (SIGSEGV), fault addr 0xe7 in (okemu-firmware)',
    '    #00 RNGClass::stir(unsigned char const*, unsigned long, unsigned int)',
    '    #01 setup',
    '',
    'The note here used to record 0x2e4 and guess at an unrebased hardware',
    'register. The two addresses are 231 and 740, and the fact that they DIFFER',
    'is the answer: they are ADC samples. The sketch writes',
    '',
    '  RNG.stir((uint8_t *)analog1, sizeof(analog1), sizeof(analog1)*2);',
    '',
    'where &analog1 was meant, so the reading is used as an address. Ten of',
    'them - two in setup(), eight more in rngloop(). The firmware fixed it',
    'itself in OnlyKey-Firmware@926b052 (2020-05-22). Patched above; see',
    'ok-rn/FINDING-the-beta-seeded-its-rng-from-an-address-that-was-a-number.md',
    '',
    'AND ONE THING IN THE HARNESS. The provisioning suite gated on',
    'capabilities.debugConsole === true. That value is a TRI-STATE and null',
    'means unknown - firmware older than the -test/-prod keyword, which is',
    'this one. Refusing on null refused exactly the old devices the bracket',
    'exists to reach, while their console output was visible in the same log.',
    'See ok-rn/FINDING-unknown-was-read-as-no-console.md.',
    '',
    'THREE THINGS HAD TO CHANGE IN THE TOOLING TO GET THIS FAR, and they are',
    'the reason this release is worth the trouble even unfinished:',
    '',
    '  * The sketch is at OnlyKey_Beta/OnlyKey_Beta.ino. stage.js took the',
    '    path from the release rather than assuming OnlyKey/OnlyKey.ino.',
    '  * onlykey.h writes `#define STD_VERSION //Define for US Version',
    '    Firmare`, where the 3.0 line has a different comment. gateDefine',
    '    compared whole lines INCLUDING the comment, so it read the define as',
    '    absent, printed a bare NaN from a broken error message, and reported',
    '    the build as TRAVEL - a different firmware with no FIDO.',
    '  * Crypto/SHA256.h and sha256/sha256.h differ only in case, and on a',
    '    Windows checkout the first one wins the include. Upstream renamed it',
    '    to SHA256_2.h later; stage.js now does that to the staged copy.',
    '',
    'THE NEXT RUNG is the unlock, and it is NOT A CRASH. Logcat across a',
    'failing unlock carries no SIGSEGV and no tombstone. It carries this:',
    '',
    '  [softkey] CPU_RESTART() - firmware thread gone, restart the app',
    '',
    'The firmware asks for a reset itself. The only CPU_RESTART on that path',
    'is the rngloop integrity check (okcore.cpp:2279) - this release is',
    'threaded',
    'with paired integrityctr1/integrityctr2 increments as glitch detection,',
    'and any imbalance left elsewhere is caught on the next pass of the main',
    'loop. On the emulator that reset ends the firmware thread, which is what',
    '"the firmware main loop is not running" reports one symptom later.',
    '',
    'Reading the PIN handler suggests a press that does not complete a valid',
    'PIN leaves ctr1 two ahead and ctr2 one - but that cannot be the whole',
    'story, or hardware would reset on the first digit too. Next measurement,',
    'named rather than guessed: print both counters at the check. See',
    'ok-rn/FINDING-the-2019-beta-restarts-itself-during-pin-entry.md',
    '',
    'WHY IT IS WORTH FINISHING. This is the only firmware whose OKCONNECT',
    'reply uses the layout node-onlykey-lib calls legacy - the public key at',
    'bytes 21..53, the version string in the clear before it. transit.js',
    'parses it and nothing real has ever answered that way, so the branch is',
    'covered by a synthetic reply and by nothing else.',
  ].join(String.fromCharCode(10)),
  patches: [rngStirsAnAddressNotAValue, rngloopStirsAddressesNotValues],
};
