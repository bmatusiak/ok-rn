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
  const scroll = Number(argAfter('--scroll', 0));
  const labels = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--scroll');

  if (args.includes('--labels') || !labels.length) {
    console.log(visibleLabels(dumpUi({trace}), 60));
    return;
  }

  for (const label of labels) {
    await tapText(label, {timeoutMs: 15000, trace, scroll});
    /* Let the tap land and the next screen draw before looking again. */
    await sleep(700);
  }
}

main().catch(err => {
  console.error(`tap: ${err.message}`);
  process.exit(2);
});
