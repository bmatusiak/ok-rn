#!/usr/bin/env node
/*
 * Turn the firmware's keyboard layout tables into data the library can invert.
 *
 * WHY THIS IS GENERATED AND NOT WRITTEN
 *
 * The mobile app is both the key and the host, so a slot's contents arrive
 * in-process as HID keyboard reports rather than being typed into somebody
 * else's window. Reading them back is what turns the app into a password
 * manager - but a report carries HID USAGE CODES, not characters, and the
 * mapping is the layout table the firmware was compiled with.
 *
 * That table is 6600 lines of `ASCII_41=KEY_A + SHIFT_MASK;` across 28 layouts.
 * Transcribing it by hand would be several thousand opportunities to put one
 * character in the wrong place, and a single wrong entry is a password that
 * comes back subtly wrong - which is worse than one that fails to come back at
 * all, because it looks like an answer. So the table is parsed out of the
 * firmware source instead, and this file is the only place that knows how.
 *
 * WHAT IT READS
 *
 *   .stage/core/keylayouts.h   KEY_* / MODIFIERKEY_* / LAYOUT_* defines
 *   .stage/core/keylayouts.c   update_keyboard_layout(), one block per layout
 *
 * Both are staged copies; nothing outside ok-rn is touched.
 *
 * THE SUPPORT_LAYOUT GUARDS ARE DELIBERATELY IGNORED
 *
 * keylayouts.c wraps every layout but US English in `#if defined(
 * SUPPORT_LAYOUT_x)`, and our build leaves all of them off (see
 * FINDING-only-us-english-types-on-a-debug-build.md). The guards describe what
 * one BUILD compiles in; the tables describe what a layout MEANS. The library
 * is shared with apps that talk to real hardware running a release build, so it
 * wants the meaning. Which layouts a given device can actually type is a
 * separate question, and the answer is on the device.
 *
 * Usage:  node tools/gen-keylayouts.js [--check]
 *   --check  fail if the generated file is out of date, rather than rewriting
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'android', 'okemu', '.stage', 'core');
const OUT = path.join(
  ROOT, '..', 'node-onlykey-lib', 'src', 'device', 'keylayouts.data.js',
);

/* ------------------------------------------------------------------ header */

/**
 * Every `#define NAME (value)` in keylayouts.h, resolved.
 *
 * The values are small arithmetic expressions over earlier defines
 * (`( 4 | 0xF000 )`, `KEY_ENTER`), so they are resolved in file order with a
 * running symbol table rather than by pattern-matching a shape.
 */
function readDefines(src) {
  const syms = new Map();
  const re = /^#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(src))) {
    const [, name, raw] = m;
    if (raw.includes('(') && raw.includes(')') && /\w\s*\(/.test(raw)) continue; // function-like
    const value = evaluate(raw, syms);
    if (value !== null) syms.set(name, value);
  }
  return syms;
}

/**
 * A C constant expression restricted to what these two files actually use:
 * integer literals, identifiers, `|`, `+`, and parentheses.
 *
 * Deliberately not a general evaluator and deliberately not `eval`. Anything it
 * does not recognise returns null, and the caller treats that as "not a
 * constant" - so a shape this does not understand is skipped loudly at the call
 * site rather than silently producing a wrong number.
 */
function evaluate(expr, syms) {
  const cleaned = expr.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '').trim();
  if (!cleaned) return null;
  if (!/^[\s()|+0-9A-Za-zxX_]*$/.test(cleaned)) return null;

  const tokens = cleaned.match(/0[xX][0-9a-fA-F]+|\d+|[A-Za-z_][A-Za-z0-9_]*|[()|+]/g);
  if (!tokens) return null;

  let total = 0;
  let depth = 0;
  for (const t of tokens) {
    if (t === '(') { depth++; continue; }
    if (t === ')') { depth--; continue; }
    if (t === '|' || t === '+') continue;   // both combine disjoint bits here
    if (/^0[xX]/.test(t)) { total |= parseInt(t, 16); continue; }
    if (/^\d+$/.test(t)) { total |= parseInt(t, 10); continue; }
    if (!syms.has(t)) return null;
    total |= syms.get(t);
  }
  if (depth !== 0) return null;
  return total >>> 0;
}

/**
 * The SUPPORT_LAYOUT_* macros this header actually enables.
 *
 * keylayouts.h has both lists - one under #ifdef KEYLAYOUTS_DEBUG_BUILD with
 * everything commented out, one under #else with everything enabled - so which
 * branch is live depends on whether KEYLAYOUTS_DEBUG_BUILD is itself
 * uncommented. This app must run a debug build (the provisioning path is
 * #ifdef DEBUG), so in practice the live branch is the empty one and only the
 * UNGUARDED block - US English, which also covers Dvorak and an unset layout -
 * is compiled in.
 */
function activeSupportMacros(header) {
  const debugBuild = /^#defines+KEYLAYOUTS_DEBUG_BUILD/m.test(header);

  const start = header.indexOf('#ifdef KEYLAYOUTS_DEBUG_BUILD');
  const middle = header.indexOf('#else', start);
  const end = header.indexOf('#endif', middle);
  if (start < 0 || middle < 0 || end < 0) {
    throw new Error('keylayouts.h no longer has the KEYLAYOUTS_DEBUG_BUILD branch');
  }

  const branch = debugBuild
    ? header.slice(start, middle)
    : header.slice(middle, end);

  const active = new Set();
  for (const m of branch.matchAll(/^#defines+(SUPPORT_LAYOUT_[A-Z_]+)/gm)) {
    active.add(m[1]);
  }
  return active;
}

/* ------------------------------------------------------------------ layouts */

/*
 * The accents a layout can carry, named as keylayouts.c names them. Each has a
 * _BITS value (which accent a character needs) and a DEADKEY_ value (the
 * keystroke that produces it), and a decoder needs both to put the two halves
 * of an accented character back together.
 */
const ACCENTS = [
  'CIRCUMFLEX', 'ACUTE_ACCENT', 'GRAVE_ACCENT', 'TILDE', 'DIAERESIS',
  'CEDILLA', 'RING_ABOVE', 'DEGREE_SIGN', 'CARON', 'BREVE', 'OGONEK',
  'DOT_ABOVE', 'DOUBLE_ACUTE',
];

const ASCII_FIRST = 0x20;
const ASCII_COUNT = 96;

/**
 * The body of update_keyboard_layout(), split into the blocks that assign
 * tables, in source order.
 *
 * The structure is two chains rather than one, and getting that wrong silently
 * gives Dvorak a US table:
 *
 *     if (USA_ENGLISH || DVORAK || 0x00) { ...US tables... }     // chain A
 *     if (DVORAK) { ...Dvorak tables... }                        // chain B
 *     else if (US_INTERNATIONAL) { ... }
 *     else if (GERMAN) { ... }
 *
 * Chain A is the base and runs for US, Dvorak and an unset layout. Chain B then
 * OVERRIDES it, and Dvorak is the one layout that appears in both. So a layout
 * is built by applying every block whose condition it satisfies, in order.
 */
function readLayoutBlocks(src, headerSrc) {
  const start = src.indexOf('void update_keyboard_layout() {');
  if (start < 0) throw new Error('update_keyboard_layout() not found');
  const end = src.indexOf('keycodes_ascii[0] = M(ASCII_20);', start);
  if (end < 0) throw new Error('the keycodes_ascii fill was not found');
  const body = src.slice(start, end);

  const lines = body.split('\n');
  const blocks = [];
  let current = null;

  const condRe = /^(?:else\s+)?if\s*\((.*KeyboardLayout\[0\].*)\)\s*\{\s*$/;

  /*
   * Which SUPPORT_LAYOUT_* macros the header actually enables.
   *
   * The tables are parsed regardless of the guards - the table is what a
   * layout MEANS - but whether a given build can type it is a different
   * question, and one a settings screen has to answer or it will offer a
   * choice that makes the key type nothing at all.
   */
  const enabled = activeSupportMacros(headerSrc);
  let guard = null;

  for (const line of lines) {
    const t = line.trim();
    const open = /^#if\s+defined\((SUPPORT_LAYOUT_[A-Z_]+)\)/.exec(t);
    if (open) { guard = open[1]; if (current) current.guard = guard; }
    else if (/^#endif/.test(t)) { guard = null; }

    const cond = condRe.exec(t);
    if (cond) {
      /*
       * The guard is INHERITED, not reset.
       *
       * A block's own `#if defined(SUPPORT_LAYOUT_x)` sits on the line after
       * it, so it is filled in above. But blocks also NEST: Danish Mac is an
       * inner `if (KeyboardLayout[0] == LAYOUT_DANISH_MAC)` inside the Danish
       * block, already under `#if defined(SUPPORT_LAYOUT_DANISH)`. Starting it
       * at null reported Danish Mac as compiled in on a build that guards
       * Danish out.
       */
      current = {matches: layoutIdsIn(cond[1]), assigns: [], guard, enabled};
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    const a = /^([A-Z][A-Z0-9_]*)\s*=\s*([^;]+);/.exec(line.trim());
    /*
     * Only the ASCII table and the masks it is written in terms of.
     *
     * The ISO-8859-1 and UNICODE_EXTRA tables in the same blocks are not merely
     * unneeded, they do not parse: keylayouts.c carries a typo,
     *
     *     ISO_8859_1_C2=CIRCUMFLEX_BITS=+ KEY_A + SHIFT_MASK;
     *
     * which C reads as an assignment nested inside an assignment - it stores
     * into CIRCUMFLEX_BITS on the way past. Twelve lines are like that. Every
     * ASCII_ row in a block precedes them, so the ASCII table this generator
     * produces is unaffected; see
     * FINDING-keylayouts-nested-assignment-typo.md for what it does reach.
     */
    if (a && (/^ASCII_[0-9A-F]{2}$/.test(a[1]) ||
              /_MASK$|_BITS$/.test(a[1]) ||
              /^DEADKEY_[A-Z_]+$/.test(a[1]) ||
              a[1] === 'KEY_NON_US_100')) {
      current.assigns.push([a[1], a[2]]);
    }
  }
  if (!blocks.length) throw new Error('no layout blocks parsed');
  return blocks;
}

/** The layout names a block's condition accepts. `0x00` means "unset". */
function layoutIdsIn(cond) {
  const names = cond.match(/LAYOUT_[A-Z_]+/g) || [];
  const unset = /==\s*0x00/.test(cond);
  return {names, unset};
}

/* --------------------------------------------------------------- assembly */

function buildLayout(name, blocks, syms) {
  /* Per-layout state. The masks are assigned by the block before the ASCII
   * lines that reference them, so one ordered pass is enough. */
  const local = new Map(syms);
  for (const k of [
    'SHIFT_MASK', 'ALTGR_MASK', 'RCTRL_MASK', 'KEYCODE_MASK', 'DEADKEYS_MASK',
    'CIRCUMFLEX_BITS', 'ACUTE_ACCENT_BITS', 'GRAVE_ACCENT_BITS', 'TILDE_BITS',
    'DIAERESIS_BITS', 'CEDILLA_BITS', 'RING_ABOVE_BITS', 'DEGREE_SIGN_BITS',
    'CARON_BITS', 'BREVE_BITS', 'OGONEK_BITS', 'DOT_ABOVE_BITS',
    'DOUBLE_ACUTE_BITS', 'KEY_NON_US_100',
  ]) local.set(k, 0);
  for (const k of ACCENTS) local.set('DEADKEY_' + k, 0);
  for (let i = 0; i < ASCII_COUNT; i++) {
    local.set('ASCII_' + (ASCII_FIRST + i).toString(16).toUpperCase().padStart(2, '0'), 0);
  }

  let applied = 0;
  let compiledIn = false;
  for (const block of blocks) {
    const {names, unset} = block.matches;
    if (!names.includes(name) && !(unset && name === null)) continue;
    applied++;
    /*
     * A layout can type if ANY block that applies to it is compiled in. The US
     * base block is unguarded, which is why Dvorak still types (as US English)
     * on a build where its own block is guarded out.
     */
    if (!block.guard || block.enabled.has(block.guard)) compiledIn = true;
    for (const [lhs, rhs] of block.assigns) {
      const value = evaluate(rhs, local);
      if (value === null) {
        throw new Error(`${name}: cannot evaluate ${lhs} = ${rhs}`);
      }
      local.set(lhs, value);
    }
  }

  const keycodeMask = local.get('KEYCODE_MASK') || 0;
  const ascii = [];
  for (let i = 0; i < ASCII_COUNT; i++) {
    const key = 'ASCII_' + (ASCII_FIRST + i).toString(16).toUpperCase().padStart(2, '0');
    /* M(n) in keylayouts.c:115 - the same truncation the firmware ships. */
    ascii.push((local.get(key) & keycodeMask) >>> 0);
  }

  /*
   * The accent pairs, kept only where BOTH halves exist. A _BITS with no
   * DEADKEY_ is an accent a character asks for that nothing can type, which is
   * a layout table this generator should not pretend to understand.
   */
  const deadkeys = {};
  for (const k of ACCENTS) {
    const bits = local.get(k + '_BITS') || 0;
    const key = local.get('DEADKEY_' + k) || 0;
    if (bits && key) deadkeys[k] = {bits, key};
  }

  return {
    applied,
    compiledIn,
    deadkeys,
    shiftMask: local.get('SHIFT_MASK') || 0,
    altgrMask: local.get('ALTGR_MASK') || 0,
    rctrlMask: local.get('RCTRL_MASK') || 0,
    keycodeMask,
    deadkeysMask: local.get('DEADKEYS_MASK') || 0,
    nonUs100: local.get('KEY_NON_US_100') || 0,
    ascii,
  };
}

/* -------------------------------------------------------------------- main */

function main() {
  const check = process.argv.includes('--check');

  const header = fs.readFileSync(path.join(CORE, 'keylayouts.h'), 'utf8');
  const source = fs.readFileSync(path.join(CORE, 'keylayouts.c'), 'utf8');

  const syms = readDefines(header);
  const blocks = readLayoutBlocks(source, header);

  const layoutNames = [...header.matchAll(/^#define\s+(LAYOUT_[A-Z_]+)\s+(0x[0-9a-fA-F]+)/gm)]
    .map(m => ({name: m[1], id: parseInt(m[2], 16)}));
  if (!layoutNames.length) throw new Error('no LAYOUT_* defines found');

  const layouts = {};
  let empty = 0;
  for (const {name, id} of layoutNames) {
    const built = buildLayout(name, blocks, syms);
    if (!built.applied) {
      /* A layout with no block at all is a parse failure, not a fact. */
      throw new Error(`${name}: no layout block matched`);
    }
    if (built.ascii.every(v => v === 0)) empty++;
    layouts[name.replace(/^LAYOUT_/, '')] = {
      id,
      shiftMask: built.shiftMask,
      altgrMask: built.altgrMask,
      rctrlMask: built.rctrlMask,
      keycodeMask: built.keycodeMask,
      deadkeysMask: built.deadkeysMask,
      nonUs100: built.nonUs100,
      compiledIn: built.compiledIn,
      deadkeys: built.deadkeys,
      ascii: built.ascii,
    };
  }

  const out = render(layouts, layoutNames.length, empty);

  if (check) {
    const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (existing !== out) {
      console.error('keylayouts.data.js is out of date - run node tools/gen-keylayouts.js');
      process.exit(1);
    }
    console.log(`keylayouts.data.js is current (${layoutNames.length} layouts)`);
    return;
  }

  fs.writeFileSync(OUT, out);
  console.log(
    `wrote ${path.relative(ROOT, OUT)}: ${layoutNames.length} layouts, ` +
      `${empty} with no tables in this build`,
  );
}

function render(layouts, total, empty) {
  const entries = Object.entries(layouts).map(([name, l]) => {
    const rows = [];
    for (let i = 0; i < l.ascii.length; i += 12) {
      rows.push('      ' + l.ascii.slice(i, i + 12).map(v => String(v)).join(', ') + ',');
    }
    return [
      `  ${name}: {`,
      `    id: ${l.id},`,
      `    shiftMask: ${l.shiftMask}, altgrMask: ${l.altgrMask}, rctrlMask: ${l.rctrlMask},`,
      `    keycodeMask: ${l.keycodeMask}, deadkeysMask: ${l.deadkeysMask}, nonUs100: ${l.nonUs100},`,
      `    compiledIn: ${l.compiledIn},`,
      `    deadkeys: ${JSON.stringify(l.deadkeys)},`,
      '    ascii: [',
      ...rows,
      '    ],',
      '  },',
    ].join('\n');
  });

  return [
    '/*',
    ' * GENERATED - do not edit. Source: ok-rn/tools/gen-keylayouts.js, which',
    " * parses the firmware's own keylayouts.h and keylayouts.c.",
    ' *',
    ` * ${total} layouts. ${empty} of them have empty tables, because keylayouts.c`,
    ' * wraps every layout but US English in #if defined(SUPPORT_LAYOUT_x) and this',
    ' * build leaves those off. An empty table is not a bug in this file - it is the',
    ' * firmware saying that layout types nothing at all. The library reports that as',
    ' * `supported: false` rather than silently decoding to an empty string.',
    ' *',
    ' * `ascii[i]` is the keycode for character 0x20 + i, already masked with',
    " * KEYCODE_MASK exactly as the firmware's M() macro does. The low 6 bits are the",
    ' * HID usage; the mask bits above them say which modifiers the character needs.',
    ' */',
    "'use strict';",
    '',
    'const LAYOUTS = {',
    ...entries,
    '};',
    '',
    'module.exports = { LAYOUTS };',
    '',
  ].join('\n');
}

main();
