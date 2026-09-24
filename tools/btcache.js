#!/usr/bin/env node
/**
 * What WINDOWS thinks this phone is - which is not what the app thinks.
 *
 * ## Why this exists
 *
 * Windows reads a Classic device's SDP record ONCE, when it bonds, and does
 * not read it again. So if the phone's HID record was missing at that moment -
 * and in development it usually was, see NativeBtKeyboardModule.invalidate() -
 * Windows caches "a phone with no keyboard" and keeps that forever. Nothing
 * the app does afterwards can add HID to an existing bond.
 *
 * That produces a bug that looks like it fixes and breaks itself. A re-pair
 * repopulates the cache and the keyboard starts working, so the last code
 * change gets the credit; the next bond formed while the record is missing
 * poisons it again, so the change after that gets the blame. Two days went
 * into that loop.
 *
 * The app cannot see any of this. Its Bluetooth screen reports whether IT
 * registered a keyboard, which stays true while Windows ignores it. So the
 * only honest verdict comes from the other machine, and this is how to ask.
 *
 * READ-ONLY. It changes nothing; tools/btpurge.ps1 is the one that clears.
 *
 *   node tools/btcache.js                 every bonded device
 *   node tools/btcache.js 24293486EAAF    just that address
 */
'use strict';

const {execFileSync} = require('child_process');

/*
 * The services worth naming. Windows exposes each cached service as its own
 * PnP node keyed by UUID, so presence in this list IS the cache entry - there
 * is nothing else to consult and no API that reports "stale".
 */
/*
 * A `uuid` here is the FULL 128-bit service UUID as Windows spells it in the
 * node path. SIG-assigned services live in the Bluetooth base range and are
 * usually written as four hex digits, so `short` keeps the output readable; a
 * vendor service has no short form and is matched whole.
 */
const BASE = u => `0000${u}-0000-1000-8000-00805F9B34FB`;

const WANTED = [
  {uuid: BASE('1124'), short: '0x1124', bus: 'BR', what: 'HID keyboard', loadBearing: true},
  {uuid: BASE('FFFD'), short: '0xFFFD', bus: 'LE', what: 'FIDO authenticator'},
  /*
   * The OnlyKey VENDOR interface - slots, keys, config, backup. It is NOT
   * advertised, so a host only ever finds it by enumerating the GATT table on
   * connect; that it appears here at all is the proof one did, and kept it.
   */
  {uuid: '0c0ffab0-9f1e-4b1d-9c6a-0f0e1d2c3b4a', short: '0c0ffab0', bus: 'LE', what: 'OnlyKey vendor'},
];

const ps = script =>
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });

/*
 * Every Bluetooth PnP node, present or not. `-Class Bluetooth` alone misses
 * the BTHLEDEVICE nodes, which is where the FIDO service lives, so this asks
 * by instance-id prefix instead and takes everything.
 */
const NODES = `
Get-PnpDevice -ErrorAction SilentlyContinue |
  Where-Object { $_.InstanceId -match '^(BTHENUM|BTHLE|BTHLEDEVICE)\\\\' } |
  ForEach-Object { "$($_.Status)|$($_.InstanceId)|$($_.FriendlyName)" }
`;

let lines;
try {
  lines = ps(NODES).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
} catch (e) {
  console.error('btcache: could not query Windows - ' + String(e.message || e));
  process.exit(1);
}

/*
 * A node's address is the only thing tying it to a device, and it appears in
 * the instance id as twelve hex digits - in DEV_<mac> or as a trailing _<mac>.
 *
 * BUT the Bluetooth BASE UUID ends in 00805F9B34FB, which is itself twelve hex
 * digits and comes FIRST in a service node's id:
 *
 *   BTHLEDEVICE\{0000FFFD-0000-1000-8000-00805F9B34FB}_24293486EAAF\A&...
 *                                       ^^^^^^^^^^^^   ^^^^^^^^^^^^
 *                                       the base UUID  the actual device
 *
 * Taking the first match filed every service node under a device called
 * 00805F9B34FB and reported the real phone as having nothing cached. So the
 * base is excluded by name and the LAST remaining run is the address.
 */
const BASE_UUID_TAIL = '00805F9B34FB';
const byAddress = new Map();
for (const line of lines) {
  const [status, instance, name] = line.split('|');
  const runs = (instance || '')
    .toUpperCase()
    .match(/[0-9A-F]{12}/g)
    ?.filter(run => run !== BASE_UUID_TAIL);
  if (!runs || !runs.length) continue;
  const mac = runs[runs.length - 1];
  if (!byAddress.has(mac)) byAddress.set(mac, []);
  byAddress.get(mac).push({status, instance, name: name || ''});
}

const only = (process.argv[2] || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
const addresses = [...byAddress.keys()].filter(mac => !only || mac === only);

if (!addresses.length) {
  console.log(
    only
      ? `btcache: nothing cached for ${only} - the slate is clean`
      : 'btcache: no bonded Bluetooth devices are cached',
  );
  process.exit(0);
}

let poisoned = false;

for (const mac of addresses) {
  const nodes = byAddress.get(mac);
  /* The device's own node carries its name; the service nodes are named after
   * the service, so taking the shortest DEV_ name avoids "Pixel 6a Avrcp". */
  const self = nodes
    .filter(n => /DEV_/i.test(n.instance))
    .sort((a, b) => a.name.length - b.name.length)[0];

  console.log(`\n${self ? self.name : '(unnamed)'}  ${mac}  — ${nodes.length} cached nodes`);

  for (const want of WANTED) {
    const hit = nodes.find(n =>
      new RegExp("\{"+want.uuid+"\}", "i").test(n.instance),
    );
    const mark = hit ? 'cached' : 'MISSING';
    console.log(`  ${want.bus}  ${want.short.padEnd(9)}${want.what.padEnd(20)} ${mark}`);
    if (!hit && want.loadBearing) poisoned = true;
  }
}

if (poisoned) {
  console.log(
    '\nWindows bonded this device WITHOUT a keyboard. No app-side change can\n' +
      'add HID to an existing bond - the record is only read once, at bond time.\n' +
      'Purge and pair again:  powershell -File tools/btpurge.ps1 -Address <mac>',
  );
}
