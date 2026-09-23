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
