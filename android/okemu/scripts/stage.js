#!/usr/bin/env node
/*
 * stage.js - assemble the firmware compile tree for the Android build.
 *
 * Adapted from node-onlykey-emulator/emulator/scripts/stage.js, which mirrors
 * arduino-1.6.5-r5-teensy_127/in-docker-build.sh: build by COPYING everything
 * into a scratch Arduino tree rather than compiling in place.
 *
 *     cp OnlyKey-Firmware/*.c *.h  -> core/        (shadows core files)
 *     cp libraries/*               -> libraries/
 *
 * Nothing in the component checkouts beside this repo is ever written to. They
 * are read, copied, and patched in the copy.
 *
 * WHY THIS FILE DIVERGES FROM THE EMULATOR'S
 *
 * The Node emulator runs on x86_64 Linux and maps the Kinetis peripheral
 * windows at their real addresses, so kinetis.h works unmodified. Android
 * cannot do that:
 *
 *   1. 0xE0000000 (the Cortex-M system block) is above the 3 GB user/kernel
 *      split on 32-bit ARM, so it is unmappable - not merely inconvenient.
 *      Samsung ships a 32-bit-only build on some supported handsets.
 *   2. vm.mmap_min_addr is 0x8000 on Android and an unprivileged app cannot
 *      lower it, so the flash window cannot be mapped at 0.
 *
 * Both are handled by patching the STAGED copy, which is the same lever the
 * emulator already uses for the core's Cortex-M inline assembly. See PATCHES.
 *
 * Layout produced (all under .stage/, all disposable):
 *   .stage/core/       teensy3 core + OnlyKey USB stack + our overrides
 *   .stage/libraries/  OnlyKey's vendored Arduino libraries
 *   .stage/sketch/     OnlyKey.ino
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OKEMU = path.resolve(__dirname, '..');
/* okemu -> android -> ok-rn -> the checkouts root holding every component. */
const CHECKOUTS = path.resolve(OKEMU, '..', '..', '..');

const ARDUINO = path.join(CHECKOUTS, 'arduino-1.6.5-r5-teensy_127', 'arduino-1.6.5-r5');
const CORE_SRC = path.join(ARDUINO, 'hardware', 'teensy', 'avr', 'cores', 'teensy3');
const TLIB = path.join(ARDUINO, 'hardware', 'teensy', 'avr', 'libraries');
/*
 * The two VERSION-PINNED trees.
 *
 * `let`, not `const`, because OKEMU_VERSION repoints them at a released
 * commit's sources instead of the working tree - see materialiseVersion().
 * Everything downstream reads these and needs no idea which it got.
 */
let FW = path.join(CHECKOUTS, 'OnlyKey-Firmware');
let LIB_SRC = path.join(CHECKOUTS, 'libraries');

/** Where a pinned version's sources are unpacked, cached between builds. */
const VERSION_CACHE = path.join(OKEMU, '.stage-src');
const OVERRIDE = path.join(OKEMU, 'core-override');

const STAGE = path.join(OKEMU, '.stage');
const STAGE_CORE = path.join(STAGE, 'core');
const STAGE_LIB = path.join(STAGE, 'libraries');
const STAGE_SKETCH = path.join(STAGE, 'sketch');

/*
 * Bare-metal files with no host equivalent. Each is either superseded by a
 * file in core-override/ or simply not compiled. Same list as the emulator's.
 */
const DROP = [
  'mk20dx128.c',        // reset handler, vector table, clock init
  'pins_teensy.c',      // -> core-override/okemu_pins.cpp (systick, GPIO)
  'analog.c',           // -> core-override/okemu_pins.cpp
  'touch.c',            // -> core-override/okemu_pins.cpp (buttons)
  'eeprom.c',           // -> core-override/okemu_eeprom.cpp (file-backed)
  'usb_dev.c',          // -> core-override/okemu_usb.cpp
  'usb_rawhid.c',       //    "
  'usb_keyboard.c',     //    "
  'usb_seremu.c',       //    "
  'usb_serial.c',       //    "
  'usb_mem.c',          // USB endpoint buffer allocator
  'usb_mouse.c', 'usb_joystick.c', 'usb_midi.c', 'usb_flightsim.c', 'usb_mtp.c',
  'serial1.c', 'serial2.c', 'serial3.c',
  'HardwareSerial1.cpp', 'HardwareSerial2.cpp', 'HardwareSerial3.cpp',
  'IntervalTimer.cpp',  // ARM NVIC periodic interrupt
  'DMAChannel.cpp',
  'AudioStream.cpp',
  'Tone.cpp',
  'avr_emulation.cpp',
  'ser_print.c',
  'math_helper.c',
  'memcpy-armv7m.S',
  'main.cpp',           // Arduino main(); the JNI layer drives setup()/loop()
  'Makefile',
];

/*
 * Literal fixups applied to STAGED copies only.
 *
 * The emulator keeps exactly one of these on principle: anything the FIRMWARE
 * needs in order to run hosted lives in the OnlyKey sources under
 * `#ifdef OK_EMULATOR`. We cannot follow that rule here, because
 * OnlyKey-Firmware and libraries/ are outside this project's write scope. So
 * where the emulator would add an #ifdef upstream, we patch the copy and say
 * so. Each entry below records what it would have been instead.
 */
/**
 * WHICH SIDE OF THE DEBUG GATE this build is on.
 *
 *     OKEMU_PRODUCTION=1   force it OFF, the way the firmware ships
 *     OKEMU_DEBUG=1        force it ON, so the device can be provisioned
 *     neither              leave the sources as they are, and say which
 *
 * ## It is not a compiler flag
 *
 * `#define DEBUG` is at onlykey.h:81 - in the firmware SOURCE, not a build
 * option we can pass. -UDEBUG cannot undefine what a header defines. So the
 * only lever is the staged copy, the same one every other entry here uses.
 *
 * ## What the gate decides
 *
 * The define gates 259 sites in okcore.cpp alone. Two things follow:
 *
 *   - SEREMU, the debug console, is the device's FOURTH interface and exists
 *     only on a DEBUG build. A production device enumerates three.
 *   - Every Serial.print the library matches on. The PIN provisioning flow
 *     waits for "Enter PIN", "Storing PIN", "Confirm PIN" and "Both PINs
 *     Match", and a production build prints none of them.
 *
 * The version string carries the difference, which is how a host can tell:
 * onlykey.h defines OKversionkeyword as "-test" under DEBUG and "-prod"
 * otherwise, so a production build announces itself as UNLOCKEDv3.0.4-prodc.
 * See node-onlykey-lib/src/device/version.js.
 *
 * ## Why turning it ON had to exist
 *
 * A RELEASE SHIPS WITH IT OFF. v3.0.2's onlykey.h has `//#define DEBUG`, and
 * the working tree has it uncommented because somebody was working on it. So
 * every pinned version in ok-versions.json builds as a production device -
 * correctly, that is how it shipped - and a production device CANNOT BE GIVEN
 * A PIN at all (FINDING-provisioning-needs-a-debug-build.md). Its fresh
 * per-version storage would stay UNINITIALIZED forever and no suite that needs
 * an unlocked device could run against any release.
 *
 * OKEMU_DEBUG=1 flips the firmware's own switch, the same one the working tree
 * already has on. It changes no protocol and no behaviour the firmware does not
 * itself define; it is the difference between the two builds upstream ships.
 */
const WANT_DEBUG =
  process.env.OKEMU_DEBUG === '1' ? true
  : process.env.OKEMU_PRODUCTION === '1' ? false
  : null;                                      /* leave the sources alone */

/** Multi-line replacement text is written as lines and joined with this. */
const NL = String.fromCharCode(10);

/**
 * WHICH EDITION this build is, and the same lever as the DEBUG gate.
 *
 *     OKEMU_STD=1   force the STANDARD edition on
 *     OKEMU_STD=0   force the TRAVEL edition (STD_VERSION off)
 *     unset         leave the sources as they are, and say which
 *
 * ## Why this had to exist
 *
 * `#define STD_VERSION` in onlykey.h decides whether this is the standard
 * edition or the IN TRVL one, and the difference is not cosmetic: it gates
 * set_private's body, U2Finit, and the encrypted profile itself - without it
 * `profilemode` is NONENCRYPTEDPROFILE and most of the device's own code
 * returns early.
 *
 * MEASURED across ok-versions.json: every pin is the standard edition EXCEPT
 * v2.1.1 (libraries@0dc7cf0), where both DEBUG and STD_VERSION are commented
 * out. So the pinned commit for that release is a travel build, and staged as
 * it is, almost nothing the suite exercises exists on it - not because the
 * release lacked those features, but because that commit's build flags were
 * left set for a different edition.
 *
 * Forcing it on is the same kind of change as OKEMU_DEBUG=1: the firmware
 * provides the switch and this flips it in the throwaway copy. The version
 * script records that the commit itself is travel, so nobody reads a standard
 * result and concludes the commit was standard.
 */
const ENV_STD =
  process.env.OKEMU_STD === '1' ? true
  : process.env.OKEMU_STD === '0' ? false
  : null;

/** Resolved in main(), where the version script is known. */
let WANT_STD = ENV_STD;

/**
 * WHICH MODEL this build is.
 *
 *     OKEMU_MODEL=duo       build as an OnlyKey DUO
 *     OKEMU_MODEL=classic   force the classic detection path
 *     unset                 leave the sources as they are (classic)
 *
 * ## The firmware provides this switch itself
 *
 * On hardware the model is read from the chip: `HW_ID` is `SIM_SDID_PINID`, the
 * package-type field, and okcore.cpp's touch-sense loop uses it plus an analog
 * reading to decide between a DUO and an OK_Color. Reproducing that in the HAL
 * would mean faking a register AND an analog pin, and getting the interplay
 * right.
 *
 * There is no need. onlykey.h already carries
 *
 *     //#define DEFINED_HWID OK_HW_DUO
 *
 * with the comment "override auto hw detection, hardcoded" at its use site
 * (okcore.cpp). Uncommenting it is the firmware's own way of saying which model
 * this build is, so that is the lever - the same kind of change as the DEBUG and
 * STD_VERSION gates, not a new mechanism.
 *
 * ## It is not available on every release
 *
 * MEASURED: the override is present at v3.0.2, v3.0.1, v3.0.0 and the working
 * tree, and ABSENT at v2.1.1 and v2.1.0. The DUO is newer than the 2.1 line, so
 * asking those to be one is asking for a device that never existed - the gate
 * reports that rather than silently producing a classic.
 */
const WANT_DUO =
  process.env.OKEMU_MODEL === 'duo' ? true
  : process.env.OKEMU_MODEL === 'classic' ? false
  : null;

/**
 * Read - or flip - one of onlykey.h's build-option defines.
 *
 * A TOGGLE rather than a text patch, because the sources arrive on either side
 * of both of them and a patch written for one silently fails to find its
 * pattern in the other. This finds whichever spelling is there and reports the
 * state it leaves.
 *
 * MATCHED ON THE DEFINE, NOT ON THE WHOLE LINE. It used to compare the exact
 * text passed as `on`, trailing comment and all, and that comment is not
 * stable across releases: the 2019 beta line writes
 * `#define STD_VERSION //Define for US Version Firmare` where the 3.0 line
 * writes `//Define for STD edition firmare, undefine for IN TRVL edition
 * firmware`. Same define, same meaning, a different sentence after it - and
 * the old comparison read that as ABSENT, printed a bare `NaN` from a
 * broken error message, and reported the build as TRAVEL. That is a
 * different firmware: no FIDO, no encrypted profile, set_private returns
 * early. A comment is not a build option.
 *
 * @param name the define, for the log
 * @param on the line as it appears when the option is ENABLED
 * @param want true to enable, false to disable, null to leave it alone
 * @returns whether the staged tree ends up with it defined
 */
function gateDefine(name, on, want, { universal = true } = {}) {
  const target = path.join(STAGE, 'libraries', 'onlykey', 'onlykey.h');

  let text = fs.readFileSync(target, 'utf8');

  /*
   * The line as it stands in THIS tree, found by the DEFINE rather than by
   * the sentence after it. String.raw so the regex keeps its own escapes: in
   * an ordinary template literal `\b` is a backspace, not a word boundary,
   * and the difference is a matcher that silently never matches.
   *
   * Commented-out is tested first, because `//#define X` contains `#define X`.
   */
  const offLine = new RegExp(String.raw`^[ \t]*//[ \t]*#define[ \t]+${name}\b.*$`, 'm');
  const onLine = new RegExp(String.raw`^[ \t]*#define[ \t]+${name}\b.*$`, 'm');

  let enabled;
  let here = null;
  const offMatch = offLine.exec(text);
  const onMatch = offMatch ? null : onLine.exec(text);
  if (offMatch) { enabled = false; here = offMatch[0]; }
  else if (onMatch) { enabled = true; here = onMatch[0]; }
  else {
    /*
     * ABSENT. For a define every release carries that is a real problem - the
     * option has been renamed and we would otherwise read a silent, wrong
     * 'off'. For one that only some releases have, DEFINED_HWID being the
     * case, absence is the ordinary state and saying nothing is correct.
     */
    if (universal) {
      /*
       * This message had lost its first operand - `console.error( + '...')`
       * - so a unary plus on a string printed a bare `NaN` and nothing else,
       * and the exit code was set by something that named neither the define
       * nor the file. Met while staging the 2019 line.
       */
      console.error(
        `stage: ${name} is absent from libraries/onlykey/onlykey.h, so the ` +
        'build option could not be read. Either it was renamed at this pin, ' +
        'or this release predates it - if the latter, pass ' +
        '{ universal: false } for it.');
      process.exitCode = 1;
    }
    return null;
  }

  if (want === null || want === enabled) return enabled;

  /*
   * Flipped IN PLACE, keeping whatever comment this tree carries. Rewriting
   * the line to the `on` string passed in would replace one release's
   * comment with another's, which is how a staged tree quietly stops being
   * the release it claims to be.
   */
  text = want
    ? text.replace(here, here.replace(/^([ \t]*)\/\/[ \t]*/, '$1'))
    : text.replace(here, here.replace(/^([ \t]*)/, '$1//'));
  fs.writeFileSync(target, text);
  console.log(
    `stage: ${name} turned ${want ? 'ON' : 'OFF'} (was ${enabled ? 'ON' : 'OFF'})`);
  return want;
}

/**
 * Set - or just read - the DEBUG gate in the staged onlykey.h.
 *
 * A TOGGLE rather than a text patch, because the sources arrive on either side
 * of it: a release has the define commented out, the working tree has it live,
 * and a patch written for one silently fails to find its pattern in the other.
 * This finds whichever spelling is there and reports the state it leaves.
 *
 * DEBUG_CTAP_VERBOSE is a SEPARATE define that only newer trees carry, and it
 * follows DEBUG down: it gates its own sites in fido2/device.cpp and
 * okcore.cpp, so leaving it defined would keep printing to a console a
 * production build does not have. It is never turned ON - it fires on every
 * presence-test poll and floods the console this build reads.
 *
 * @param want true for DEBUG, false for production, null to leave it be.
 * @returns whether the staged tree ends up with DEBUG defined.
 */
function gateDebug(want) {
  const target = path.join(STAGE, 'libraries', 'onlykey', 'onlykey.h');
  const ON = '#define DEBUG //Enable Serial Monitor';
  const OFF = '//#define DEBUG //Enable Serial Monitor';

  let text = fs.readFileSync(target, 'utf8');

  /* OFF contains ON as a substring, so it has to be tested first. */
  let on;
  if (text.includes(OFF)) on = false;
  else if (text.includes(ON)) on = true;
  else {
    console.error(
      'stage: WARNING - the DEBUG define is not where it has always been in ' +
      'libraries/onlykey/onlykey.h, so the build gate could not be read.');
    process.exitCode = 1;
    return null;
  }

  if (want === null || want === on) {
    console.log(`stage: DEBUG gate is ${on ? 'ON' : 'OFF'} as the sources have it`);
    return on;
  }

  text = want
    ? text.split(OFF).join(ON + ' - re-enabled by stage.js for OKEMU_DEBUG=1')
    : text.split(ON).join('//#define DEBUG - removed by stage.js for OKEMU_PRODUCTION=1');

  /* Only ever downwards, and only where the tree has it. */
  if (!want) {
    const verbose = /^#define DEBUG_CTAP_VERBOSE.*$/m;
    if (verbose.test(text)) {
      text = text.replace(verbose,
        '//#define DEBUG_CTAP_VERBOSE - removed with DEBUG; it prints to a ' +
        'console a production build does not have');
    }
  }

  fs.writeFileSync(target, text);
  console.log(`stage: DEBUG gate turned ${want ? 'ON' : 'OFF'} (was ${on ? 'ON' : 'OFF'})`);
  return want;
}

/**
 * Keep core/keylayouts.h on the same side of the gate as onlykey.h.
 *
 * The header asks for this itself - "keep it in sync manually" above a define
 * whose comment is "comment this out (to match #undef DEBUG in onlykey.h) for
 * a release build". Two switches for one decision, and the second one is in a
 * file nobody edits.
 *
 * What hangs off it: with KEYLAYOUTS_DEBUG_BUILD defined, all twenty-six
 * SUPPORT_LAYOUT_* lines are commented out and only US English compiles, its
 * block being the one with no guard. Every other layout takes an empty branch
 * and types nothing at all.
 *
 * Reported either way, and never fatal. A release old enough to predate the
 * switch is a fact about that release, not a staging failure.
 *
 * @param {boolean|null} debugOn what the DEBUG gate ended up as
 */
function gateKeylayouts(debugOn) {
  if (debugOn === null) return null;

  const target = path.join(STAGE_CORE, 'keylayouts.h');
  if (!fs.existsSync(target)) return null;

  const ON = '#define KEYLAYOUTS_DEBUG_BUILD';
  const OFF = '//#define KEYLAYOUTS_DEBUG_BUILD';

  let text = fs.readFileSync(target, 'utf8');
  const on = text.includes(OFF) ? false : text.includes(ON) ? true : null;
  if (on === null) {
    console.log('stage: keylayouts.h has no KEYLAYOUTS_DEBUG_BUILD switch at this pin');
    return null;
  }

  if (on === debugOn) {
    console.log(
      `stage: keyboard layouts ${on ? 'US English only' : 'all enabled'} ` +
      '- already matching the DEBUG gate');
    return on;
  }

  text = debugOn
    ? text.split(OFF).join(ON + ' - re-enabled by stage.js to match the DEBUG gate')
    : text.split(ON).join(OFF + ' - removed by stage.js to match the DEBUG gate');

  fs.writeFileSync(target, text);
  console.log(
    `stage: keyboard layouts ${debugOn ? 'US English only' : 'ALL ENABLED'} ` +
    `- synced to the DEBUG gate (was ${on ? 'US English only' : 'all enabled'})`);
  return debugOn;
}

/**
 * Needed whenever the DEBUG gate ends up OFF, whichever way it got there.
 *
 * Not "the OKEMU_PRODUCTION patches": a pinned release is a production build
 * without anyone asking for one, and it needs these just as much. Keyed on the
 * RESULTING gate rather than on the environment variable, which is the
 * difference between a v3.0.2 that survives a getAssertion and one that takes
 * SIGSEGV on the first one.
 *
 * Edits that only some trees have are NOT here - see the version scripts'
 * `debugOffPatches`. Both edits below were checked to exist verbatim at every
 * release in ok-versions.json; the third guard in this function is spelled
 * differently before and after v3.0.2, so it lives in the version scripts.
 */
const DEBUG_OFF_PATCHES = [
  {
    /*
     * webcryptcheck() dereferences two pointers its callers hand it as NULL.
     *
     * ctap.cpp:1141 calls `webcryptcheck(NULL, NULL)` from
     * add_existing_user_info(), which is the ordinary allowList walk during a
     * getAssertion. On a DEBUG build the function returns 2 - "trust all
     * origins for debug firmware" - BEFORE reaching any comparison, so the
     * nulls never matter. That return sits inside the #ifdef, so with the gate
     * off execution falls straight into memcmp(stored_appid, NULL, 32) and the
     * firmware thread takes SIGSEGV. The device then stops answering entirely.
     *
     * The production path of this function has evidently never run anywhere:
     * byteprint() already carries a guard for the SAME pointer, with a comment
     * saying callers hand it null freely, so the null was known and guarded in
     * the debug print but not in the code that uses it.
     *
     * Returning 0 is the honest answer - nothing was supplied, so nothing
     * matches a stored origin - and it is what a guard naturally does. It does
     * mean the production build takes a different branch here than the debug
     * build, but that divergence is already deliberate: the debug build trusts
     * everything.
     *
     * DECIDED WITH THE USER, not assumed. Upstream this belongs in
     * libraries/fido2/device.cpp unconditionally; it is here only because that
     * tree is outside this project's write scope. See
     * FINDING-production-firmware-crashes-in-webcryptcheck.md.
     */
    file: 'libraries/fido2/device.cpp',
    edits: [
      ['    appid_match1 = memcmp (stored_apprpid, rpid, 12);',
       [
         '    /* Injected by ok-rn stage.js wherever the DEBUG gate is OFF.',
         '',
         '       Callers pass NULL for both of these. ctap.cpp:1141 passes',
         '       webcryptcheck(NULL, NULL); extensions.cpp:113 and :125 -',
         '       extend_fido2(), the whole CTAP2 path - pass NULL as _appid on',
         '       both branches. Only the #ifdef DEBUG early return above kept a',
         '       debug build from dereferencing them.',
         '',
         '       Guarded per COMPARISON rather than by returning early, so every',
         '       check whose inputs are actually present still runs. The rpid',
         '       check reads ctap_buffer, not _appid, and is the only one the',
         '       CTAP2 path can satisfy - skipping it would refuse requests the',
         '       firmware is meant to accept. A non-zero memcmp result means "no',
         '       match", which is the honest answer for a pointer that is not',
         '       there. */',
         '    appid_match1 = memcmp (stored_apprpid, rpid, 12);',
       ].join(NL)],
      ['	appid_match2 = memcmp (stored_appid, _appid, 32);',
       '	appid_match2 = (_appid == NULL) ? 1 : memcmp (stored_appid, _appid, 32);'],
    ],
  },
];

/*
 * Fixes that only SOME releases need live in scripts/versions/<version>.js -
 * one file per entry in ok-versions.json, loaded by OKEMU_VERSION.
 *
 * They were an `optional` array here first, and that shape could not work: an
 * optional patch that silently misses looks exactly like one that was never
 * needed, so a release could build with a fix half-applied and nothing would
 * say so. Per-version files make every patch MANDATORY - the version script
 * lists what that release needs, and a pattern that does not match is an error.
 *
 * Patches shared by several releases live in scripts/versions/_shared.js and
 * are imported by name; nothing there is applied automatically.
 */

const PATCHES = [
  {
    file: 'core/kinetis.h',
    edits: [
      // Inherited from the emulator: `cpsid i` / `cpsie i` mask interrupts.
      // There are none here - the firmware runs on one thread against
      // memory-backed peripherals - so these reduce to the compiler barrier
      // the surrounding flash and USB buffer code actually depends on.
      // (On AArch64/ARMv7-A these are not valid instructions either, so this
      // patch is required on Android for the same reason it is on x86.)
      ['#define __disable_irq() __asm__ volatile("CPSID i":::"memory");',
       '#define __disable_irq() __asm__ volatile("":::"memory");'],
      ['#define __enable_irq()\t__asm__ volatile("CPSIE i":::"memory");',
       '#define __enable_irq()\t__asm__ volatile("":::"memory");'],
    ],
  },
  {
    /*
     * REBASE THE FLASH ARRAY. This is the patch that makes the soft key a
     * usable device rather than a protocol toy.
     *
     * The firmware addresses its own storage through absolute pointers, and
     * ok_hal.cpp maps the flash file at those addresses so they resolve. On
     * Linux with vm.mmap_min_addr lowered to 4096 that works as written.
     *
     * Android will not allow it. mmap_min_addr is 0x8000 and an unprivileged
     * app cannot change it, so the mapping falls back to 0x10000 - above
     * certified_hw at 0x5BB0. The device then boots, answers HID, and faults
     * the moment it encrypts anything, which includes storing a PIN.
     * ok_hal.cpp papers over this by setting FSEC to already-provisioned so
     * the crypto path is never entered, which is why an unmodified port looks
     * healthy right up until it is asked to do something.
     *
     * So move the origin instead of fighting the floor. Only four literals
     * exist; everything else in okcore.h derives from them, and every offset
     * and difference between them is unchanged. OKEMU_FLASH_BASE comes from
     * CMakeLists, so the firmware's view and the HAL's mapping cannot drift.
     *
     * Upstream this belongs in the OnlyKey sources under #ifdef OK_EMULATOR -
     * unlike the uintptr_t fixes, this one genuinely is emulator-specific and
     * must NOT change the device build.
     */
    file: 'libraries/onlykey/okcore.h',
    edits: [
      /*
       * The trailing `//22528 - 23551` is deliberately NOT part of the pattern.
       *
       * v2.1.0 and v2.1.1 define the same address with no comment after it, so
       * a pattern carrying the comment misses on those releases while the three
       * other edits in this file still apply - the patch half-lands, and what
       * gets built is a tree with one address unrebased. Matching the define
       * alone applies to every release in ok-versions.json; any comment already
       * on the line simply trails the replacement, which is still valid C.
       *
       * Found by scripts/version-probe.js, which is what it is for.
       */
      ['#define factorysectoradr 0x5800',
       '#define factorysectoradr (OKEMU_FLASH_BASE + 0x5800)'],
      ['#define fwstartadr 0x6060',
       '#define fwstartadr (OKEMU_FLASH_BASE + 0x6060)'],
      ['#define flashstorestart 0x3A800',
       '#define flashstorestart (OKEMU_FLASH_BASE + 0x3A800)'],
      ['#define flashend 0x3FFFF',
       '#define flashend (OKEMU_FLASH_BASE + 0x3FFFF)'],

      /*
       * AIRCR, the one system register okcore.h names ITSELF.
       *
       * rewriteSystemBlock() rebases the 0xE0000000 window, but it only walks
       * core/kinetis.h and only matches the `(*(volatile T *)0x...)` shape.
       * This is a bare pointer literal in an OnlyKey header, so it matched
       * neither test and stayed at the raw address - while kinetis.h's own name
       * for the SAME register, SCB_AIRCR, was rebased correctly. Two names, one
       * register, one of them left behind.
       *
       * The consequence is not a silent no-op, it is a CRASH. Nothing maps
       * 0xE000ED0C, so every CPU_RESTART() - the idle lockout, the lock
       * gesture, a failed integrity check, the end of a wipe - writes to
       * unmapped memory and takes the whole app down with SIGSEGV. Measured:
       * fault addr 0xe000ed0c on a write, in okemu_firmware_run, with
       * x8 = 0x05fa0004, which is CPU_RESTART_VAL.
       *
       * Rebased, the store lands on the page okemu_restart.cpp guards, and its
       * handler turns it into the restart EVENT it was always meant to be.
       */
      ['#define CPU_RESTART_ADDR (uint32_t *)0xE000ED0C',
       '#define CPU_RESTART_ADDR ((uint32_t *)OKEMU_SCS(0xE000ED0C))'],
    ],
  },
  {
    /*
     * OnlyKey source, like the okcore.h rebase above. Most of the rest of
     * this list is the vendored Teensy core, which the emulator already
     * patches on the grounds that it is not OnlyKey code.
     *
     * rsa_encrypt() and rsa_decrypt() print the address of a stack local as a
     * stack-depth diagnostic, under #ifdef DEBUG - which this build sets, since
     * DEBUG is what gives the device its fourth (SEREMU) interface. uint32_t
     * truncates that address on any 64-bit target.
     *
     * Upstream this belongs in the OnlyKey sources as an #ifdef OK_EMULATOR,
     * or better, as an unconditional correction: uintptr_t is right on the
     * MK20DX256 too, where it is a 32-bit type and nothing changes. It is here
     * only because OnlyKey-Firmware and libraries/ are outside this project's
     * write scope. If that changes, move it and delete this entry.
     *
     * Both call sites are the same line, so one edit covers them.
     */
    file: 'libraries/onlykey/okcrypto.cpp',
    edits: [
      ['Serial.println ((uint32_t)&ret);', 'Serial.println ((uintptr_t)&ret);'],
    ],
  },
  {
    /*
     * Same class as okcrypto.cpp above, and the same note applies: this belongs
     * upstream, unconditionally, because uintptr_t is correct on the MK20DX256
     * too.
     *
     * ctap_parse.cpp measures a CBOR span by casting both ends to uint32_t and
     * subtracting. The subtraction is fine; narrowing the pointers first is
     * not, and on a 64-bit target it can silently produce a bogus length for a
     * buffer that is then bounds-checked against it.
     */
    file: 'libraries/fido2/ctap_parse.cpp',
    edits: [
      ['uint32_t length = (uint32_t)end_byte - (uint32_t)start_byte;',
       'uint32_t length = (uint32_t)((uintptr_t)end_byte - (uintptr_t)start_byte);'],
    ],
  },
  {
    /*
     * Arduino's ADC library, same bit-band macro shape as the Teensy core's
     * GPIO ones - a peripheral address narrowed to uint32_t. Not OnlyKey code.
     */
    file: 'libraries/ADC/ADC_Module.h',
    edits: [
      ['#define ADC_BITBAND_ADDR(reg, bit) (((uint32_t)(reg) - 0x40000000) * 32 + (bit) * 4 + 0x42000000)',
       '#define ADC_BITBAND_ADDR(reg, bit) (((uintptr_t)(reg) - 0x40000000) * 32 + (bit) * 4 + 0x42000000)'],
    ],
  },
  {
    /*
     * The Teensy core assumes a 32-bit pointer in two places. Both are fatal
     * on arm64 and x86_64, where clang rejects a narrowing pointer cast
     * outright; GCC demotes it to a warning, and the Node emulator additionally
     * builds with -w, so neither shows up there.
     *
     * These three macros account for 190 of the 194 diagnostics on their own -
     * they expand once per GPIO register. Taking the address of a peripheral
     * register through uintptr_t rather than uint32_t is correct on every
     * architecture; the arithmetic is unchanged, because the peripheral window
     * really is mapped at 0x40000000 whatever the pointer width.
     */
    file: 'core/avr_emulation.h',
    edits: [
      ['#define GPIO_BITBAND_ADDR(reg, bit) (((uint32_t)&(reg) - 0x40000000) * 32 + (bit) * 4 + 0x42000000)',
       '#define GPIO_BITBAND_ADDR(reg, bit) (((uintptr_t)&(reg) - 0x40000000) * 32 + (bit) * 4 + 0x42000000)'],
      ['#define GPIO_SETBIT_ATOMIC(reg, bit) (*(uint32_t *)(((uint32_t)&(reg) - 0xF8000000) | 0x480FF000) = 1 << (bit))',
       '#define GPIO_SETBIT_ATOMIC(reg, bit) (*(uint32_t *)(((uintptr_t)&(reg) - 0xF8000000) | 0x480FF000) = 1 << (bit))'],
      ['#define GPIO_CLRBIT_ATOMIC(reg, bit) (*(uint32_t *)(((uint32_t)&(reg) - 0xF8000000) | 0x440FF000) = ~(1 << (bit)))',
       '#define GPIO_CLRBIT_ATOMIC(reg, bit) (*(uint32_t *)(((uintptr_t)&(reg) - 0xF8000000) | 0x440FF000) = ~(1 << (bit)))'],
    ],
  },
  {
    /*
     * Print::printf() passes `this` to vdprintf() as a file descriptor, and
     * newlib's _write() - a few lines above in this same file - casts that
     * integer back to a Print*. A pointer round-tripped through an int, which
     * is correct on the MK20DX256 where both are 32 bits, and a narrowing cast
     * that clang REJECTS on any 64-bit target.
     *
     * So it has to be addressed to compile. It is addressed as narrowly as
     * possible: an explicit two-step cast, which is what the original already
     * means. Nothing here changes what the function does.
     *
     * An earlier version of this patch replaced the body with vsnprintf+write,
     * on the grounds that bionic's vdprintf takes a real descriptor and the
     * round trip cannot work hosted. That is true and it does not matter -
     * NOTHING in the compiled set calls Print::printf (every call site in
     * libraries/ is commented out, and examples/ is excluded by gen-sources).
     * Rewriting it was fixing the firmware rather than building it, which is
     * not what staging is for. Reverted to the minimum.
     */
    file: 'core/Print.cpp',
    edits: [
      ['	return vdprintf((int)this, format, ap);',
       '	return vdprintf((int)(intptr_t)this, format, ap);'],
      ['	return vdprintf((int)this, (const char *)format, ap);',
       '	return vdprintf((int)(intptr_t)this, (const char *)format, ap);'],
    ],
  },
  {
    /*
     * uECC.c calls uECC_point_mult() ~11 lines before defining it, and the
     * only prototype lives in uECC_vli.h behind #if uECC_ENABLE_VLI_API, which
     * this build does not set. That leaves an implicit int() declaration that
     * the real definition then conflicts with.
     *
     * GCC has historically demoted implicit declarations to a warning, which
     * is why this builds under the Node emulator. clang - and GCC 14+ - reject
     * it. The fix is a forward declaration, not a flag: -Wno-implicit-function
     * -declaration silences the first diagnostic but cannot reconcile the
     * conflicting types that follow.
     */
    file: 'libraries/uECC/uECC.c',
    edits: [
      ['#include "uECC.h"\n#include "uECC_vli.h"',
       '#include "uECC.h"\n#include "uECC_vli.h"\n\n' +
       '/* Injected by ok-rn/android/okemu/scripts/stage.js - defined below at\n' +
       ' * file scope, but called before its definition. */\n' +
       'void uECC_point_mult(uECC_word_t *result,\n' +
       '                     const uECC_word_t *point,\n' +
       '                     const uECC_word_t *scalar,\n' +
       '                     uECC_Curve curve);'],
    ],
  },
];

/* ------------------------------------------------ staging a RELEASED version */

/**
 * Build a released firmware version instead of the working tree.
 *
 *     OKEMU_VERSION=v3.0.2 node scripts/stage.js
 *
 * The commits come from ok-versions.json, which pins `libraries` and
 * `OnlyKey-Firmware` per release; everything else that release needs comes from
 * its own script in scripts/versions/. This is what makes the version matrix
 * possible: node-onlykey-lib branches on firmware version in a dozen places and
 * every one of those branches is marked UNVERIFIED, because the emulator is
 * built from current firmware and CI can only ever prove the current
 * generation.
 *
 * ## It never touches the source repositories
 *
 * Not `git checkout`, which would move HEAD in a tree this project must not
 * write to. `ls-tree` and `cat-file` read the OBJECT DATABASE and leave the
 * working tree exactly as it was - the same technique version-probe.js uses.
 * The sources are unpacked into .stage-src/<version>/, inside our own write
 * scope, and cached so a rebuild does not re-extract.
 */
const VERSION = process.env.OKEMU_VERSION || null;

const versions = require('./versions');

/**
 * Unpack one commit's tree into `dest`.
 *
 * Two git calls total, not one per file. `ls-tree -r` names every blob and
 * `cat-file --batch` streams all their contents through a single process -
 * which matters because `libraries` is several hundred files, and several
 * hundred process spawns on Windows is a minute of nothing happening.
 */
function materialise(repo, sha, dest) {
  const { execFileSync } = require('child_process');
  const git = (args, opts) => execFileSync('git', ['-C', repo, ...args], {
    maxBuffer: 1 << 30, ...opts,
  });

  let listing;
  try {
    listing = git(['ls-tree', '-r', '-z', sha], { encoding: 'utf8' });
  } catch (e) {
    throw new Error(
      `cannot read ${sha} from ${repo}. The commit may not be in this checkout ` +
      `- ok-versions.json pins releases that a fork may not carry.`,
    );
  }

  /* -z gives NUL-terminated records of "<mode> <type> <sha>\t<path>". */
  const entries = [];
  for (const record of listing.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [, type, blob] = record.slice(0, tab).split(/\s+/);
    if (type !== 'blob') continue;      // submodules and trees are not files
    entries.push({ blob, file: record.slice(tab + 1) });
  }
  if (!entries.length) throw new Error(`${sha} in ${repo} has no files`);

  const batch = git(['cat-file', '--batch'], {
    input: entries.map((e) => e.blob).join('\n') + '\n',
    // No encoding: execFileSync then returns a Buffer, which is required because
    // the blobs are binary. Setting it to 'buffer' would also be applied to
    // stdin, where it is not a valid string encoding.
  });

  /*
   * The batch stream is "<sha> <type> <size>\n<contents>\n" per object, and the
   * contents are BINARY - parsed as a Buffer with explicit offsets rather than
   * split on newlines, which would corrupt any file containing one.
   */
  let at = 0;
  for (const entry of entries) {
    const nl = batch.indexOf(0x0a, at);
    const header = batch.slice(at, nl).toString('utf8');
    const size = Number(header.split(' ')[2]);
    const start = nl + 1;

    const target = path.join(dest, entry.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, batch.slice(start, start + size));

    at = start + size + 1;              // trailing newline after each object
  }
  return entries.length;
}

/**
 * Point FW and LIB_SRC at a released version's sources.
 *
 * Cached by commit, so switching back and forth across a matrix run costs one
 * extraction each rather than one per build.
 */
function materialiseVersion(release) {
  const { version, pins } = release;
  const out = {};

  for (const [repo, sha] of [
    ['OnlyKey-Firmware', pins['OnlyKey-Firmware']],
    ['libraries', pins.libraries],
  ]) {
    const dest = path.join(VERSION_CACHE, version, repo);
    const stamp = path.join(dest, '.commit');

    if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === sha) {
      out[repo] = dest;
      console.log(`stage: ${repo}@${sha} already unpacked`);
      continue;
    }

    rmrf(dest);
    fs.mkdirSync(dest, { recursive: true });
    const count = materialise(path.join(CHECKOUTS, repo), sha, dest);
    fs.writeFileSync(stamp, sha + '\n');
    out[repo] = dest;
    console.log(`stage: ${repo}@${sha} unpacked, ${count} files`);
  }

  FW = out['OnlyKey-Firmware'];
  LIB_SRC = out.libraries;
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

/**
 * Copy one file, retrying a Windows lock.
 *
 * EBUSY here is not a broken build, it is another process holding the file for
 * a moment - a watcher, an indexer, an antivirus scan of a tree that was just
 * rewritten. It has taken down a matrix sweep twice: once staging v2.1.2 and
 * once mid-sweep on `.stage/core/kinetis.h`, both reported as
 * "okemu: scripts/stage.js failed" with no hint that waiting would have fixed
 * it. Both times the very next attempt succeeded.
 *
 * So: a few short retries, then give up with the original error. Synchronous
 * on purpose - everything around it is, and a sweep that pauses 300ms is
 * cheaper than one that dies at version four of eleven.
 */
function copyFileRetrying(src, dst, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      fs.copyFileSync(src, dst);
      return;
    } catch (e) {
      const transient = e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES');
      if (!transient || i >= attempts) throw e;
      /* Busy-wait: this script has no event loop to await on. */
      const until = Date.now() + 60 * i;
      while (Date.now() < until) { /* hold */ }
    }
  }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === '.git') continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else copyFileRetrying(s, d);
  }
}

/**
 * Apply every literal fixup to the STAGED tree.
 *
 * `extra` is the loaded version script's own patches, or nothing for the
 * working tree. They are applied on the same terms as the rest: a file that is
 * not there, or a pattern that does not match, is an ERROR. That is the point
 * of one script per release - the script names the release, so its patches are
 * known to belong to it and a miss means the pins moved under it.
 */
/** The first line of a pattern, so an error about one stays readable. */
function firstLine(text) {
  return String(text).split(String.fromCharCode(10))[0];
}

/**
 * @param extra   patches this release adds
 * @param absent  `from` patterns (or file paths) this release declares its
 *                tree does not contain
 */
function applyPatches(extra = [], absent = []) {
  let applied = 0, missing = 0, expected = 0;
  const patches = [
    ...PATCHES,
    ...extra,
  ];
  /*
   * SOME BASE PATCHES DO NOT APPLY TO EVERY RELEASE, and for an old enough
   * tree that is a fact about the release rather than a fault.
   *
   * The 2019 beta line has no `factorysectoradr` in okcore.h and no
   * `end_byte` span in ctap_parse.cpp: the first arrived later, the second
   * belongs to a fido2 library that release predates. A base patch written
   * against the 3.0 line finds neither, and failing the whole stage for it
   * would mean the matrix can never reach back past the oldest tree that
   * happens to contain every pattern.
   *
   * So a release may DECLARE a pattern absent. Declared-absent is counted
   * and reported - it is not silence. And a pattern declared absent that
   * turns out to be PRESENT throws, because the declaration has gone stale
   * and the tree would be built unpatched on the strength of it.
   */
  const declaredAbsent = new Set(absent);
  const seen = new Set();
  for (const p of patches) {
    const target = path.join(STAGE, p.file);
    if (!fs.existsSync(target)) {
      if (declaredAbsent.has(p.file)) {
        console.log(`stage: ${p.file} is absent at this pin, as its release says`);
        seen.add(p.file);
        expected++;
        continue;
      }
      console.error(`stage: WARNING - patch file absent: ${p.file}`);
      missing++;
      continue;
    }
    let text = fs.readFileSync(target, 'utf8');
    for (const [from, to] of p.edits) {
      /*
       * These checkouts are cloned on Windows, so the staged copy carries CRLF
       * while the patterns here are written with LF. Try the pattern as
       * written, then with CRLF line endings, and keep whichever matches -
       * a patch that silently fails to apply is worse than one that errors.
       */
      const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
      const from2 = text.includes(from) ? from
        : text.includes(crlf(from)) ? crlf(from)
        : null;
      if (from2 === null) {
        if (declaredAbsent.has(from)) {
          seen.add(from);
          expected++;
          continue;
        }
        console.error(
          `stage: WARNING - pattern not found in ${p.file}: ${firstLine(from)}` +
          ' | if this release predates it, list that line in the version ' +
          "script's `absentPatterns`");
        missing++;
        continue;
      }
      if (declaredAbsent.has(from)) {
        throw new Error(
          `stage: ${p.file} DOES contain a pattern its release declares ` +
          `absent: ${firstLine(from)} | remove it from absentPatterns - the ` +
          'tree would be left unpatched on the strength of a stale claim');
      }
      text = text.split(from2).join(from2 === from ? to : crlf(to));
      applied++;
    }
    fs.writeFileSync(target, text);
  }
  for (const declared of declaredAbsent) {
    if (!seen.has(declared)) {
      throw new Error(
        'stage: this release declares a pattern absent that no patch looks ' +
        `for: ${firstLine(declared)} | either a typo, or the base patch it ` +
        'belonged to has gone');
    }
  }
  if (expected) {
    console.log(`stage: ${expected} base patch edit(s) absent at this pin, as declared`);
  }
  if (missing) {
    console.error('stage: a patch did not apply - upstream may have changed.');
    process.exitCode = 1;
  }
  return applied;
}

/*
 * Rewrite the Cortex-M system block out of kinetis.h.
 *
 * Every register in that header is a literal absolute address:
 *
 *     #define SYST_CVR  (*(volatile uint32_t *)0xE000E018)
 *
 * 1561 of them, of which 91 are at 0xE0000000+. On 32-bit ARM that window is
 * kernel-only, so it can never be mapped and every one of those dereferences
 * would fault. Redirect them into an ordinary array instead: the address
 * arithmetic is resolved at compile time against okemu_scs_base, so the
 * generated code is the same shape it always was.
 *
 * Only ten of the ninety-one are ever read by the firmware, the libraries or
 * the surviving core files - the DWT cycle counter, SysTick, and three SCB
 * registers - and all ten are either stubbed by core-override/okemu_pins.cpp
 * or inert. The rewrite is blanket rather than targeted so that a future
 * firmware revision touching an eleventh does not silently fault.
 *
 * A header's own #define always wins over anything predefined from outside, so
 * this cannot be done with -D or a force-included shim. Patching the staged
 * copy is the only lever, exactly as it is for the CPSID asm above.
 */
const SCS_BASE = 0xE0000000;
const SCS_LEN = 0x00100000;

function rewriteSystemBlock() {
  const target = path.join(STAGE_CORE, 'kinetis.h');
  let text = fs.readFileSync(target, 'utf8');

  const re = /\(\*\(volatile (uint8_t|uint16_t|uint32_t|int8_t|int16_t|int32_t) \*\)(0x[EF][0-9A-Fa-f]{7})\)/g;
  let count = 0;
  text = text.replace(re, (whole, type, addr) => {
    const a = parseInt(addr, 16);
    if (a < SCS_BASE || a >= SCS_BASE + SCS_LEN) return whole;
    count++;
    return `(*(volatile ${type} *)OKEMU_SCS(${addr}))`;
  });

  if (!count) {
    console.error('stage: WARNING - no system-block registers rewritten');
    process.exitCode = 1;
    return 0;
  }

  /*
   * The macro has to be visible before the first use. kinetis.h opens with an
   * include guard; put the declaration immediately after it so every consumer
   * of the header gets it, in whatever order they include things.
   *
   * Matched as a regex rather than a literal: these checkouts are cloned on
   * Windows, so the staged copy carries CRLF and any multi-line literal would
   * silently fail to match.
   */
  const anchor = /#ifndef\s+_kinetis_h_\r?\n#define\s+_kinetis_h_\r?\n/;
  if (!anchor.test(text)) {
    console.error('stage: WARNING - kinetis.h include guard not where expected');
    process.exitCode = 1;
    return 0;
  }
  const decl =
    '\n/* Injected by ok-rn/android/okemu/scripts/stage.js - see rewriteSystemBlock(). */\n' +
    '#ifdef __cplusplus\nextern "C" {\n#endif\n' +
    'extern unsigned char okemu_scs_base[0x00100000];\n' +
    '#ifdef __cplusplus\n}\n#endif\n' +
    '#define OKEMU_SCS(a) ((void *)(okemu_scs_base + ((unsigned long)(a) - 0xE0000000UL)))\n\n';

  text = text.replace(anchor, (m) => m + decl);
  fs.writeFileSync(target, text);
  return count;
}

/*
 * Remove Arduino's Time.h from the include path.
 *
 * The Time library ships two headers: TimeLib.h, which has the content, and
 * Time.h, which is one line - `#include "TimeLib.h"`. Its directory has to be
 * on the include path because the firmware includes "Time.h" from six places.
 *
 * On a case-insensitive filesystem - Windows and macOS both - that makes
 * `#include <time.h>` resolve to Arduino's Time.h rather than libc's, because
 * -I directories are searched before the sysroot. struct timespec then never
 * gets declared, and every file in the HAL that sleeps or reads the clock
 * fails to compile. Linux never sees this, which is why the Node emulator
 * builds there and this did not build here.
 *
 * Deleting the one-line shim and pointing its six consumers straight at
 * TimeLib.h removes the collision for good, rather than per-file.
 */
function defuseTimeHeader() {
  const shim = path.join(STAGE_LIB, 'Time', 'Time.h');
  if (fs.existsSync(shim)) fs.rmSync(shim);

  let rewritten = 0;
  const re = /(#\s*include\s*)(["<])Time\.h([">])/g;

  const walkAll = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walkAll(p); continue; }
      if (!/\.(c|cpp|h|hpp|ino)$/.test(ent.name)) continue;
      const text = fs.readFileSync(p, 'utf8');
      if (!re.test(text)) { re.lastIndex = 0; continue; }
      re.lastIndex = 0;
      fs.writeFileSync(p, text.replace(re, '$1$2TimeLib.h$3'));
      rewritten++;
    }
  };
  walkAll(STAGE);
  return rewritten;
}

/**
 * A digest of everything that actually gets compiled.
 *
 * Taken over the STAGED tree, after the patches, because that is the source
 * the .so is built from - hashing OnlyKey-Firmware instead would describe the
 * inputs and miss every fixup applied on the way in.
 *
 * Path is hashed alongside content so that moving a file changes the digest,
 * and the walk is sorted so the answer does not depend on readdir order.
 */
/**
 * Rename Crypto/SHA256.h out of the way, the way upstream later did.
 *
 * THE 2019 TREE HAS TWO HEADERS WHOSE NAMES DIFFER ONLY IN CASE:
 * `Crypto/SHA256.h`, the Arduino Crypto library's C++ class, and
 * `sha256/sha256.h`, Brad Conte's C implementation that defines
 * `SHA256_CTX`. On a case-insensitive filesystem - which is every Windows
 * checkout of this project - `#include "sha256.h"` from fido2/device.h
 * resolves to whichever directory comes first on the include path, and
 * Crypto is listed before sha256 (CMakeLists.txt:54 vs :60). So device.h
 * got the C++ class, and every translation unit that wanted SHA256_CTX
 * failed with "unknown type name".
 *
 * Upstream hit this too and fixed it the same way: at the current libraries
 * HEAD the file is `Crypto/SHA256_2.h`. This does that rename to the STAGED
 * copy for the releases that predate it, so an old tree builds without
 * anyone editing the checkout.
 *
 * Not a patch entry, because a patch edits text in place and this moves a
 * file and rewrites the includes that name it - the same shape as
 * defuseTimeHeader above, and for the same kind of reason.
 *
 * @returns how many files were repointed, or -1 when there was nothing to do
 */
function renameCryptoSha256() {
  const dir = path.join(STAGE_LIB, 'Crypto');
  if (!fs.existsSync(dir)) return -1;
  /*
   * `existsSync` is case-INSENSITIVE on Windows and answers true for the
   * already-renamed tree too, so the directory listing is the only honest
   * test of which name is really on disk.
   */
  const names = fs.readdirSync(dir);
  if (!names.includes('SHA256.h')) return -1;

  fs.renameSync(path.join(dir, 'SHA256.h'), path.join(dir, 'SHA256_2.h'));
  if (names.includes('SHA256.cpp')) {
    fs.renameSync(path.join(dir, 'SHA256.cpp'), path.join(dir, 'SHA256_2.cpp'));
  }

  let rewritten = 0;
  const re = /(#\s*include\s*)(["<])SHA256\.h([">])/g;
  const walkAll = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, ent.name);
      if (ent.isDirectory()) { walkAll(q); continue; }
      if (!/\.(c|cpp|h|hpp|ino)$/.test(ent.name)) continue;
      const text = fs.readFileSync(q, 'utf8');
      if (!re.test(text)) { re.lastIndex = 0; continue; }
      re.lastIndex = 0;
      fs.writeFileSync(q, text.replace(re, '$1$2SHA256_2.h$3'));
      rewritten++;
    }
  };
  walkAll(STAGE);
  return rewritten;
}


function digestStage() {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256');
  const files = [];

  (function walk(dir, rel) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const here = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(full, here);
      else files.push([here, full]);
    }
  })(STAGE, '');

  for (const [rel, full] of files) {
    hash.update(rel);
    hash.update(fs.readFileSync(full));
  }
  return { digest: hash.digest('hex').slice(0, 12), files: files.length };
}

/** Short HEAD of a checkout, or null when it is not a repo. */
function gitShort(dir) {
  try {
    return require('child_process')
      .execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .trim();
  } catch (_) {
    return null;
  }
}

/*
 * Written where the app can import it, because the login screen leads with
 * "which firmware is this actually running" and a version that is guessed is
 * worse than none. Generated rather than committed: a checkout that has never
 * staged reports 'unknown' instead of somebody else's hash.
 */
function writeBuildInfo(stats, release, debugOn, stdEdition, duoModel) {
  const out = path.join(OKEMU, '..', '..', 'src', 'generated');
  fs.mkdirSync(out, { recursive: true });
  const pins = release.pins;
  const info = {
    digest: stats.digest,
    files: stats.files,
    /*
     * For a pinned build the shas come from ok-versions.json, not from
     * gitShort() - the unpacked sources are a plain directory with no .git, so
     * asking it would answer about the wrong repository or not at all.
     */
    firmware: pins ? pins['OnlyKey-Firmware'] : gitShort(FW),
    libraries: pins ? pins.libraries : gitShort(LIB_SRC),
    /** null means the working tree, which is the ordinary case. */
    /*
     * The RELEASE name, or null for the working tree - which is a version
     * script like any other but is not a released version, and the app must
     * not report it as one. src/buildInfo.ts turns this into the storage slot.
     */
    version: release.pins ? release.version : null,
    production: !debugOn,
    /**
     * 'standard' or 'travel'. The IN TRVL edition compiles out set_private,
     * U2Finit and the encrypted profile, so a host talking to one sees a device
     * that refuses most of what it knows how to ask for.
     */
    edition: stdEdition === null ? null : stdEdition ? 'standard' : 'travel',
    /**
     * The model this build reports as. A DUO is 24 slots across 4 profiles
     * with 3 buttons and a PIN carried in the message body rather than pressed
     * on the device, so a host that reads this wrong gets all of that wrong.
     */
    model: duoModel ? 'duo' : 'classic',
    stagedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(out, 'firmware.json'),
    JSON.stringify(info, null, 2) + '\n',
  );
  return info;
}

/**
 * Say whether the staged tree came out the way this version's script says it
 * did last time.
 *
 * Reported, never fatal. stage.js and the Arduino toolchain are both inputs to
 * that digest, so a change here moves it for every version at once - which is
 * information, not a failure. What it catches is the other case: a pinned
 * version whose digest moved while nothing in this repository did.
 */
function checkExpectation(release, stats, debugOn) {
  /* The working tree is not pinned to anything, so nothing about it is fixed. */
  if (!release.pins) return;

  /*
   * A recorded digest describes the release staged AS IT SHIPS. Forcing the
   * gate the other way changes four files and therefore the digest, so
   * comparing then would report a change on every deliberate override - a
   * warning that fires whenever it is asked to would be a warning nobody reads.
   */
  /*
   * COMPARE WHEN THE BUILD IS THE ONE THAT SHIPS, however it got there.
   *
   * A recorded digest describes the release as it ships, and a release ships
   * as a production build - the signed images all declare -prod. So the
   * question is not "was a gate forced" but "did the gate end up OFF".
   *
   * This used to refuse whenever WANT_DEBUG was set either way, which was
   * right while the matrix forced DEBUG ON and wrong the moment it started
   * building releases as they ship: every sweep then skipped every digest
   * check, silently, and the one thing the digest exists to catch - a pin
   * moving under a script - stopped being checked at all.
   *
   * Forcing DEBUG ON still skips. That tree is four files different from the
   * one the digest was recorded for, so a mismatch would be information
   * nobody asked for.
   */
  if (debugOn) {
    console.log(
      `stage: digest not compared - this is a DEBUG build, and ` +
      `${release.version}'s recorded digest is for the build as it ships`);
    return;
  }

  if (!release.expect || !release.expect.digest) {
    {
      console.log(
        `stage: ${release.version} has no recorded digest. If this build is ` +
        `good, add  expect: { digest: '${stats.digest}' }  to its script.`);
    }
    return;
  }
  if (release.expect.digest === stats.digest) {
    console.log(`stage: digest matches ${release.version}'s recorded ${stats.digest}`);
  } else {
    console.log(
      `stage: digest CHANGED for ${release.version}\n` +
      `         recorded: ${release.expect.digest}\n` +
      `         now:      ${stats.digest}\n` +
      `       Expected if stage.js or the toolchain changed. Otherwise the ` +
      `pins moved.`);
  }
}

/**
 * `node scripts/stage.js --list` - what can be staged, and how far each got.
 *
 * Switching versions is one environment variable, so the thing worth printing
 * is which names that variable accepts and what is already known about each.
 */
function listVersions() {
  console.log('OKEMU_VERSION accepts:\n');
  for (const name of versions.list()) {
    let release;
    try {
      release = versions.load(name);
    } catch (e) {
      console.log(`  ${name.padEnd(8)} UNLOADABLE  ${e.message.split('\n')[0]}`);
      continue;
    }
    console.log(
      `  ${name.padEnd(8)} ${release.status.padEnd(8)} ` +
      `${release.pins['OnlyKey-Firmware']}/${release.pins.libraries}` +
      `  ${release.patches.length} version patch(es)`);
    for (const line of release.notes.split('\n')) {
      if (line) console.log(`             ${line}`);
    }
  }
  console.log(
    '\n  (unset)  the working tree - OnlyKey-Firmware and libraries as they are\n' +
    '\nStatus is a ladder: blocked < untried < stages < builds < boots < tested.\n' +
    'Each rung is something somebody watched happen. Patches applying is not\n' +
    'linking, and linking is not booting.');
}

function main() {
  if (process.argv.includes('--list')) return listVersions();

  /*
   * EVERY build has a version script, the working tree included. It is what
   * says which storage slot to use and which patches this particular source
   * tree needs, and having no special case for the default is the point - the
   * edits the current sources need and no release does used to have nowhere to
   * live but an unexplained branch in here.
   *
   * Repoint FW and LIB_SRC BEFORE anything reads them, including the existence
   * check below - so a missing pinned commit fails naming the commit, not the
   * checkout.
   */
  let release;
  try {
    /*
     * A load failure is a message, not a stack trace. Every one of them is
     * something the person running this has to fix by hand - a version with no
     * script, a script that was copied without being renamed, pins that moved
     * under a script's notes - and the message says which.
     */
    release = versions.load(VERSION || versions.WORKING_TREE);
  } catch (e) {
    console.error(`stage: ${e.message}`);
    process.exit(1);
  }

  /*
   * A release whose script says it cannot be staged stops here, quoting its
   * own notes. Letting it proceed would produce a tree built from whatever
   * git happened to resolve, under a version number that would then be
   * attached to every measurement taken against it.
   */
  if (release.status === 'blocked') {
    console.error(`stage: ${release.version} is marked BLOCKED in its version script.`);
    console.error(release.notes.replace(/^/gm, '  '));
    process.exit(1);
  }

  /*
   * A release may DECLARE the build options it has to be staged with - see
   * versions/index.js, gates. The environment still wins, so a deliberate
   * travel build is one OKEMU_STD=0 away.
   */
  if (ENV_STD === null && release.gates && release.gates.std !== undefined) {
    WANT_STD = release.gates.std;
  }

  if (release.pins) {
    console.log(
      `stage: OKEMU_VERSION=${release.version} (${release.status}) - ` +
      `scripts/versions/${release.version}.js, ` +
      `${release.patches.length} version patch(es)`);
    materialiseVersion(release);
  }

  for (const p of [CORE_SRC, FW, LIB_SRC]) {
    if (!fs.existsSync(p)) {
      console.error(`stage: missing required tree: ${p}`);
      console.error('stage: components are checkouts beside ok-rn; see the workspace setup.sh');
      process.exit(1);
    }
  }

  rmrf(STAGE);

  // 1. stock teensy3 core
  copyDir(CORE_SRC, STAGE_CORE);

  // 2. OnlyKey's composite USB stack + keylayouts shadow the stock core files
  let overlaid = 0;
  for (const f of fs.readdirSync(FW)) {
    if (/\.(c|h)$/.test(f)) {
      copyFileRetrying(path.join(FW, f), path.join(STAGE_CORE, f));
      overlaid++;
    }
  }

  // 3. our host implementations of the peripheral drivers
  let overrides = 0;
  if (fs.existsSync(OVERRIDE)) {
    for (const f of fs.readdirSync(OVERRIDE)) {
      if (/\.(c|cpp|h)$/.test(f)) {
        copyFileRetrying(path.join(OVERRIDE, f), path.join(STAGE_CORE, f));
        overrides++;
      }
    }
  }

  /*
   * 4. drop the bare-metal files.
   *
   * A version script may add to this list - an older release can ship a core
   * file that later ones dropped - but never remove from it. Everything in DROP
   * is bare-metal by nature, not by release.
   */
  let dropped = 0;
  for (const f of [...DROP, ...release.drop]) {
    const p = path.join(STAGE_CORE, f);
    if (fs.existsSync(p)) { fs.rmSync(p); dropped++; }
  }

  // 5. vendored libraries and the sketch
  copyDir(LIB_SRC, STAGE_LIB);
  /*
   * WHERE THE SKETCH LIVES IS PER-RELEASE. Every release from v2.1.0 on
   * keeps it at OnlyKey/OnlyKey.ino, but the 2019 beta line has
   * OnlyKey_Beta/OnlyKey_Beta.ino - a different directory AND a different
   * file name. It is staged AS OnlyKey.ino either way, because
   * okemu_sketch.cpp includes that name and the name is not the part that
   * varies between releases; the contents are.
   */
  const sketch = release.sketch || { dir: 'OnlyKey', file: 'OnlyKey.ino' };
  copyDir(path.join(FW, sketch.dir), STAGE_SKETCH);
  if (sketch.file !== 'OnlyKey.ino') {
    const from = path.join(STAGE_SKETCH, sketch.file);
    if (!fs.existsSync(from)) {
      throw new Error(
        `stage: ${release.version} names its sketch ${sketch.dir}/${sketch.file}, ` +
        'which is not in the checkout at this pin');
    }
    fs.renameSync(from, path.join(STAGE_SKETCH, 'OnlyKey.ino'));
  }

  /*
   * 5a. The stock Arduino libraries the firmware uses, staged rather than
   * referenced in place. Staging all three means every include path points
   * inside .stage, so nothing outside this project is ever compiled against
   * directly - and any of them can be patched, which ADC needs.
   */
  for (const lib of ['Time', 'ADC', 'EEPROM']) {
    copyDir(path.join(TLIB, lib), path.join(STAGE_LIB, lib));
  }
  const renamed = defuseTimeHeader();
  /* Only the old trees have it; -1 means this release was already fixed. */
  const shaRenamed = renameCryptoSha256();

  /*
   * 6. The DEBUG gate FIRST, because what it lands on decides which patches
   * are needed. A release ships with it off and the working tree has it on, so
   * this is read from the staged sources rather than assumed from the
   * environment.
   */
  const debugOn = gateDebug(WANT_DEBUG);
  /*
   * And the KEYBOARD gate with it, because upstream asks for that by hand.
   *
   * core/keylayouts.h carries its own switch, KEYLAYOUTS_DEBUG_BUILD, with the
   * comment "comment this out (to match #undef DEBUG in onlykey.h) for a
   * release build" and, above it, "keep it in sync manually". A manual sync
   * nobody performs is how the matrix came to measure every release with
   * twenty-six keyboard layouts compiled OUT: inside that branch every
   * SUPPORT_LAYOUT_* line is commented, and only US English has no guard at
   * all, so selecting German took an empty branch and typed nothing
   * (FINDING-only-us-english-types-on-a-debug-build.md).
   *
   * So it follows the DEBUG gate rather than being a second thing to remember.
   * This does not change what the firmware DOES - it is the same switch
   * upstream flips for a release - it changes which of its two documented
   * configurations gets built.
   */
  gateKeylayouts(debugOn);
  /*
   * The EDITION, read the same way. Reported whether or not it was forced,
   * because a travel build looks like a broken standard one from the outside:
   * set_private returns early, there is no FIDO, and the profile is not
   * encrypted.
   */
  const stdEdition = gateDefine(
    'STD_VERSION',
    '#define STD_VERSION //Define for STD edition firmare, undefine for IN TRVL edition firmware',
    WANT_STD);

  /*
   * The MODEL. Asked for only when OKEMU_MODEL says so - left alone, this reads
   * the sources and reports classic, which is what every release ships as.
   *
   * A release that does not carry the override cannot be asked to be a DUO, and
   * saying so beats producing a classic under a DUO's name: every measurement
   * taken against it would be attributed to the wrong device.
   */
  const duoModel = gateDefine(
    'DEFINED_HWID',
    '#define DEFINED_HWID OK_HW_DUO',
    WANT_DUO,
    { universal: false });
  if (WANT_DUO === true && duoModel !== true) {
    console.error(
      `stage: OKEMU_MODEL=duo, but ${release.version} has no DEFINED_HWID ` +
      'override in onlykey.h - the DUO is newer than this release, so there ' +
      'is no such device to emulate.');
    process.exit(1);
  }

  // 7. documented source-level fixups, plus this release's own
  const patched = applyPatches([
    ...release.patches,
    ...(debugOn === false ? [...DEBUG_OFF_PATCHES, ...release.debugOffPatches] : []),
  ], release.absentPatterns);
  const scs = rewriteSystemBlock();

  const stats = digestStage();
  const info = writeBuildInfo(stats, release, debugOn, stdEdition, duoModel);

  console.log(
    `stage: ${path.relative(OKEMU, STAGE)}\n` +
    `  core files overlaid from OnlyKey-Firmware: ${overlaid}\n` +
    `  emulator overrides applied:                ${overrides}\n` +
    `  bare-metal files dropped:                  ${dropped}\n` +
    `  literal patches applied:                   ${patched}\n` +
    `  system-block registers rebased:            ${scs}\n` +
    `  Time.h consumers repointed at TimeLib.h:   ${renamed}\n` +
    (shaRenamed < 0 ? '' :
      `  Crypto/SHA256.h renamed, consumers repointed: ${shaRenamed}
`) +
    `  staged sources digested:                   ${stats.files} files, ${stats.digest}\n` +
    `  OnlyKey-Firmware / libraries:              ${info.firmware || '?'} / ${info.libraries || '?'}` +
    `
  version:                                   ${release.version} (${release.status})` +
    `
  build:                                     ${debugOn ? 'debug' : 'production'}` +
    `
  edition:                                   ${stdEdition ? 'standard' : 'TRAVEL (STD_VERSION off)'}` +
    `
  model:                                     ${duoModel ? 'DUO' : 'classic'}` +
    `
  storage slot:                              ${release.slot || '(the default)'}`
  );

  checkExpectation(release, stats, debugOn);
}

/*
 * Only stage when RUN, not when required.
 *
 * version-probe.js imports the patch tables to ask which of their patterns
 * still match an older release, and importing a module should not rewrite
 * .stage as a side effect.
 */
if (require.main === module) main();

module.exports = { PATCHES, DEBUG_OFF_PATCHES, DROP, main, versions };