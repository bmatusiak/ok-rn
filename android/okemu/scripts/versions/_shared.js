'use strict';
/*
 * Stage patches that MORE THAN ONE release needs.
 *
 * A version script imports what it needs from here by name, so a fix written
 * once is applied identically everywhere it belongs - and, just as important,
 * is NOT applied to a release that was measured not to need it. Nothing in this
 * file is applied automatically.
 *
 * Everything here obeys the same rule as stage.js's own PATCHES: the minimum to
 * make the firmware COMPILE hosted, never to improve it or change its protocol.
 * Where the current sources already solve the same problem, the fix here copies
 * theirs, so behaviour does not differ by version.
 */

/**
 * `Profile_Offset` is declared twice in one translation unit with two different
 * types - `int` in profile1hashevaluate() and `uint8_t` in
 * profile2hashevaluate(). okcore.cpp DEFINES it as `int`, so both spellings
 * cannot be right, and clang rejects the disagreement outright. The Teensy
 * toolchain that shipped these releases did not.
 *
 * The CURRENT libraries checkout already fixes this, behind `#ifdef
 * OK_EMULATOR`, and its comment says why it chose `uint8_t` for both rather
 * than the `int` that matches the definition:
 *
 *   "declaring them `int` would change what the device reads back from a
 *    negative Profile_Offset (OnlyKey.ino assigns -42, seen as 214 through
 *    the uint8_t spelling)"
 *
 * So this makes the same choice. Reading a negative int through a uint8_t
 * extern yields its low byte, which is the value the device actually behaves
 * on; "correcting" it to int would be a behaviour change wearing a type fix, on
 * firmware we are supposed to run as it shipped.
 *
 * MEASURED, not guessed. `git show <pin>:password/password.cpp` at each pinned
 * commit:
 *
 *   v3.0.2  5d7ce7a   one `int`, one `uint8_t`  -> needs this
 *   v3.0.1  a27ffa6   one `int`, one `uint8_t`  -> needs this
 *   v3.0.0  5515974   one `int`, one `uint8_t`  -> needs this
 *   v2.1.1  0dc7cf0   two `uint8_t`             -> already consistent
 *   v2.1.0  8687474   two `uint8_t`             -> already consistent
 *
 * So the 2.1 line predates the disagreement and the 3.0 line introduced it.
 * Their scripts do not import this.
 */
const profileOffsetType = {
  file: 'libraries/password/password.cpp',
  edits: [
    ['\tuint8_t nonce2[32];\n\textern int Profile_Offset;',
     '\tuint8_t nonce2[32];\n\textern uint8_t Profile_Offset; /* was int - see scripts/versions/_shared.js */'],
  ],
};

module.exports = { profileOffsetType };
