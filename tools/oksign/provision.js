#!/usr/bin/env node
/*
 * Put the signing key into an emulated OnlyKey, once.
 *
 * Run this when .local/storage has no key in it; sign.js does that check for
 * you. It takes a minute and then never runs again until the emulator is
 * rebuilt.
 *
 * ## Why this is a separate script from sign.js
 *
 * OKSETPRIV is accepted only in config mode, entering config mode RELOCKS the
 * device, and OKSIGN is not among the messages config mode admits - so loading
 * a key and using it cannot happen in one firmware lifetime. The firmware's
 * shape, not a convenience: see ok-rn/FINDING-loading-a-key-requires-config-mode.md.
 *
 * So provisioning restarts the firmware twice and signing never enters config
 * mode at all. The kit turns each restart into a fresh device-host process
 * transparently, which is the other half of why this cannot live inside a
 * long-running signing helper.
 *
 * ## Where the key goes, and what that means
 *
 * keytool cannot write anywhere but a file, so the PKCS#12 and the key PEM are
 * made in the OS temp directory and deleted in a finally - they are never
 * written under the repo.
 *
 * After that the key lives in .local/storage/flash.bin, which is the emulated
 * device's flash. Be straight about what that is: a private key on disk,
 * gitignored. It is not an improvement on debug.keystore - which is committed,
 * and whose private half is public knowledge because it ships with every React
 * Native scaffold. It is the same exposure in a different place. What this
 * phase buys is the PIPELINE; the secrecy arrives with a hard key.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { open, lock, requireKit, LOCAL } = require('./session');
const okdevice = require('node-onlykey-lib/device');

const OK_RN = path.resolve(__dirname, '..', '..');
const KEYSTORE = path.join(OK_RN, 'android', 'app', 'debug.keystore');
const STORAGE = path.join(LOCAL, 'storage');
const CERT_OUT = path.join(LOCAL, 'signer.crt.pem');
const DIGEST_OUT = path.join(STORAGE, '.fixture-digest');

/* The debug keystore's own, and they are not secrets - they are in the file. */
const STORE_PASS = 'android';
const ALIAS = 'androiddebugkey';

/** RSA slot 2. The library's convention is 1 = decryption, 2 = signature. */
const SLOT = okdevice.keys.ROLE_SLOT.SIGNATURE;

function say(...a) { console.error('[provision]', ...a); }

function tool(name) {
  const home = process.env.JAVA_HOME;
  return home ? path.join(home, 'bin', name) : name;
}

/**
 * p, q and the certificate out of debug.keystore.
 *
 * NOT `openssl rsa -text`: that prints the primes as formatted hex that has to
 * be scraped. Node reads them straight out as a JWK, which is what
 * 19-rsa-keys.test.js does too - and for RSA-2048 they come back as exactly
 * the 128 bytes prepareKey wants.
 */
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
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    execFileSync('openssl', ['pkcs12', '-in', p12, '-passin', `pass:${pass}`,
      '-nodes', '-nocerts', '-out', keyPem], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('openssl', ['pkcs12', '-in', p12, '-passin', `pass:${pass}`,
      '-nokeys', '-clcerts', '-out', certPem], { stdio: ['ignore', 'ignore', 'pipe'] });

    const jwk = crypto.createPrivateKey(fs.readFileSync(keyPem, 'utf8'))
      .export({ format: 'jwk' });

    return {
      p: Buffer.from(jwk.p, 'base64url'),
      q: Buffer.from(jwk.q, 'base64url'),
      n: Buffer.from(jwk.n, 'base64url'),
      cert: fs.readFileSync(certPem, 'utf8'),
    };
  } finally {
    /* The private key never outlives this function. */
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const release = lock();
  const { fixtures, PINS } = requireKit();
  const pin = PINS.primary;

  say('reading debug.keystore');
  const key = extractKey();
  if (key.p.length !== 128 || key.q.length !== 128) {
    throw new Error(`expected 128-byte primes for RSA-2048, got ${key.p.length}/${key.q.length}`);
  }

  say('restoring the initialized fixture');
  const prepared = await fixtures.prepare('initialized', STORAGE, { log: () => {} });

  say('booting');
  const s = await open(STORAGE);
  try {
    /* ---- kit: state ---------------------------------------------------- */
    say('unlocking');
    await s.kit.ensureUnlocked(pin);

    say('entering config mode (this relocks and re-unlocks)');
    await s.kit.enterConfigMode(pin);

    /* ---- library: messages --------------------------------------------- */
    say('stored challenge mode = 1');
    /*
     * One press of ANY button instead of a three-digit challenge derived from
     * the payload. setPreference sends a numeric byte, which sidesteps the
     * trap that the firmware tests `== 1` exactly - the CHARACTER '1' (0x31)
     * primes the confirmation but no press can then satisfy it.
     */
    await s.device.setPreference('storedChallengeMode', 1);

    say(`loading the key into RSA slot ${SLOT}`);
    const material = okdevice.keys.prepareKey(
      { kind: 'rsa', p: key.p, q: key.q },
      { slot: SLOT, signature: true },
    );
    await s.device.loadKey(SLOT, { type: material.type, key: material.key });

    /* ---- kit: state ---------------------------------------------------- */
    say('restarting to leave config mode');
    await s.kit.restart();
    await s.kit.ensureUnlocked(pin);

    /* ---- library: messages --------------------------------------------- */
    say('reading the modulus back');
    /*
     * bytes AND keyType both matter: without `bytes` this resolves on the
     * first 64-byte report and returns a quarter of the modulus, and keyType
     * must be 0 or the firmware takes its ECC branch.
     */
    const pub = await s.device.getPublicKey(SLOT, { bytes: 256, keyType: 0 });
    const got = Buffer.from(pub.bytes || pub);
    if (!got.equals(key.n)) {
      throw new Error(
        'the modulus read back does not match debug.keystore - the key did not land.\n'
        + `  expected ${key.n.toString('hex').slice(0, 32)}...\n`
        + `  got      ${got.toString('hex').slice(0, 32)}...`,
      );
    }
    say('modulus matches debug.keystore');

    /*
     * A byte-level check on flash, because the single most expensive bug in
     * this port was flash writes being silently REJECTED while every ack said
     * success. A blank flash.bin with a passing provision is exactly what that
     * looked like.
     */
    const flash = fs.readFileSync(path.join(STORAGE, 'flash.bin'));
    if (flash.every((b) => b === 0xFF || b === 0x00)) {
      throw new Error('flash.bin is still blank - nothing was actually written');
    }

    fs.writeFileSync(CERT_OUT, key.cert);
    fs.writeFileSync(DIGEST_OUT, String(prepared.digest || ''));
    say(`certificate -> ${CERT_OUT}`);
    say('provisioned');
  } finally {
    await s.stop();
    release();
  }
}

main().catch((err) => {
  console.error(`[provision] ${err && (err.stack || err.message)}`);
  process.exit(1);
});
