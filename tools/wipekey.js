#!/usr/bin/env node
/**
 * Wipe the SOFT KEY, and nothing else.
 *
 * `adb shell pm clear` does this, and does far more: it also revokes every
 * runtime permission, so the next launch stops to ask for Bluetooth and USB
 * again. That turns an unattended test run into one that waits for a human to
 * tap Allow, which is exactly the flow a wipe is supposed to enable.
 *
 * The soft key is nothing but files - `files/okemu/<version>/{flash.bin,
 * eeprom.bin}` - so removing those is the whole of a factory reset, and
 * `run-as` reaches them on a debug build without touching anything the app was
 * granted. On a release build run-as is refused; there is no wipe short of pm
 * clear there, and this says so rather than appearing to work.
 *
 * The app is force-stopped first. The firmware thread only exits through the
 * AIRCR trap and holds the files open, and `initialized` is recomputed from
 * flash only in setup() - so the wipe has to happen while nothing is running,
 * and takes effect on the next launch.
 *
 *   node tools/wipekey.js            wipe every staged version
 *   node tools/wipekey.js --list     show what is there, change nothing
 */
'use strict';

/* The shared resolver: honours $ADB and $ANDROID_SERIAL - see tools/adb.js. */
const {adb} = require('./adb');

const PKG = 'com.okrn';
const STORAGE = 'files/okemu';

const run = (args) => {
  try {
    return adb(args);
  } catch (e) {
    /* A refused run-as exits non-zero; its message is what we want to read. */
    return String((e && (e.stdout || e.message)) || '');
  }
};
/*
 * No `sh -c`. adb shell joins its arguments with spaces and lets the DEVICE's
 * shell re-split them, so a quoted script arrives as its first word plus loose
 * arguments - `ls -1 files/okemu` ran as plain `ls` and listed the whole data
 * directory. run-as takes the command directly, which needs no quoting.
 */
const runAs = (...argv) => run(['shell', 'run-as', PKG, ...argv]);

const listing = runAs('ls', STORAGE).trim();

if (/not debuggable|unknown package|run-as:/i.test(listing)) {
  console.error(
    'wipekey: run-as was refused. This is a release build, so the app\'s files ' +
      'are not reachable - the only wipe there is `adb shell pm clear com.okrn`, ' +
      'which also revokes permissions.',
  );
  process.exit(1);
}

/* `ls` on a missing directory says so on stderr and prints nothing useful. */
const missing = /No such file|not found/i.test(listing);
const versions = missing || !listing
  ? []
  : listing.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

if (process.argv.includes('--list')) {
  console.log(versions.length ? `staged keys: ${versions.join(', ')}` : 'no staged keys');
  process.exit(0);
}

if (!versions.length) {
  console.log('wipekey: nothing to wipe; the key is already blank');
  process.exit(0);
}

run(['shell', 'am', 'force-stop', PKG]);
runAs('rm', '-rf', STORAGE);

const left = runAs('ls', STORAGE).trim();
if (left && !/No such file|not found/i.test(left)) {
  console.error(`wipekey: FAILED, these remain: ${left}`);
  process.exit(1);
}
console.log(`wipekey: wiped ${versions.join(', ')} - permissions untouched`);
