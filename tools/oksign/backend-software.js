#!/usr/bin/env node
/*
 * A signing backend with no device in it.
 *
 * Speaks the same one-line protocol as sign.js - a hex digest in, a hex
 * signature out - but signs with an ordinary RSA key from a PEM file. Its only
 * job is to prove the Java half: the provider registering itself, delayed
 * provider selection landing on us, apksig's own verify of what we returned,
 * and the shape of an APK afterwards. All of that is worth settling before an
 * emulated OnlyKey is added underneath, because a failure there is a failure
 * in one of two places rather than one of five.
 *
 * Kept rather than thrown away when the device backend arrives: it is the
 * control. If signing breaks later, running the same APK through this says
 * immediately whether the Java side or the device side moved.
 *
 * WHY THIS REBUILDS THE DigestInfo BY HAND. The provider hashes the message
 * itself and sends only the 32-byte digest, because an APK signing block can
 * be megabytes and there is no reason to push that through a pipe. So this
 * receives a digest, not a message, and crypto.sign() cannot be used - it
 * wants the message. A PKCS#1 v1.5 signature is RSA over a DER DigestInfo
 * wrapping the digest, so that is assembled here and handed to the raw
 * primitive.
 *
 * The device does exactly the same thing internally: okcrypto.cpp picks the
 * hash OID from the digest LENGTH (32 -> SHA-256) and calls
 * mbedtls_rsa_rsassa_pkcs1_v15_sign. Same bytes out, different place.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const readline = require('readline');

/* DER DigestInfo prefix for SHA-256, RFC 8017 section 9.2 notes. */
const SHA256_DIGEST_INFO = Buffer.from('3031300d060960864801650304020105000420', 'hex');

const keyPath = process.env.OKSIGN_SOFTWARE_KEY;
if (!keyPath) {
  process.stderr.write('OKSIGN_SOFTWARE_KEY must name a PEM private key\n');
  process.exit(2);
}

const key = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const hex = line.trim();
  if (!hex) return;
  try {
    const digest = Buffer.from(hex, 'hex');
    if (digest.length !== 32) {
      throw new Error(`expected a 32-byte SHA-256 digest, got ${digest.length}`);
    }
    /*
     * privateEncrypt with PKCS#1 padding is the SIGNING primitive: OpenSSL's
     * RSA_private_encrypt applies type-1 padding, which is what a v1.5
     * signature uses. (publicEncrypt would be type 2, for encryption.)
     */
    const sig = crypto.privateEncrypt(
      { key, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.concat([SHA256_DIGEST_INFO, digest]),
    );
    process.stdout.write(`${sig.toString('hex')}\n`);
  } catch (err) {
    /* ERR on the wire, detail on stderr - see OnlyKeyBackend's protocol note. */
    process.stdout.write(`ERR ${err.message}\n`);
    process.stderr.write(`[oksign-software] ${err.stack}\n`);
  }
});
