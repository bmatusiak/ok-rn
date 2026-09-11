#!/usr/bin/env node
/**
 * Watch the phone's log for what THIS app says, and stop on your own terms.
 *
 *     node tools/logwatch.js                          30 s of app lines, then exit
 *     node tools/logwatch.js --for 120                a longer look
 *     node tools/logwatch.js --until "TEST COMPLETE"  exit 0 the moment it appears
 *     node tools/logwatch.js --until "OKCONNECT ok" --quiet 20
 *                                                     … or exit 1 after 20 s of silence
 *     node tools/logwatch.js --filter "hardkey|usb"   your own regex instead of the default
 *     node tools/logwatch.js --all                    every line from the app's pid, unfiltered
 *     node tools/logwatch.js --follow                 never exits; one line per EVENT (below).
 *                                                     This is the Monitor-tool shape: arm it
 *                                                     persistent, and each line arrives as a
 *                                                     notification while other work goes on.
 *
 * ## Why it exits by itself
 *
 * A plain `adb logcat` never returns. In a terminal that is what you want; in a
 * tool call it is a command that shows nothing until its timeout kills it,
 * which is exactly the silence this project keeps paying for. So every run
 * here has an end: a marker (`--until`), a budget (`--for`), or a stretch of
 * silence (`--quiet`) - and it says which one ended it.
 *
 * ## Why it is bounded
 *
 * Output is paid for by the line. Only the app's own process is watched (by
 * pid, so a chatty system service cannot flood it), only lines matching the
 * filter are printed, and after --max-lines it stops and says so. A line the
 * harness printed is unquoted the way tools/e2e.js does it.
 *
 * ## Only from now
 *
 * `logcat -T 1` starts at the newest line rather than replaying the buffer,
 * so what appears is what happened after you asked. For what happened before,
 * `node tools/doctor.js --log` shows the last forty.
 */
'use strict';

const {spawn} = require('child_process');
const {ADB, serial, adb} = require('./adb');

const PACKAGE = 'com.okrn';

const DEFAULT_FILTER =
  'Moniker|softkey|hardkey|\\[usb\\]|\\[fw\\]|okemu|ReactNativeJS|FATAL|AndroidRuntime|OkUsb|UsbHost';

function argAfter(flag, fallback) {
  const at = process.argv.indexOf(flag);
  if (at === -1) return fallback;
  const v = process.argv[at + 1];
  return v === undefined || v.startsWith('--') ? fallback : v;
}
const has = flag => process.argv.includes(flag);

/*
 * EVENTS, for `--follow`: the lines a watcher would ACT on, and nothing else.
 *
 * Written for the Monitor tool, where every stdout line becomes a message in
 * the conversation and is paid for as one: a suite starting, the final
 * count, the pipe opening or closing, the device answering, the firmware
 * starting or stopping - and every way things go wrong: a failed, skipped or
 * timed-out test, a harness that threw, a native crash. The failure half is
 * not optional: a filter that only matches good news is silent through a
 * crash, and silence looks exactly like "still running".
 *
 * NOT every passing test. The first version matched ✓ as well, and a full run
 * arrived as eighty notifications - the runner already prints those; the
 * watcher's job is what the runner cannot see. `--filter` widens it when a
 * single suite is being watched closely.
 */
const EVENTS_FILTER =
  'Moniker\\].*(suite:|✗|○|TEST COMPLETE|threw|timeout|harness\\.run)' +
  '|\\[usb\\] (connected|disconnected|error)' +
  '|OKCONNECT|console (answers|is write-only)' +
  '|firmware (started|stopped|did not start)' +
  '|FATAL|AndroidRuntime|Unhandled JS|RedBox|Exception in native';

const follow = has('--follow');
const untilRe = argAfter('--until', null);
const until = untilRe ? new RegExp(untilRe) : null;
const forSeconds = follow ? Infinity : Number(argAfter('--for', until ? 300 : 30));
const quietSeconds = Number(argAfter('--quiet', 0));
const maxLines = Number(argAfter('--max-lines', follow ? Infinity : 200));
const filter = has('--all')
  ? null
  : new RegExp(argAfter('--filter', follow ? EVENTS_FILTER : DEFAULT_FILTER));

/*
 * pidof exits non-zero when nothing matches, and execFileSync turns that
 * into a throw - which killed a watcher started in the second between a
 * force-stop and the relaunch it was meant to watch. Measured, once.
 */
let pid = null;
try {
  pid = adb(['shell', 'pidof', PACKAGE]).trim().split(/\s+/)[0] || null;
} catch (_) {
  pid = null;
}
if (!pid) {
  console.log(`logwatch: ${PACKAGE} is not running; watching by filter until it starts`);
}

/*
 * How far back to start. `--until` twice missed a marker that had landed in
 * the second between a tap and this process attaching - the app connects
 * faster than node starts - so a bounded look begins a little way into the
 * past, where a marker that JUST happened is still found. Follow mode starts
 * at now: a notification for something that already happened is noise.
 */
const recent = Number(argAfter('--recent', follow ? 1 : 200));
const args = [...(serial ? ['-s', serial] : []), 'logcat', '-v', 'threadtime', '-T', String(recent)];
const child = spawn(ADB, args, {stdio: ['ignore', 'pipe', 'pipe']});

const started = Date.now();
let lastMatchAt = Date.now();
let printed = 0;
let buffered = '';

function finish(code, why) {
  console.log(`logwatch: ${why} (${printed} lines in ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  child.kill();
  process.exit(code);
}

/*
 * threadtime lines: "09-10 21:06:56.728  8882  8963 I ReactNativeJS: message".
 * Split by whitespace rather than regex - the same corruption-by-escaping
 * lesson tools/adb.js records.
 */
function parse(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 6) return null;
  const [, time, linePid, , level, ...rest] = parts;
  const tagAndMessage = rest.join(' ');
  const colon = tagAndMessage.indexOf(': ');
  const tag = colon >= 0 ? tagAndMessage.slice(0, colon) : tagAndMessage;
  const message = colon >= 0 ? tagAndMessage.slice(colon + 2) : '';
  return {time, pid: linePid, level, tag, message};
}

function unquote(message) {
  /* console.log from RN wraps extra arguments: '[Moniker]', 'text' */
  return message.replace(/^'?\[Moniker\]',?\s*/, '[Moniker] ').replace(/^'|',?$/g, '');
}

child.stdout.on('data', chunk => {
  buffered += chunk.toString('utf8');
  const lines = buffered.split('\n');
  buffered = lines.pop();

  for (const raw of lines) {
    const entry = parse(raw);
    if (!entry) continue;

    /* A crash of our process is always worth seeing, whoever logged it. */
    const fatal = /FATAL|AndroidRuntime/.test(entry.tag) && raw.includes(PACKAGE);
    const ours = pid ? entry.pid === pid : true;
    if (!ours && !fatal) {
      /*
       * The app (re)started while we watched: adopt the new pid from the
       * system's own announcement. Pinned to the pid looked up at start, a
       * watcher outlived by a force-stop went silent for the rest of its run
       * - measured, on the first try.
       */
      const m = /Start proc (\d+):com\.okrn\//.exec(raw);
      if (m) {
        pid = m[1];
        console.log(`${entry.time} ${PACKAGE} started as pid ${pid}`);
      }
      continue;
    }
    if (filter && !filter.test(raw)) continue;

    const text = `${entry.time} ${entry.tag}: ${unquote(entry.message)}`;
    console.log(text);
    printed += 1;
    lastMatchAt = Date.now();

    if (until && until.test(raw)) finish(0, `saw /${untilRe}/`);
    if (printed >= maxLines) finish(0, `stopped at --max-lines ${maxLines}; narrow --filter or raise it`);
  }
});

child.stderr.on('data', chunk => {
  const text = chunk.toString('utf8').trim();
  if (text) console.log(`logwatch: adb: ${text}`);
});

child.on('exit', code => finish(code === 0 ? 0 : 1, `adb logcat exited (${code})`));

setInterval(() => {
  const elapsed = (Date.now() - started) / 1000;
  if (quietSeconds > 0 && (Date.now() - lastMatchAt) / 1000 > quietSeconds) {
    finish(1, `nothing matched for ${quietSeconds}s - a stall, or the wrong filter`);
  }
  if (elapsed > forSeconds) {
    finish(until ? 1 : 0, until ? `never saw /${untilRe}/ within ${forSeconds}s` : `${forSeconds}s elapsed`);
  }
}, 500);
