#!/usr/bin/env node
/*
 * Run the on-device e2e suite and report the result.
 *
 * test-moniker runs its tests inside the app, which is the only place they mean
 * anything - the firmware is a .so reached over JNI, and none of that exists in
 * Node or under Jest. The cost is that starting a run has always meant tapping
 * a button on the phone, so the suite tended not to get run.
 *
 * This drives it end to end: launch, select the E2E tab, press RUN TESTS, and
 * read the verdict back out of logcat. Exit status is the verdict, so it works
 * from CI as well as from a terminal.
 *
 * Elements are located by TEXT out of a live uiautomator dump rather than by
 * hardcoded coordinates. Coordinates are wrong the moment anything moves, on a
 * different screen size, or in a different orientation - and a tap that lands
 * on nothing produces a run that simply never starts, which looks exactly like
 * a hang.
 */
'use strict';

const {execFileSync} = require('child_process');
const path = require('path');
const os = require('os');

const PACKAGE = 'com.okrn';
const ACTIVITY = `${PACKAGE}/.MainActivity`;

const ADB =
  process.env.ADB ||
  path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'Android',
    'Sdk',
    'platform-tools',
    process.platform === 'win32' ? 'adb.exe' : 'adb',
  );

const serial = process.env.ANDROID_SERIAL || null;

function adb(args, opts = {}) {
  const full = serial ? ['-s', serial, ...args] : args;
  return execFileSync(ADB, full, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts});
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The current view hierarchy, as XML. */
function dumpUi() {
  // The dump is written on the device and read back; -o - is not supported on
  // every Android version, so this takes the portable route.
  adb(['shell', 'uiautomator', 'dump', '/sdcard/ok-e2e-ui.xml']);
  return adb(['shell', 'cat', '/sdcard/ok-e2e-ui.xml']);
}

/**
 * Centre of the node carrying this label, preferring one that is clickable.
 *
 * React Native renders a pressable as a ViewGroup with the label on
 * `content-desc`, and the visible text as a separate NON-clickable child. Both
 * carry "E2E". Tapping the child's centre usually works by falling through to
 * the parent, but not always - and when it does not, the run simply never
 * starts, which is indistinguishable from a hang. So the clickable node wins
 * when there is one.
 *
 * `bounds` is "[x1,y1][x2,y2]".
 */
function findByText(xml, label) {
  let fallback = null;

  for (const node of xml.split('<node ')) {
    const text = /text="([^"]*)"/.exec(node);
    const desc = /content-desc="([^"]*)"/.exec(node);
    const matches = (text && text[1] === label) || (desc && desc[1] === label);
    if (!matches) continue;

    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
    if (!b) continue;
    const [, x1, y1, x2, y2] = b.map(Number);
    const spot = {x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2)};

    if (/clickable="true"/.test(node)) return spot;
    if (!fallback) fallback = spot;
  }
  return fallback;
}

async function tapText(label, {timeoutMs = 15000} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const spot = findByText(dumpUi(), label);
    if (spot) {
      adb(['shell', 'input', 'tap', String(spot.x), String(spot.y)]);
      return spot;
    }
    if (Date.now() > deadline) {
      throw new Error(`could not find "${label}" on screen within ${timeoutMs}ms`);
    }
    await sleep(500);
  }
}

async function main() {
  const keepRunning = process.argv.includes('--no-restart');

  if (!keepRunning) {
    adb(['shell', 'am', 'force-stop', PACKAGE]);
  }
  adb(['logcat', '-c']);
  adb(['shell', 'am', 'start', '-n', ACTIVITY]);

  /*
   * Wait for the UI, not for a fixed delay.
   *
   * A debug build fetches its bundle from Metro, and after a source change
   * that rebuild can take the better part of a minute - far longer than any
   * sleep worth hardcoding. The soft-key screen also auto-starts the firmware
   * on mount, so this doubles as letting that settle before the suite's own
   * stop/start races it.
   */
  /*
   * The suite lives behind the drawer now, not on a tab bar.
   *
   * "Menu" is the accessibility label on the logo in the top bar, which is
   * what opens the drawer; "Testing" is the item inside it. That item exists
   * only in testing mode - which defaults ON in a debug build precisely so
   * this runner does not stall at a PIN pad it cannot type on.
   */
  await tapText('Menu', {timeoutMs: 120000});
  await sleep(600);
  await tapText('Testing', {timeoutMs: 15000});
  await sleep(1500);

  /*
   * MonikerView auto-runs once on mount, so on a fresh launch the tab press has
   * already started a run and the button reads "RUNNING..." rather than
   * "RUN TESTS". Insisting on the press there fails against a suite that is
   * working correctly - which is exactly what it did the first time.
   *
   * So: press it only if it is actually offered. On a revisit, where the
   * harness has already finished, it is the only thing that starts a run.
   */
  const idle = findByText(dumpUi(), 'RUN TESTS');
  if (idle) {
    adb(['shell', 'input', 'tap', String(idle.x), String(idle.y)]);
  } else {
    process.stdout.write('a run was already under way' + '\\n');
  }

  process.stdout.write('running');
  const deadline = Date.now() + 180000;
  let log = '';
  for (;;) {
    log = adb(['logcat', '-d']);
    if (/TEST COMPLETE/.test(log)) break;
    if (Date.now() > deadline) {
      process.stdout.write('\n');
      throw new Error('the suite did not finish within 180s');
    }
    process.stdout.write('.');
    await sleep(2000);
  }
  process.stdout.write('\n\n');

  const lines = log
    .split(/\r?\n/)
    .filter(l => l.includes('[Moniker]'))
    .map(l => l.replace(/^.*\[Moniker\]',?\s*/, '').replace(/^'|'$/g, ''));

  for (const line of lines) {
    console.log(line.replace(/^'|',?$/g, ''));
  }

  const verdict = /Passed:\s*(\d+)\s*Failed:\s*(\d+)/.exec(log);
  if (!verdict) {
    throw new Error('the suite finished but printed no verdict');
  }
  const [, passed, failed] = verdict.map(Number);

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  passed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(`\ne2e: ${err.message}`);
  process.exit(2);
});
