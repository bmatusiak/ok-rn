'use strict';
/*
 * The OnlyKey path, on node-onlykey-emulator - no hard key, no phone, no JDK.
 *
 * sign.js is driven exactly as OnlyKeyBackend.java drives it: one hex SHA-256
 * digest per line on stdin, one hex signature per line back. The emulated key
 * holds the debug keystore's key in RSA slot 2 (provision.js), so the answer
 * must verify against .local/signer.crt.pem - the certificate the apk is
 * signed with. That is the claim worth testing: not that bytes come back, but
 * that they are a signature under the certificate apksigner will embed.
 *
 * Skipped, with the reason, when the emulator addon is not built or the key
 * has not been provisioned - a fresh clone still runs `npm test`. Closing
 * stdin is how sign.js knows to stop the emulator and release its lock, so the
 * test always ends that way.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');

const HERE = path.join(__dirname, '..');
const CERT = path.join(HERE, '.local', 'signer.crt.pem');
const FLASH = path.join(HERE, '.local', 'storage', 'flash.bin');
const ADDON = path.join(
  process.env.OKEMU_ROOT ? path.resolve(process.env.OKEMU_ROOT)
    : path.resolve(HERE, '..', '..', 'node-onlykey-emulator', 'emulator'),
  'build', 'Release', 'onlykey_emulator.node',
);

function whyNot() {
  if (!fs.existsSync(ADDON)) return `node-onlykey-emulator is not built (${ADDON})`;
  if (!fs.existsSync(FLASH) || !fs.existsSync(CERT)) return 'no provisioned key - run `node cli.js provision`';
  return null;
}

test('the emulated OnlyKey signs a digest under the certificate apksigner embeds',
  {skip: whyNot() || false, timeout: 180000},
  async () => {
    const child = spawn(process.execPath, [path.join(HERE, 'sign.js')], {
      cwd: HERE, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const firstLine = new Promise((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        const i = buf.indexOf('\n');
        if (i !== -1) resolve(buf.slice(0, i).trim());
      });
      child.on('exit', (code) => reject(new Error(`sign.js exited ${code} before answering:\n${stderr}`)));
    });
    const exited = new Promise((resolve) => child.on('exit', resolve));

    try {
      const message = Buffer.from('an apk signing block stands in here');
      const digest = crypto.createHash('sha256').update(message).digest();
      child.stdin.write(`${digest.toString('hex')}\n`);

      const answer = await firstLine;
      assert.doesNotMatch(answer, /^ERR/, `the key refused: ${answer}`);
      assert.match(answer, /^[0-9a-f]{512}$/, 'a 2048-bit signature, as hex');

      const cert = new crypto.X509Certificate(fs.readFileSync(CERT));
      assert.ok(
        crypto.verify('sha256', message, cert.publicKey, Buffer.from(answer, 'hex')),
        'the signature verifies against signer.crt.pem',
      );
    } finally {
      child.stdin.end();
      await exited;
    }
  });
