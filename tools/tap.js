#!/usr/bin/env node
/**
 * Tap the app by label, from the terminal.
 *
 *     node tools/tap.js Menu "This Key"          tap each label in turn
 *     node tools/tap.js --scroll 3 "RUN TESTS"   swipe up to find one below the fold
 *     node tools/tap.js --labels                 print what is on screen, tap nothing
 *
 * ## Why
 *
 * Checking one screen used to mean either running the whole e2e runner, which
 * ends with a bundle reload, or guessing coordinates from a screenshot. This
 * is the runner's own tapText() with nothing around it: find the label in a
 * fresh UI dump, tap its centre, say where. A label that is not there is an
 * error naming what is, not a tap into the wrong control.
 *
 * Pair it with `node tools/doctor.js --shot` to see the result.
 */
'use strict';

/*
 * --brad-exception drives the A13 and nothing else: it is found by its model,
 * because its wireless adb address changes on every reconnect - and the command
 * line Brad's permission rule allows must stay the same. Picked BEFORE ./ui loads
 * ./adb, which reads ANDROID_SERIAL once.
 */
if (process.argv.includes('--brad-exception') && !process.env.ANDROID_SERIAL) {
  const {execFileSync} = require('child_process');
  const {ADB} = require('./adb');
  const listed = execFileSync(ADB, ['devices'], {encoding: 'utf8'}).split(/\r?\n/).slice(1)
    .map((l) => l.split('\t')).filter((p) => p[1] === 'device').map((p) => p[0]);
  const a13 = listed.find((s) => {
    try { return execFileSync(ADB, ['-s', s, 'shell', 'getprop', 'ro.product.model'], {encoding: 'utf8'}).trim() === 'SM-S136DL'; } catch { return false; }
  });
  if (!a13) { process.stderr.write('tap: --brad-exception needs the A13 (SM-S136DL) on adb - not found\n'); process.exit(2); }
  process.env.ANDROID_SERIAL = a13;
  delete require.cache[require.resolve('./adb')];
}

const {dumpUi, tapText, visibleLabels, sleep, allLabels, swipeUp, swipeDown} = require('./ui');

const trace = message => process.stdout.write(`  · ${message}\n`);

function argAfter(flag, fallback) {
  const at = process.argv.indexOf(flag);
  if (at === -1) return fallback;
  const v = process.argv[at + 1];
  return v === undefined ? fallback : v;
}

async function main() {
  const args = process.argv.slice(2);
  /* Negative scroll swipes DOWN, for a control above the fold (Save, at the top of an editor). */
  const scroll = Number(argAfter('--scroll', 0));
  /* --hold N long-presses each label for N ms - the key's gesture bands. */
  const hold = Number(argAfter('--hold', 0));
  /*
   * --gap N taps the labels N ms apart from ONE dump, instead of a fresh dump
   * (about two seconds) before each. A PIN is entered at finger speed; a
   * two-second gap between digits is not a finger, and the firmware behaved
   * differently at it (FINDING-the-door-keypad-lost-five-of-seven-presses...).
   */
  const gap = Number(argAfter('--gap', 0));
  const VALUED = new Set(['--scroll', '--below', '--hold', '--gap']);
  const labels = args.filter((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1]));

  /*
   * CONSENT TAPS: THE TESTNET IS THE GATE (Brad, 2026-10-08: "remove the overkill protection";
   * "it should work for testnet overall"). Approve, the press, Confirm, waive, accept loss: tapped
   * when the screen shows the testnet ("TESTNET" - the banner, and the sheet's own title) or the
   * TEST BUILD banner; refused on the live chain. No --test flag and no "TEST:" reason any more:
   * that check read the screen again and failed under load, so the Pixel's Approve was never
   * tapped. The live chain stays Brad's: a production build refuses approvals while adb is on.
   */
  const SENSITIVE = /^(Approve|Press the soft key|Confirm|Yes, waive|Waive…|Accept loss.*|Yes, accept loss.*|Yes, let it sign as me)$/;
  if (labels.some((l) => SENSITIVE.test(l))) {
    const xml = dumpUi({trace});
    const seen = allLabels(xml);
    if (!seen.some((t) => /^TESTNET\b/.test(t) || /^TEST BUILD - debugging lock OFF/.test(t))) {
      throw new Error('refused: a consent tap on the live chain - the testnet (or a TEST build) only');
    }
    /*
     * ONE READ, THEN THE TAP (2026-10-08): the request sheet counts down every second, and a screen
     * read only works in a quiet moment - reading again to find the button cost tens of seconds of
     * the sheet's two minutes. A single consent label is tapped from the read that checked the net.
     */
    if (labels.length === 1 && !scroll && !hold && !gap) {
      const {findByText} = require('./ui');
      const {adb} = require('./adb');
      const spot = findByText(xml, labels[0]);
      if (spot) {
        const off = Number(argAfter('--below', 0));
        adb(['shell', 'input', 'tap', String(spot.x), String(spot.y + off)]);
        trace(`tapped "${labels[0]}" at ${spot.x},${spot.y + off}`);
        return;
      }
    }
  }

  if (args.includes('--labels') || !labels.length) {
    /*
     * SCROLL FIRST, if asked, and WITHOUT a label to hunt for.
     *
     * `--scroll` used to work only as part of a label search, so a screen
     * could not simply be moved - and a long screen whose controls are all
     * below the fold could not be looked at at all. Positive swipes up (shows
     * what is below), negative swipes down (shows what is above), matching
     * tapText's convention so the sign means one thing in this tool.
     *
     *     node tools/tap.js --scroll -4     move up, then list
     *     node tools/tap.js --scroll 3      move down, then list
     */
    let xml = dumpUi({trace});
    for (let i = 0; i < Math.abs(scroll); i++) {
      trace(`swiping ${scroll > 0 ? 'up' : 'down'} (${i + 1}/${Math.abs(scroll)})`);
      if (scroll > 0) swipeUp(xml); else swipeDown(xml);
      await sleep(600);
      xml = dumpUi({trace});
    }

    /*
     * ONE PER LINE, AND ALL OF THEM. This printed a ` | `-joined list capped
     * at 60, so a Preferences screen - which carries well past that - reported
     * its later rows as absent. Three separate theories were formed about why
     * rows were "missing" before the cap was noticed. One per line is also
     * what makes this greppable, which is how it is actually used.
     */
    for (const label of allLabels(xml)) console.log(label);
    return;
  }

  /*
   * `--below N` taps N pixels under the label instead of on it: an input's
   * only text is its placeholder, which several inputs share, while the
   * label above it is unique. Applies to every label in this run.
   */
  const below = Number(argAfter('--below', 0));

  if (gap > 0) {
    const {findByText} = require('./ui');
    const {adb} = require('./adb');
    const xml = dumpUi({trace});
    for (const label of labels) {
      const spot = findByText(xml, label);
      if (!spot) throw new Error(`could not find "${label}" in the dump: ${visibleLabels(xml, 20)}`);
      adb(['shell', 'input', 'tap', String(spot.x), String(spot.y + below)]);
      trace(`tapped "${label}" at ${spot.x},${spot.y + below}`);
      await sleep(gap);
    }
    return;
  }

  for (const label of labels) {
    const spot = await tapText(label, {timeoutMs: 15000, trace, scroll, tapOffsetY: below, holdMs: hold});
    if (hold) trace(`  (held ${hold}ms)`);
    if (below) trace(`  (tapped ${below}px below, at ${spot.x},${spot.y + below})`);
    /* Let the tap land and the next screen draw before looking again. */
    await sleep(700);
  }
}

main().catch(err => {
  console.error(`tap: ${err.message}`);
  process.exit(2);
});
