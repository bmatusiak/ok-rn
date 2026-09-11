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

const {dumpUi, tapText, visibleLabels, sleep} = require('./ui');

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
  const VALUED = new Set(['--scroll', '--below', '--hold']);
  const labels = args.filter((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1]));

  if (args.includes('--labels') || !labels.length) {
    console.log(visibleLabels(dumpUi({trace}), 60));
    return;
  }

  /*
   * `--below N` taps N pixels under the label instead of on it: an input's
   * only text is its placeholder, which several inputs share, while the
   * label above it is unique. Applies to every label in this run.
   */
  const below = Number(argAfter('--below', 0));

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
