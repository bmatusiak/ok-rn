#!/usr/bin/env node
/**
 * The state of the bench, on one screen.
 *
 *     node tools/doctor.js              the report
 *     node tools/doctor.js --shot [png] the report plus a screenshot of the phone
 *     node tools/doctor.js --log [re]   the report plus the last 40 matching
 *                                       logcat lines
 *
 * ## Why this exists
 *
 * Every long silence in this project's history had the same shape: something
 * waited on a state it could not see - a Metro that was being starved by a
 * second Metro, an app that had been force-stopped, a suite filter left behind
 * - and the person watching was reading a terminal instead of the phone.
 * Finding any one of those took a chain of ad-hoc adb and process commands,
 * each of which printed pages (one `dumpsys usb` is two thousand lines) into a
 * conversation that is paid for by the token.
 *
 * So: READ-ONLY, under ten seconds, and every row is one line. Run it at the
 * start of a session, before a suite, and the moment anything "sits".
 *
 * ## What each row is measured from
 *
 *   device      `adb devices`, filtered to ANDROID_SERIAL when set
 *   foreground  `dumpsys window` mCurrentFocus - which app is actually on screen
 *   metro       listeners on 8081 plus every `react-native start` process.
 *               Two is the failure mode that cost an afternoon: the second one
 *               takes the port, the first keeps the phone, and every bundle
 *               takes a minute.
 *   strays      node processes in this checkout that are NOT Metro and NOT
 *               Metro's own transform workers. Metro's workers are jest-worker
 *               children of the `react-native start` pid and are normal; a
 *               jest-worker whose parent is a dead test run is a stray, and ten
 *               of them starve Metro.
 *   onlykey     `dumpsys usb` host manager - is a key physically on the bus
 *   only.js     the suite filter, which must be [] between runs
 *   last e2e    tools/.last-e2e.json, written by tools/e2e.js
 */
'use strict';

const {execFileSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {adb, serial, foregroundWindow} = require('./adb');

const PACKAGE = 'com.okrn';
const ROOT = path.join(__dirname, '..');
const METRO_PORT = 8081;

function row(label, value) {
  console.log(`${label.padEnd(12)}${value}`);
}

function safe(fn, fallback = 'unavailable') {
  try {
    return fn();
  } catch (e) {
    return `${fallback} (${String(e.message || e).split('\n')[0]})`;
  }
}

/* ---- device ------------------------------------------------------------ */

function deviceRow() {
  const out = adb(['devices']);
  const lines = out.split('\n').slice(1).map(l => l.trim()).filter(Boolean);
  const devices = lines.map(l => l.split(/\s+/)).map(([id, state]) => ({id, state}));
  if (serial) {
    const mine = devices.find(d => d.id === serial);
    return mine ? `${mine.id} (${mine.state})` : `${serial} NOT LISTED - ${devices.length} other(s)`;
  }
  if (!devices.length) return 'none attached';
  return devices.map(d => `${d.id} (${d.state})`).join(', ')
    + (devices.length > 1 ? '   ! several - set ANDROID_SERIAL' : '');
}

function foregroundRow() {
  const win = foregroundWindow();
  const pid = adb(['shell', 'pidof', PACKAGE]).trim();
  const front = win ? win : 'nothing focused';
  const ours = win && win.startsWith(PACKAGE + '/');
  return `${front}${pid ? `   pid ${pid}` : '   NOT RUNNING'}`
    + (ours ? '' : `   ! ${PACKAGE} is not on screen`);
}

/* ---- processes ---------------------------------------------------------- */

/**
 * Every process on this machine with pid, parent and command line.
 *
 * PowerShell on Windows, `ps` elsewhere. Both are one call; anything per
 * process would be the slow part of this script.
 */
function processes() {
  if (process.platform === 'win32') {
    const script =
      'Get-CimInstance Win32_Process | ' +
      'Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ' +
      'ConvertTo-Json -Compress';
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const list = JSON.parse(out);
    return (Array.isArray(list) ? list : [list]).map(p => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      started: p.CreationDate ? String(p.CreationDate) : '',
      cmd: p.CommandLine || '',
    }));
  }
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,lstart=,args='], {encoding: 'utf8'});
  return out.split('\n').filter(Boolean).map(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/.exec(line);
    return m ? {pid: +m[1], ppid: +m[2], started: m[3].trim(), cmd: m[4]} : null;
  }).filter(Boolean);
}

function listeningPids(port) {
  if (process.platform === 'win32') {
    const script =
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
      'Select-Object -ExpandProperty OwningProcess';
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], {encoding: 'utf8'});
    return [...new Set(out.split(/\s+/).filter(Boolean).map(Number))];
  }
  try {
    const out = execFileSync('lsof', ['-t', '-iTCP:' + port, '-sTCP:LISTEN'], {encoding: 'utf8'});
    return [...new Set(out.split(/\s+/).filter(Boolean).map(Number))];
  } catch (_) {
    return [];
  }
}

function whenStarted(p) {
  /* CIM dates look like /Date(1757550386000)/ or 20260910202626.xxx; ps gives text. */
  const epoch = /Date\((\d+)\)/.exec(p.started);
  if (epoch) return new Date(+epoch[1]).toTimeString().slice(0, 5);
  const cim = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(p.started);
  if (cim) return `${cim[4]}:${cim[5]}`;
  return p.started.slice(-14, -6).trim() || '?';
}

function metroAndStrays() {
  const all = processes();
  const inRepo = all.filter(p => p.cmd.toLowerCase().includes(ROOT.toLowerCase()));

  const metros = inRepo.filter(p => /react-native["']?\s+start|cli\.js["']?\s+start/.test(p.cmd)
    && !/npx-cli/.test(p.cmd));
  const metroPids = new Set(metros.map(p => p.pid));
  const listeners = listeningPids(METRO_PORT);

  const metroRow = metros.length === 0
    ? `NONE running   ! start it: npx react-native start --host 0.0.0.0`
    : metros.map(p => `pid ${p.pid} started ${whenStarted(p)}`).join(', ')
      + `   port ${METRO_PORT}: ${listeners.length ? listeners.join(',') : 'nobody listening !'}`
      + (metros.length > 1 ? '   ! MORE THAN ONE - the extra one starves the other' : '');

  /* Workers whose parent is a live Metro are Metro's own transformers. */
  const jestWorkers = inRepo.filter(p => /jest-worker/.test(p.cmd));
  const strayWorkers = jestWorkers.filter(p => !metroPids.has(p.ppid));
  const other = inRepo.filter(p =>
    !metroPids.has(p.pid) && !/jest-worker|npx-cli|doctor\.js/.test(p.cmd));

  const strayRow = `${strayWorkers.length} jest workers outside Metro`
    + (strayWorkers.length ? ` (pids ${strayWorkers.map(p => p.pid).join(',')}) !` : '')
    + `; ${other.length} other node procs in ok-rn`
    + (other.length ? ': ' + other.map(p => `${p.pid} ${p.cmd.replace(/^.*[\\/]/, '').slice(0, 40)}`).join(' | ') : '');

  return {metroRow, strayRow};
}

/* ---- the key ------------------------------------------------------------ */

function onlykeyRow() {
  const out = adb(['shell', 'dumpsys', 'usb']);
  const host = out.indexOf('host_manager');
  const section = host >= 0 ? out.slice(host) : out;
  const attached = /product_name=ONLYKEY|vendor_id=7504|1d50/i.test(section);
  return attached ? 'attached (host mode)' : 'not on the bus';
}

/* ---- the suite ---------------------------------------------------------- */

function onlyRow() {
  const file = path.join(ROOT, '__e2e_tests__', 'only.js');
  const m = /module\.exports = (\[[^\]]*\]);/.exec(fs.readFileSync(file, 'utf8'));
  const value = m ? m[1] : '?';
  return value === '[]' ? '[]' : `${value}   ! a filter is left behind - a full run would skip suites`;
}

function lastRow() {
  const file = path.join(__dirname, '.last-e2e.json');
  if (!fs.existsSync(file)) return 'no run recorded';
  const v = JSON.parse(fs.readFileSync(file, 'utf8'));
  return `${v.failed === 0 ? 'PASS' : 'FAIL'} passed=${v.passed} failed=${v.failed}`
    + (v.skipped ? ` skipped=${v.skipped}` : '')
    + ` at ${new Date(v.at).toTimeString().slice(0, 5)}`;
}

/* ---- extras -------------------------------------------------------------- */

function screenshot(target) {
  const file = target || path.join(os.tmpdir(), 'ok-rn-phone.png');
  const png = adb(['exec-out', 'screencap', '-p'], {encoding: 'buffer'});
  fs.writeFileSync(file, png);
  return `${file} (${Math.round(png.length / 1024)} KB)`;
}

const DEFAULT_LOG = 'Moniker|softkey|hardkey|okemu|ReactNativeJS|FATAL|AndroidRuntime';

function logTail(filter, limit = 40) {
  const re = new RegExp(filter || DEFAULT_LOG);
  const out = adb(['logcat', '-d', '-t', '1500']);
  const lines = out.split('\n').filter(l => re.test(l));
  const tail = lines.slice(-limit);
  return (lines.length > limit ? `… ${lines.length - limit} earlier lines omitted\n` : '')
    + tail.map(l => l.replace(/^\d{2}-\d{2} /, '')).join('\n');
}

/* ---- main ---------------------------------------------------------------- */

function argAfter(flag) {
  const at = process.argv.indexOf(flag);
  if (at === -1) return undefined;
  const v = process.argv[at + 1];
  return v && !v.startsWith('--') ? v : null;
}

function main() {
  row('device', safe(deviceRow));
  row('foreground', safe(foregroundRow));
  const {metroRow, strayRow} = safe(metroAndStrays, {metroRow: 'unavailable', strayRow: 'unavailable'});
  row('metro', metroRow);
  row('strays', strayRow);
  row('onlykey', safe(onlykeyRow));
  row('only.js', safe(onlyRow));
  row('last e2e', safe(lastRow));

  const shot = argAfter('--shot');
  if (shot !== undefined) row('screenshot', safe(() => screenshot(shot)));

  const log = argAfter('--log');
  if (log !== undefined) {
    console.log(`\n--- logcat (${log || DEFAULT_LOG}) ---`);
    console.log(safe(() => logTail(log)));
  }
}

main();
