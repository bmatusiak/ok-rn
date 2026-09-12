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

const fs = require('fs');
const path = require('path');

/*
 * adb, the serial and the foreground check are shared with tools/doctor.js.
 * They were inlined here until a second tool needed them.
 */
const {adb, foregroundApp} = require('./adb');
/* Reading and tapping the screen lives in ./ui.js, shared with tools/tap.js. */
const {dumpUi: dumpUiShared, findByText, visibleLabels, swipeUp, tapText: tapTextShared, sleep} = require('./ui');

const PACKAGE = 'com.okrn';
const ACTIVITY = `${PACKAGE}/.MainActivity`;


/**
 * Say what the runner is doing, as it does it.
 *
 * This drives a phone through its UI, so when a step does not find what it
 * expects there is no stack trace to read - the runner simply waits out its
 * timeout and reports nothing. Measured the hard way: a slow Metro made the
 * first tap wait two minutes while the terminal printed one line, which is
 * indistinguishable from a hang.
 *
 * So every navigation step announces itself and every failure carries what
 * was ACTUALLY on screen.
 */
const TRACE = !process.argv.includes('--quiet');
function trace(message) {
  if (TRACE) process.stdout.write(`  · ${message}${String.fromCharCode(10)}`);
}

/**
 * WAIT for our app to be on screen, then say so.
 *
 * Every step below reads a UI dump and taps coordinates out of it. If the app
 * has crashed, been killed, or is behind a system dialog, those dumps are of
 * SOMETHING ELSE - and tapping into it is how a run spends two minutes failing
 * to find a button that was never going to be there.
 *
 * Polled, not asserted. The first version asserted the instant after
 * `am start` and reported "nothing is on screen" for an app that Android
 * displayed 400 ms later - a false alarm from the runner's own check.
 */
async function waitForApp({timeoutMs = 60000} = {}) {
  const started = Date.now();
  let front = null;
  for (;;) {
    front = foregroundApp();
    if (front === PACKAGE) {
      const took = Date.now() - started;
      trace(`${PACKAGE} is on screen` + (took > 1000 ? ` after ${(took / 1000).toFixed(1)}s` : ''));
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `${PACKAGE} did not come to the front within ${timeoutMs}ms - ` +
        (front ? `"${front}" is there instead.` : 'nothing is focused.') +
        ' The app was killed, crashed during the bundle load, or a system dialog is in front of it.',
      );
    }
    await sleep(500);
  }
}

function assertOnTask(step) {
  const front = foregroundApp();
  if (front === PACKAGE) return;
  throw new Error(
    `${step}: ${PACKAGE} is not on screen - ` +
    (front ? `"${front}" is instead.` : 'nothing is.') +
    ' The app was killed, crashed, or a system dialog is in front of it.',
  );
}

/** The current view hierarchy, as XML. */
/** The runner's dump, with its trace attached. */
function dumpUi() {
  return dumpUiShared({trace});
}

/** One of the suite's logcat lines, stripped to what the harness said. */
function stripMoniker(line) {
  return line.replace(/^.*\[Moniker\]',?\s*/, '').replace(/^'|',?$/g, '');
}

/**
 * If Android's USB permission dialog is in front, accept it. True if it was.
 *
 * The dialog names the device and offers OK; anything else in front of the
 * app is left alone and reported by the caller. Read from a fresh dump - the
 * dialog is a separate window, so the app's own dump never shows it.
 */
function acceptUsbPrompt() {
  let xml;
  try {
    xml = dumpUiShared({trace});
  } catch (_) {
    return false;
  }
  if (!/ONLYKEY|USB/i.test(xml)) return false;
  const ok = findByText(xml, 'OK') || findByText(xml, 'Allow');
  if (!ok) return false;
  trace('accepting the USB permission prompt for the key');
  adb(['shell', 'input', 'tap', String(ok.x), String(ok.y)]);
  return true;
}

/** The runner's tap, with its trace attached. */
function tapText(label, opts = {}) {
  return tapTextShared(label, {...opts, trace});
}

/**
 * `--only derive,deriveParity` runs just those suites.
 *
 * Iterating on one suite otherwise means sitting through all thirteen, against
 * a device that has to be unlocked and pressed. The names are the suite
 * functions' own names, which is what each file passes to describe().
 */
const ONLY_FILE = path.join(__dirname, '..', '__e2e_tests__', 'only.js');

function readOnlyArg() {
  const at = process.argv.indexOf('--only');
  if (at === -1) return [];
  const value = process.argv[at + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('--only needs a comma-separated list of suite names');
  }
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Point the app at a subset, and hand back a function that undoes it.
 *
 * The restore runs in a `finally`, on process exit AND on a signal. A filter
 * left behind would make the NEXT full run skip most of the suite while still
 * reporting a pass, and a stale filter that says "PASS" is worse than no
 * filter at all.
 */
function applyOnly(names) {
  const original = fs.readFileSync(ONLY_FILE, 'utf8');
  const FILTER = /module\.exports = \[[^\]]*\];/;
  /*
   * The restore writes [] - NOT whatever was there before. A run killed from
   * outside (Ctrl-C on Windows delivers no signal, so no handler runs) leaves
   * its filter behind, and a restore that put "the previous contents" back
   * would carry that stale filter into the next run. tools/doctor.js caught
   * exactly that.
   */
  const clean = original.replace(FILTER, 'module.exports = [];');
  const restore = () => fs.writeFileSync(ONLY_FILE, clean);

  if (!names.length) {
    if (clean !== original) {
      console.log('e2e: a stale --only filter was left behind; reset to the full suite');
      restore();
    }
    return () => {};
  }

  const body = original.replace(FILTER, `module.exports = ${JSON.stringify(names)};`);
  fs.writeFileSync(ONLY_FILE, body);

  console.log(`e2e: running only ${names.join(', ')}`);
  return restore;
}

/**
 * Stop after the first suite that fails. ON BY DEFAULT; `--no-bail` turns it off.
 *
 * One real failure usually produces dozens of cascade ones, and on this suite
 * they are not free: a v2.1.2 sweep failed a single unlock and then reported
 * 120 failures, each paying a full timeout, with the repeated attempts
 * exhausting the device's PIN attempts so that everything afterwards answered
 * "password attempts for this session exceeded". Waiting that out told nobody
 * anything the first failure had not.
 *
 * The failing suite still finishes - see harness/harness.js for why that
 * boundary and not the test.
 *
 * `--no-bail` is for the case where the whole picture is the question: what an
 * old firmware can and cannot do, rather than whether it is green.
 */
const OPTIONS_FILE = path.join(__dirname, '..', '__e2e_tests__', 'runOptions.js');
const BAIL_DEFAULT = true;

/**
 * Set bail for one run, and hand back the undo.
 *
 * Restored exactly like the --only filter, for the same reason and with the
 * same caveat: a run killed from outside leaves the file written, so the
 * restore puts back the DEFAULT rather than whatever was there before.
 */
function applyOptions(bail) {
  const original = fs.readFileSync(OPTIONS_FILE, 'utf8');
  const FLAG = /module\.exports = \{bail: (?:true|false)\};/;
  const wanted = `module.exports = {bail: ${bail}};`;
  const clean = original.replace(FLAG, `module.exports = {bail: ${BAIL_DEFAULT}};`);
  const restore = () => fs.writeFileSync(OPTIONS_FILE, clean);

  if (bail === BAIL_DEFAULT) {
    if (clean !== original) {
      console.log(`e2e: a stale bail setting was left behind; reset to bail=${BAIL_DEFAULT}`);
      restore();
    }
    return () => {};
  }

  fs.writeFileSync(OPTIONS_FILE, original.replace(FLAG, wanted));
  console.log('e2e: --no-bail - running every suite even after one fails');
  return restore;
}

async function main() {
  const keepRunning = process.argv.includes('--no-restart');

  if (!keepRunning) {
    adb(['shell', 'am', 'force-stop', PACKAGE]);
  }
  adb(['logcat', '-c']);
  /*
   * A bigger ring. The default holds well under a minute of this suite's
   * output; the verdict line is only needed at the end, but a buffer that
   * cannot hold the whole run makes every earlier line a coin toss for
   * anyone reading the log afterwards. Not every device allows it.
   */
  try {
    adb(['logcat', '-G', '16M']);
  } catch (_) {
    trace('could not enlarge the logcat buffer; continuing with the default');
  }
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
  /*
   * CHECK IT IS OURS FIRST. The launch may have died during the bundle load,
   * and every failure after this point would then be about the wrong app -
   * reported as a missing button rather than as a missing app.
   */
  await waitForApp({timeoutMs: 60000});

  await tapText('Menu', {timeoutMs: 120000});
  await sleep(600);
  await tapText('Testing', {timeoutMs: 15000});
  await sleep(1500);
  assertOnTask('after opening the Testing tab');

  /*
   * MonikerView auto-runs once on mount, so on a fresh launch the tab press has
   * already started a run and the button reads "RUNNING..." rather than
   * "RUN TESTS". Insisting on the press there fails against a suite that is
   * working correctly - which is exactly what it did the first time.
   *
   * So: press it only if it is actually offered. On a revisit, where the
   * harness has already finished, it is the only thing that starts a run.
   */
  /*
   * The button is at the BOTTOM of the Testing tab, under the soft-key panel,
   * and uiautomator only dumps what is drawn. After the naming pass made that
   * panel taller the button fell below the fold - and the old branch below
   * then reported "a run was already under way" and waited out the whole
   * budget for a run that never started. So: scroll for it, a bounded number
   * of times, and say so each time.
   */
  let beforeRun = '';
  let idle = null;
  for (let attempt = 0; ; attempt++) {
    beforeRun = dumpUi();
    idle = findByText(beforeRun, 'RUN TESTS');
    if (idle || /Running|RUNNING/.test(beforeRun) || attempt === 3) break;
    trace(`RUN TESTS is not on screen, swiping up (${attempt + 1}/3)`);
    swipeUp(beforeRun);
    await sleep(800);
  }

  if (idle) {
    trace(`pressing RUN TESTS at ${idle.x},${idle.y}`);
    adb(['shell', 'input', 'tap', String(idle.x), String(idle.y)]);
  } else if (/Running|RUNNING/.test(beforeRun)) {
    trace('a run was already under way');
  } else {
    /*
     * NEITHER, which is a real failure. It used to be reported as "already
     * under way", so a run that never started looked like one in progress and
     * then timed out with nothing to say.
     */
    throw new Error(
      'the Testing tab is open but neither RUN TESTS nor a running suite is on '
      + `it, even after scrolling.\n  on screen: ${visibleLabels(beforeRun)}`,
    );
  }

  /*
   * Generous, because the suite's length depends on the firmware build.
   *
   * A production build has no debug console, so PIN entry goes through real
   * button presses - and a press is ten firmware loop iterations plus the idle
   * rounds the firmware needs to see a release, three times per unlock. That
   * put the suite past the old 180s deadline while every test in it passed,
   * which reads as a hang rather than as "this build is slower".
   */
  const budgetMs = Number(process.env.OKRN_E2E_TIMEOUT_MS || 420000);
  /*
   * STREAMED, NOT DOTTED. The old loop printed one dot every two seconds and
   * the suite's lines only at the end, so a run that sat on one test for two
   * minutes looked identical to one making progress - and when it was killed,
   * nothing had been printed at all. Now each [Moniker] line appears as the
   * phone logs it, and a quiet stretch longer than STALL_MS is an error that
   * names the last thing the suite said.
   *
   * 90 s: the slowest single step measured is a backup capture on a production
   * build, well under a minute; a real hang is infinite.
   */
  const stallMs = Number(process.env.OKRN_E2E_STALL_MS || 90000);
  const deadline = Date.now() + budgetMs;
  let log = '';
  /*
   * NEW LINES ARE FOUND BY IDENTITY, NOT BY COUNT. logcat is a ring buffer,
   * and this suite prints byteprints fast enough to churn it: old lines fall
   * off the front at the rate new ones arrive, so "more lines than last time"
   * stopped being true while the suite was still running - and the first
   * version of this loop called that a stall, ninety seconds into a passing
   * run. The last line printed is remembered verbatim (timestamp included)
   * and everything after its position is new; if it has scrolled out
   * entirely, everything in the buffer is newer than it.
   */
  let lastRaw = null;
  let lastNewAt = Date.now();
  let lastLine = '(the suite has not printed anything)';
  console.log('');
  for (;;) {
    log = adb(['logcat', '-d']);
    const raw = log.split(/\r?\n/).filter(l => l.includes('[Moniker]'));
    const at = lastRaw === null ? -1 : raw.lastIndexOf(lastRaw);
    const fresh = raw.slice(at + 1);
    if (fresh.length) {
      for (const line of fresh) console.log(`  ${stripMoniker(line)}`);
      lastRaw = raw[raw.length - 1];
      lastNewAt = Date.now();
      lastLine = stripMoniker(lastRaw);
    }
    if (/TEST COMPLETE/.test(log)) break;

    /*
     * A wrong --only name is thrown IN THE APP (only.js says why), on the
     * ReactNativeJS tag rather than as a [Moniker] line - so the loop above
     * never saw it, and a typo ("bridge" for "bridgeFlow") cost a ninety
     * second stall that ended in "the suite has not printed anything".
     * Measured 2026-09-11. Surface it the moment it appears, with the list.
     */
    const unknown = /names suites that do not exist: ([^\n\]]*)/.exec(log);
    if (unknown) {
      throw new Error(`e2e: ${unknown[0].replace(/s+/g, ' ')}`);
    }

    /* The app leaving the screen is the one stall that needs no waiting for. */
    const front = foregroundApp();
    if (front !== PACKAGE && acceptUsbPrompt()) {
      /*
       * Not a failure: a suite that reboots the key (hardKeyProvision) makes
       * it re-enumerate, and Android may ask again whether this app can use
       * it. The suite waits for the grant; this is the finger it waits for.
       */
      await sleep(1000);
      continue;
    }
    if (front !== PACKAGE) {
      throw new Error(
        `${PACKAGE} left the screen mid-run` + (front ? ` ("${front}" is in front)` : '') +
        `. Last from the suite: ${lastLine}`,
      );
    }
    if (Date.now() - lastNewAt > stallMs) {
      throw new Error(
        `stuck after: ${lastLine}\n  no new line from the suite for ${Math.round(stallMs / 1000)}s. ` +
        'Run node tools/doctor.js --shot and read the phone.',
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`the suite did not finish within ${Math.round(budgetMs / 1000)}s. Last: ${lastLine}`);
    }
    await sleep(2000);
  }
  console.log('');

  const verdict = /Passed:\s*(\d+)\s*Failed:\s*(\d+)(?:\s*Skipped:\s*(\d+))?(?:\s*Bailed:\s*(\S+))?/.exec(log);
  if (!verdict) {
    throw new Error('the suite finished but printed no verdict');
  }
  const passed = Number(verdict[1]);
  const failed = Number(verdict[2]);
  /*
   * Skipped is OPTIONAL in the verdict line and absent when nothing skipped, so
   * an ordinary run reads exactly as it always did. It is reported separately
   * because a skip is neither a pass nor a failure: a firmware that does not
   * have a feature is not refusing it, and counting those as passes is how a
   * matrix sweep comes to look uniform when the devices are not.
   */
  const skipped = verdict[3] === undefined ? 0 : Number(verdict[3]);
  /*
   * The suite --bail stopped after, if it did. Named rather than flagged,
   * because the useful question after a bailed run is which suite to hand to
   * --only next, and the answer is right there.
   *
   * Reported even though a bailed run always has failures: the counts on their
   * own would make a truncated run look like a small one.
   */
  const bailedAfter = verdict[4];

  console.log(
    `\n${failed === 0 ? 'PASS' : 'FAIL'}  passed=${passed} failed=${failed}` +
    (skipped ? ` skipped=${skipped}` : '') +
    (bailedAfter ? ` (bailed after ${bailedAfter}; later suites did not run)` : ''),
  );
  /*
   * The verdict, written where tools/matrix.js can read it.
   *
   * The sweep runs this script with its output inherited so the progress dots
   * appear live, which means it sees an exit code and nothing else. A one-line
   * file is the smallest way to give it the counts as well, and it matters
   * because a version that SKIPS eleven tests and one that passes them are both
   * exit code 0 - the table has to be able to tell them apart.
   */
  try {
    fs.writeFileSync(
      path.join(__dirname, '.last-e2e.json'),
      JSON.stringify({ passed, failed, skipped, at: new Date().toISOString() }) + '\n',
    );
  } catch (_) {
    /* Reporting is not worth failing a run over. */
  }

  /*
   * LEAVE THE KEY USABLE. A run must not hand the phone back broken.
   *
   * 14b-pqcSlots ends in CONFIG MODE and cannot do otherwise: generating a
   * post-quantum key requires it, and the emulator has no in-process reset -
   * the firmware's CPU_RESTART writes AIRCR and OkEmu.restart() says so.
   * Config mode answers eleven message types and silently drops the rest
   * (okcore.cpp:347), so a person picking up the phone afterwards finds a
   * keypad that appears not to work and a Bluetooth security key that never
   * answers, with nothing on screen explaining either.
   *
   * That cost the user twice in one evening before anyone connected the two.
   * A force-stop here is the power cycle that ends config mode, and it costs
   * a second at the end of a four-minute run.
   *
   * --no-restart still means what it says: the caller wants the app left
   * exactly as the run left it, usually to read state from a failure.
   */
  if (!keepRunning) {
    try {
      adb(['shell', 'am', 'force-stop', PACKAGE]);
      adb(['shell', 'am', 'start', '-n', ACTIVITY]);
      trace('restarted the app so the key is not left in config mode');
    } catch (_) {
      /* Tidying up is not worth changing a verdict over. */
    }
  }

  process.exit(failed === 0 ? 0 : 1);
}

const restoreOnly = applyOnly(readOnlyArg());
const restoreOptions = applyOptions(!process.argv.includes('--no-bail'));

/* Both generated files go back together, wherever the run ends. */
const restore = () => {
  restoreOnly();
  restoreOptions();
};

/*
 * process.exit() skips a pending finally, and this script exits that way on
 * both paths - so the restore is hooked to 'exit' as well. Running it twice is
 * harmless: it writes the same bytes back either way.
 *
 * A filter left behind would make the next FULL run quietly skip most of the
 * suite and still report a pass, which is the one outcome worth engineering
 * against here.
 */
process.on('exit', restore);

/*
 * A SIGNAL DOES NOT FIRE 'exit'.
 *
 * Measured, by interrupting a run: node's default SIGINT handling terminates
 * the process without running the 'exit' listeners, so a Ctrl-C - or a harness
 * killing the runner - left `only.js` naming one suite. The next thing that
 * rendered the app got a deliberate "names suites that do not exist" error,
 * which is the friendly end of that failure; the unfriendly end is a filter
 * that still matches, making a full run skip most of the suite and report a
 * pass.
 *
 * Re-raising with the default handler after restoring keeps the exit status
 * honest - a run that was interrupted should not look like one that finished.
 */
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restore();
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}

main()
  .catch(err => {
    console.error(`\ne2e: ${err.message}`);
    process.exit(2);
  })
  .finally(restore);
