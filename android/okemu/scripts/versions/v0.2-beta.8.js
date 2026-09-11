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
module.exports = {
  version: 'v0.2-beta.8',
  pins: { libraries: '307ba86', 'OnlyKey-Firmware': '697c4c0' },
  sketch: { dir: 'OnlyKey_Beta', file: 'OnlyKey_Beta.ino' },
  status: 'builds',
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
  notes: [
    'BUILDS, DOES NOT BOOT. The .so links and the app loads it; the firmware',
    'thread then dies immediately:',
    '',
    '  F libc: Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR),',
    '          fault addr 0x2e4 in tid ... (okemu-firmware)',
    '',
    'A read of 0x2e4 is a small absolute address - the shape of a hardware',
    'register this tree touches that the emulator has not rebased, rather',
    'than a wild pointer. rewriteSystemBlock() moves the Cortex-M block at',
    '0xE0000000 and the flash constants in okcore.h are rebased by a base',
    'patch; something below both is still dereferenced where it lies. The',
    'next step is a backtrace with symbols - the four frames are all inside',
    'libokemu.so - not another guess.',
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
    'WHY IT IS WORTH FINISHING. This is the only firmware whose OKCONNECT',
    'reply uses the layout node-onlykey-lib calls legacy - the public key at',
    'bytes 21..53, the version string in the clear before it. transit.js',
    'parses it and nothing real has ever answered that way, so the branch is',
    'covered by a synthetic reply and by nothing else.',
  ].join(String.fromCharCode(10)),
  patches: [],
};
