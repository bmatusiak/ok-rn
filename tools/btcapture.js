#!/usr/bin/env node
'use strict';

/**
 * CAPTURE A BROKEN BLUETOOTH LINK BEFORE ANYTHING CHANGES IT (Brad, 2026-10-21:
 * "as soon as it happens we need to capture the state and how it got into a
 * broken state, so we can find a real fix instead of hunting a ghost").
 *
 * Two failures that day were cured - one by turning the PC's Bluetooth off and
 * on, one by restarting the app - and neither came back on demand, so neither
 * could be explained. Every cure wipes the evidence: a toggle rebuilds Windows'
 * service list, an app restart clears its reply state, and logcat's ring buffer
 * rolls over in minutes. So this runs FIRST, and only reads:
 *
 *   computer   btcache.js (Windows' cached view of the phone), every Windows
 *              service node for it with its status and whether it is connected,
 *              and the Bluetooth event log; on Linux bluetoothctl and btmgmt
 *   CLI        one traced `edge status` (ONLYKEY_JS_DEBUG=1) - the failure itself
 *   phone      (adb) uptime, Bluetooth on/off, where our services sit in the
 *              GATT table, the handle the app remembers, and the app's
 *              Bluetooth lines - [bt] [ble] [vendor] FidoGatt and the GATT
 *              server's own. NEVER [fw]: the firmware's DEBUG output carries
 *              key bytes (memory: app-log-carries-key-bytes).
 *
 * READ-ONLY: no toggle, no restart, no pairing. Each part is written to its own
 * file the moment it is read, so a part that hangs costs only itself.
 *
 *   node tools/btcapture.js --phone "Pixel 6a" [--mac 24:29:34:86:EA:AF]
 *   node tools/btcapture.js --phone-only        where adb reaches the phone
 *                                               (the ZBOX holds the Pixel's)
 *   ANDROID_SERIAL picks the phone when adb sees more than one.
 */

const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');
const {ADB, serial} = require('./adb');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const phoneOnly = process.argv.includes('--phone-only');
const phone = arg('--phone');
const mac = (arg('--mac') || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
if (!phoneOnly && !phone) {
  console.error('btcapture: --phone "<its Bluetooth name or address>" (or --phone-only where adb reaches the phone)');
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.resolve(__dirname, '..', '..', 'logs', 'btcapture', `${stamp}${phoneOnly ? '-phone' : ''}`);
fs.mkdirSync(out, {recursive: true});
const summary = [];

/* run one read, write it to its file, never throw: a part that fails says so in its file */
function take(file, cmd, args, {timeout = 60000, env, filter} = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, {encoding: 'utf8', timeout, env: env ? {...process.env, ...env} : process.env, maxBuffer: 32 * 1024 * 1024});
  let text = `${r.stdout || ''}${r.stderr || ''}`;
  if (filter) text = text.split(/\r?\n/).filter(filter).join('\n');
  const head = `# ${cmd} ${args.join(' ')}\n# ${new Date().toISOString()} exit ${r.status}${r.error ? ` (${r.error.message})` : ''} in ${Date.now() - t0} ms\n`;
  fs.writeFileSync(path.join(out, file), head + text + '\n');
  console.log(`  ${file.padEnd(22)} ${r.error ? r.error.message : `exit ${r.status}`}`);
  return text;
}
const ps = (file, script) => take(file, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);

console.log(`btcapture -> ${out}`);

if (!phoneOnly) {
  /* 1. the computer, before the CLI touches the link */
  if (process.platform === 'win32') {
    take('windows-cache.txt', process.execPath, [path.join(__dirname, 'btcache.js'), mac]);
    ps('windows-nodes.txt',
      "Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match '" + (mac || '.') + "' } | "
      + "ForEach-Object { $c = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName '{83DA6326-97A6-4088-9453-A1923F573B29} 15' -ErrorAction SilentlyContinue).Data; "
      + "'{0,-8} connected={1,-5} {2} | {3}' -f $_.Status, $c, $_.FriendlyName, $_.InstanceId }");
    ps('windows-events.txt',
      "Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=(Get-Date).AddHours(-6)} -ErrorAction SilentlyContinue | "
      + "Where-Object { $_.ProviderName -match 'BTH|Bluetooth' } | Select-Object -First 80 | "
      + "ForEach-Object { '{0:HH:mm:ss} {1} {2}: {3}' -f $_.TimeCreated, $_.ProviderName, $_.Id, ($_.Message -replace '\\s+',' ') }");
    ps('windows-processes.txt',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { '{0} {1:HH:mm} {2}' -f $_.ProcessId, $_.CreationDate, $_.CommandLine }");
  } else {
    take('linux-btmgmt.txt', 'sudo', ['-n', 'btmgmt', 'info']);
    take('linux-bluetoothctl.txt', 'bluetoothctl', ['devices'], {timeout: 15000});
    if (mac) take('linux-device.txt', 'bluetoothctl', ['info', mac.match(/../g).join(':')], {timeout: 15000});
  }

  /* 2. the failure itself, traced */
  const cli = path.resolve(__dirname, '..', '..', 'node-onlykey-lib', 'cli', 'index.js');
  const trace = take('cli-trace.txt', process.execPath, [cli, '--ble', '--address', phone, 'edge', 'status'],
    {timeout: 90000, env: {ONLYKEY_JS_DEBUG: '1'}});
  summary.push(`cli: ${(trace.match(/link up[^\n]*|unreachable[^\n]*|no answer[^\n]*|not paired[^\n]*/i) || ['(see cli-trace.txt)'])[0].trim()}`);
}

/* 3. the phone, if adb reaches it */
const a = (args) => (serial ? ['-s', serial, ...args] : args);
const devices = spawnSync(ADB, ['devices'], {encoding: 'utf8', timeout: 10000});
const reachable = (devices.stdout || '').split('\n').some((l) => /\tdevice$/.test(l) && (!serial || l.startsWith(serial)));
if (!reachable) {
  summary.push(`phone: adb does not reach it here - run on the machine whose adb does: node tools/btcapture.js --phone-only`);
} else {
  take('phone-state.txt', ADB, a(['shell', 'echo uptime $(cut -d" " -f1 /proc/uptime) s; echo bluetooth_on $(settings get global bluetooth_on); date']));
  const gatt = take('phone-gatt.txt', ADB, a(['shell', 'dumpsys', 'bluetooth_manager']), {
    filter: (l) => /Service (0000fffd|0c0ffab0)|aclStateChangeCallback|Bluetooth Status|state:/i.test(l),
  });
  take('phone-known-handle.txt', ADB, a(['shell', 'run-as', 'com.okrn', 'cat', 'shared_prefs/okrn.fido.layout.xml']));
  /* the whole buffer, filtered here: the app's Bluetooth words and the stack's, never the firmware's */
  take('phone-log.txt', ADB, a(['logcat', '-d', '-v', 'time']), {
    filter: (l) => !/\[fw\]/.test(l)
      && /\[bt\]|\[ble\]|\[vendor\]|FidoGatt|BluetoothGattServer|GattServerManager|DeadObject|bt_shim_advertiser/.test(l),
  });
  const at = (uuid) => ((gatt.match(new RegExp(`\\[(\\d+)\\] Service ${uuid}`, 'i')) || [])[1] || '?');
  summary.push(`phone: FIDO service at ${at('0000fffd')}, OnlyKey service at ${at('0c0ffab0')}`);
}

fs.writeFileSync(path.join(out, 'summary.txt'), `${summary.join('\n')}\n`);
console.log(summary.map((s) => `  ${s}`).join('\n'));
console.log('Read-only: nothing was toggled, restarted or paired. Now say what was happening just before it broke.');
