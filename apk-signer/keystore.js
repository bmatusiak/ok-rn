/*
 * The debug keystore's signing key, as the material an OnlyKey slot takes.
 *
 * Shared by provision.js (the emulated key) and provision-usb.js (a key on
 * USB), so both load the SAME key and the certificate apksigner embeds stays
 * `fac61745...` whichever device signs.
 *
 * keytool cannot write anywhere but a file, so the PKCS#12 and the key PEM are
 * made in the OS temp directory and deleted in a finally - never under the
 * repo.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');

const OK_RN = path.resolve(__dirname, '..');
const KEYSTORE = path.join(OK_RN, 'android', 'app', 'debug.keystore');
const STORE_PASS = 'android';
const ALIAS = 'androiddebugkey';

function tool(name) {
  const home = process.env.JAVA_HOME;
  return home ? path.join(home, 'bin', name) : name;
}

/** @returns {{p: Buffer, q: Buffer, n: Buffer, cert: string}} */
function extractKey() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oksign-'));
  const p12 = path.join(tmp, 'k.p12');
  const keyPem = path.join(tmp, 'k.pem');
  const certPem = path.join(tmp, 'c.pem');
  const pass = crypto.randomBytes(18).toString('base64url');
  try {
    execFileSync(tool('keytool'), [
      '-importkeystore', '-noprompt',
      '-srckeystore', KEYSTORE, '-srcstorepass', STORE_PASS,
      '-srcalias', ALIAS, '-srckeypass', STORE_PASS,
      '-destkeystore', p12, '-deststoretype', 'PKCS12',
      '-deststorepass', pass, '-destkeypass', pass,
    ], {stdio: ['ignore', 'ignore', 'pipe']});
    execFileSync('openssl', ['pkcs12', '-in', p12, '-passin', `pass:${pass}`,
      '-nodes', '-nocerts', '-out', keyPem], {stdio: ['ignore', 'ignore', 'pipe']});
    execFileSync('openssl', ['pkcs12', '-in', p12, '-passin', `pass:${pass}`,
      '-nokeys', '-clcerts', '-out', certPem], {stdio: ['ignore', 'ignore', 'pipe']});
    const jwk = crypto.createPrivateKey(fs.readFileSync(keyPem, 'utf8'))
      .export({format: 'jwk'});
    const key = {
      p: Buffer.from(jwk.p, 'base64url'),
      q: Buffer.from(jwk.q, 'base64url'),
      n: Buffer.from(jwk.n, 'base64url'),
      cert: fs.readFileSync(certPem, 'utf8'),
    };
    if (key.p.length !== 128 || key.q.length !== 128) {
      throw new Error(`expected 128-byte primes for RSA-2048, got ${key.p.length}/${key.q.length}`);
    }
    return key;
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
}

module.exports = {extractKey, KEYSTORE};
