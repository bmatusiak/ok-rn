'use strict';
/*
 * The contract every backend speaks, checked against the one that needs no
 * device: a hex SHA-256 digest per line in, a hex PKCS#1 v1.5 signature per
 * line out, and `ERR <reason>` - never silence - for a line it cannot sign.
 * OnlyKeyBackend.java reads exactly one answer per digest, so an unanswered
 * line would hang apksigner rather than fail it.
 *
 * A throwaway key, generated here, so the test never touches .local.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');

const BACKEND = path.join(__dirname, '..', 'backend-software.js');

function withBackend(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-signer-test-'));
  const {privateKey, publicKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
  const keyPath = path.join(dir, 'key.pem');
  fs.writeFileSync(keyPath, privateKey.export({type: 'pkcs8', format: 'pem'}));
  const child = spawn(process.execPath, [BACKEND], {
    env: {...process.env, OKSIGN_SOFTWARE_KEY: keyPath},
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  const next = () => new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (lines.length) return resolve(lines.shift());
      if (Date.now() - t0 > 5000) return reject(new Error('no answer within 5s'));
      setTimeout(poll, 10);
    })();
  });
  return fn({child, next, publicKey}).finally(() => {
    child.kill();
    fs.rmSync(dir, {recursive: true, force: true});
  });
}

test('a digest comes back as a signature that verifies as SHA256withRSA', () =>
  withBackend(async ({child, next, publicKey}) => {
    const message = Buffer.from('an apk signing block stands in here');
    const digest = crypto.createHash('sha256').update(message).digest();
    child.stdin.write(`${digest.toString('hex')}\n`);
    const answer = await next();
    assert.match(answer, /^[0-9a-f]{512}$/, 'a 2048-bit signature, as hex');
    assert.ok(
      crypto.verify('sha256', message, publicKey, Buffer.from(answer, 'hex')),
      'the signature over the digest verifies against the message',
    );
  }));

test('a line that is not a 32-byte digest is answered ERR, not ignored', () =>
  withBackend(async ({child, next}) => {
    child.stdin.write('abcd\n');
    assert.match(await next(), /^ERR /);
  }));
