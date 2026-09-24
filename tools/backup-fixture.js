#!/usr/bin/env node
/*
 * backup-fixture.js - cut a captured backup out of an e2e log and save it.
 *
 * A backup only exists as keystrokes the device TYPED. There is no command that
 * reads one back, so the only way to obtain the file is to make a device type it
 * and decode the HID reports - which is what 8b-backup's capture test does, and
 * which needs a provisioned key, a backup passphrase, a button gesture and about
 * ninety seconds.
 *
 * Committing one as a fixture means parseBackup(), verifyBackup() and the
 * restore chunker can be exercised with NO DEVICE, which is the only way those
 * paths are covered on a machine that has none - including CI.
 *
 *   node tools/e2e.js --only backupCapture          (emits it, gated on isNamed)
 *   node tools/backup-fixture.js <log> [out.txt]
 *
 * Without <out.txt> it prints to stdout, so it can be piped or eyeballed first.
 *
 * WHAT THIS FILE CONTAINS, and why committing it is fine: an EMULATED key's
 * slots, encrypted under a backup passphrase that is itself in this repo
 * (helpers/backupPassphrase.js, 'onlykey' six times). It is a test fixture, not
 * a secret, and it must never be produced from a real key - which is why this
 * reads a log rather than talking to a device, and why the header it writes says
 * so in the file itself.
 */
'use strict';

const fs = require('fs');

const BEGIN = '----- FIXTURE BEGIN -----';
const END = '----- FIXTURE END -----';

function cut(text) {
  const lines = text.split(/\r?\n/);
  const from = lines.findIndex((l) => l.includes(BEGIN));
  if (from === -1) {
    throw new Error(
      `no ${BEGIN} in that log. The capture emits it only when the suite was ` +
      'asked for by name - run `node tools/e2e.js --only backupCapture`.');
  }
  const to = lines.findIndex((l, i) => i > from && l.includes(END));
  if (to === -1) throw new Error(`found ${BEGIN} but no ${END}; the run was cut short`);

  /*
   * The runner INDENTS every line it streams and changes nothing else, so
   * trimming is the whole of it.
   *
   * This first took the last whitespace-separated token, on the theory that a
   * backup line is base64 or a '--' marker and never contains a space. The
   * BEGIN marker is `-----BEGIN ONLYKEY BACKUP-----`, which does, so that
   * produced "BACKUP-----" - caught by the header check below rather than
   * written to a fixture, which is why that check is there.
   */
  return lines
    .slice(from + 1, to)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
  /*
   * The runner prefixes every line it streams, so take what follows the last
   * prefix rather than the raw line. A backup line is base64 or a '--' marker
   * and never contains a space, which is what makes this unambiguous.
   */
  return lines
    .slice(from + 1, to)
    .map((l) => l.trim().split(/\s+/).pop())
    .filter(Boolean)
    .join('\n');
}

function main() {
  const [log, out] = process.argv.slice(2);
  if (!log) {
    console.error('usage: node tools/backup-fixture.js <e2e-log> [out.txt]');
    process.exit(2);
  }
  const text = cut(fs.readFileSync(log, 'utf8'));

  const lines = text.split('\n');
  if (!/BEGIN ONLYKEY BACKUP/.test(lines[0])) {
    throw new Error(`that does not start with a backup header: ${JSON.stringify(lines[0])}`);
  }
  if (!/END ONLYKEY BACKUP/.test(lines[lines.length - 1])) {
    throw new Error('that does not end with a backup footer');
  }

  if (out) {
    fs.writeFileSync(out, text + '\n');
    console.log(`${out}: ${lines.length} lines, ${text.length} characters`);
  } else {
    process.stdout.write(text + '\n');
  }
}

if (require.main === module) main();
module.exports = { cut };
