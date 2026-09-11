/**
 * One way of reaching adb, shared by every tool in this directory.
 *
 * It was inlined in tools/e2e.js, and the moment a second tool needed the
 * phone (tools/doctor.js) the path resolution and the serial handling would
 * have been copied - and two copies of "where is adb" drift the first time
 * one of them learns something. So: one module, both require it.
 *
 * `ADB` in the environment wins; otherwise the SDK's platform-tools under
 * LOCALAPPDATA, which is where Android Studio puts it on Windows and the one
 * machine this has been measured on. `ANDROID_SERIAL` selects the device the
 * way adb itself does, so a shell with it exported behaves the same as one
 * passing it per call.
 */
'use strict';

const {execFileSync} = require('child_process');
const path = require('path');
const os = require('os');

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
  return execFileSync(ADB, full, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    /*
     * adb prints "daemon not running; starting" and device-state chatter on
     * stderr. Left inherited, that lands in the terminal between a tool's own
     * lines; piped, it is available to a caller that wants it and invisible
     * to one that does not.
     */
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

/**
 * Is OUR app the thing on screen? Package name of the focused window, or null.
 *
 * Parsed by splitting rather than by regex. The line looks like
 *   mCurrentFocus=Window{bdc94f5 u0 com.okrn/com.okrn.MainActivity}
 * and the package is the token before the slash. A regex here was corrupted
 * twice by shell escaping while being written; the split cannot be.
 */
function foregroundApp() {
  const out = adb(['shell', 'dumpsys', 'window']);
  const marker = 'mCurrentFocus=';
  const at = out.indexOf(marker);
  if (at < 0) return null;

  const line = out.slice(at + marker.length).split('\n')[0];
  const slash = line.indexOf('/');
  if (slash < 0) return null;

  const before = line.slice(0, slash).split(' ');
  return before[before.length - 1] || null;
}

/** The focused window as "package/activity", for a report line. */
function foregroundWindow() {
  const out = adb(['shell', 'dumpsys', 'window']);
  const marker = 'mCurrentFocus=';
  const at = out.indexOf(marker);
  if (at < 0) return null;
  const line = out.slice(at + marker.length).split('\n')[0].trim();
  const inner = line.replace(/^Window\{/, '').replace(/\}$/, '');
  const parts = inner.split(' ');
  return parts[parts.length - 1] || null;
}

module.exports = {ADB, serial, adb, foregroundApp, foregroundWindow};
