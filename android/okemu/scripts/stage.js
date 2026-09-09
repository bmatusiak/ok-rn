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
const FW = path.join(CHECKOUTS, 'OnlyKey-Firmware');
const LIB_SRC = path.join(CHECKOUTS, 'libraries');
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
 * Build the firmware the way it ships, with the DEBUG gate off.
 *
 * Set OKEMU_PRODUCTION=1 before `node scripts/stage.js` (the gradle task passes
 * the environment through), then rebuild. Unset, the staged firmware is a DEBUG
 * build exactly as before, and nothing about the default path changes.
 *
 * ## Why this is a stage patch rather than a compiler flag
 *
 * `#define DEBUG` is at onlykey.h:81 - in the firmware SOURCE, not a build
 * option we can pass. -UDEBUG cannot undefine what a header defines. So the
 * only way to build the production variant without editing OnlyKey-Firmware,
 * which is outside this project's write scope, is to patch the staged copy -
 * the same mechanism every other entry here uses.
 *
 * ## What disappears with it
 *
 * The define gates 259 sites in okcore.cpp alone. Two things follow:
 *
 *   - SEREMU, the debug console, is the device's FOURTH interface and exists
 *     only on a DEBUG build. A production device enumerates three.
 *   - Every Serial.print the library matches on. The PIN provisioning flow
 *     waits for "Enter PIN", "Storing PIN", "Confirm PIN" and "Both PINs
 *     Match", and a production build prints none of them.
 *
 * DEBUG_CTAP_VERBOSE goes too. It is a SEPARATE define on the next line and
 * gates its own sites in fido2/device.cpp and okcore.cpp, so leaving it defined
 * would keep printing to a console that is no longer there.
 *
 * The version string carries the difference, which is how a host can tell:
 * onlykey.h defines OKversionkeyword as "-test" under DEBUG and "-prod"
 * otherwise, so this build announces itself as UNLOCKEDv3.0.4-prodc. See
 * node-onlykey-lib/src/device/version.js.
 */
const PRODUCTION = process.env.OKEMU_PRODUCTION === '1';

const PRODUCTION_PATCHES = [
  {
    file: 'libraries/onlykey/onlykey.h',
    edits: [
      ['#define DEBUG //Enable Serial Monitor',
       '//#define DEBUG - removed by stage.js for OKEMU_PRODUCTION=1'],
      ['#define DEBUG_CTAP_VERBOSE //Enable verbose per-request CTAP/U2F presence-test logging (very noisy - fires on every presence test poll, floods Serial/SEREMU)',
       '//#define DEBUG_CTAP_VERBOSE - removed with DEBUG; it prints to a console a production build does not have'],
    ],
  },
];

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
      ['#define factorysectoradr 0x5800 //22528 - 23551',
       '#define factorysectoradr (OKEMU_FLASH_BASE + 0x5800) //22528 - 23551'],
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

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === '.git') continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function applyPatches() {
  let applied = 0, missing = 0;
  const patches = PRODUCTION ? [...PATCHES, ...PRODUCTION_PATCHES] : PATCHES;
  if (PRODUCTION) {
    console.log('stage: OKEMU_PRODUCTION=1 - building with the DEBUG gate OFF');
  }
  for (const p of patches) {
    const target = path.join(STAGE, p.file);
    if (!fs.existsSync(target)) {
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
        console.error(`stage: WARNING - pattern not found in ${p.file}`);
        missing++;
        continue;
      }
      text = text.split(from2).join(from2 === from ? to : crlf(to));
      applied++;
    }
    fs.writeFileSync(target, text);
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
function writeBuildInfo(stats) {
  const out = path.join(OKEMU, '..', '..', 'src', 'generated');
  fs.mkdirSync(out, { recursive: true });
  const info = {
    digest: stats.digest,
    files: stats.files,
    firmware: gitShort(FW),
    libraries: gitShort(LIB_SRC),
    stagedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(out, 'firmware.json'),
    JSON.stringify(info, null, 2) + '\n',
  );
  return info;
}

function main() {
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
      fs.copyFileSync(path.join(FW, f), path.join(STAGE_CORE, f));
      overlaid++;
    }
  }

  // 3. our host implementations of the peripheral drivers
  let overrides = 0;
  if (fs.existsSync(OVERRIDE)) {
    for (const f of fs.readdirSync(OVERRIDE)) {
      if (/\.(c|cpp|h)$/.test(f)) {
        fs.copyFileSync(path.join(OVERRIDE, f), path.join(STAGE_CORE, f));
        overrides++;
      }
    }
  }

  // 4. drop the bare-metal files
  let dropped = 0;
  for (const f of DROP) {
    const p = path.join(STAGE_CORE, f);
    if (fs.existsSync(p)) { fs.rmSync(p); dropped++; }
  }

  // 5. vendored libraries and the sketch
  copyDir(LIB_SRC, STAGE_LIB);
  copyDir(path.join(FW, 'OnlyKey'), STAGE_SKETCH);

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

  // 6. documented source-level fixups
  const patched = applyPatches();
  const scs = rewriteSystemBlock();

  const stats = digestStage();
  const info = writeBuildInfo(stats);

  console.log(
    `stage: ${path.relative(OKEMU, STAGE)}\n` +
    `  core files overlaid from OnlyKey-Firmware: ${overlaid}\n` +
    `  emulator overrides applied:                ${overrides}\n` +
    `  bare-metal files dropped:                  ${dropped}\n` +
    `  literal patches applied:                   ${patched}\n` +
    `  system-block registers rebased:            ${scs}\n` +
    `  Time.h consumers repointed at TimeLib.h:   ${renamed}\n` +
    `  staged sources digested:                   ${stats.files} files, ${stats.digest}\n` +
    `  OnlyKey-Firmware / libraries:              ${info.firmware || '?'} / ${info.libraries || '?'}`
  );
}

main();
