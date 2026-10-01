/**
 * KEY CHAIN, on the soft key: what the tab does, without the tab.
 *
 * Two suites, because one run cannot both write and read back. Writing a key
 * needs CONFIG MODE, a public-key read is refused in config mode, and config
 * mode ends only at a power cycle - the runner's force-stop between runs (see
 * 14b-pqcSlots for the long version). So:
 *
 *   14a5-keychain (this file, unlocked, BEFORE 14b): checks what the LAST run's
 *     14c-keychainWrite wrote, then everything that needs no config mode -
 *     the PGP certificate the Key signs for the pair it made, the encrypted
 *     PEM copy opened again, derive, and the public list file. OpenSSL itself
 *     (RSA, PBKDF2, randomness) has its own suite, 1b-openssl.
 *   14c-keychainWrite (AFTER 14b, which leaves config mode on): writes the
 *     next run's keys and wipes, and records what it expects in AsyncStorage.
 *
 * SLOTS NOTHING ELSE TOUCHES: ECC 113/114 (a PGP pair, decrypt + sign), ECC
 * 115 (made, then wiped), RSA4 (an RSA-2048 key from the App), RSA2 (loaded,
 * then wiped). 9-cryptoSign keeps to 101/103/104 (and probes 105, 106, 116 as
 * empty), 14b to 110-112, and the owner's own keys on this soft key sit in
 * RSA1, ECC1/2 and ECC4.
 */
'use strict';

const AsyncStorage = require('@react-native-async-storage/async-storage').default;
const {getOnlyKey} = require('../src/onlykey');
const {pressDigits} = require('./helpers/pressDigits');
const {buildInfo} = require('../src/buildInfo');
const {device: deviceLib} = require('node-onlykey-lib');
const keychain = require('node-onlykey-lib/keychain');
const {pgpCert} = require('node-onlykey-lib/crypto');
const {fromBase64} = require('node-onlykey-lib/bytes');
const {cbc} = require('node-onlykey-lib/vendor/@noble/ciphers/aes.js');

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;

const PIN = '1234561';
const RECORD_KEY = 'okrn.e2e.keychain';
const PAIR = {decrypt: 113, sign: 114};
const PASS = 'key-chain-e2e-passphrase-0001';
const TAP = 4;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const fromHex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const utf8 = s => new TextEncoder().encode(s);

/* PBKDF2-HMAC-SHA256 the way the app does it: WebCrypto, i.e. the shim with the native hook (installWebCrypto.js). */
async function pbkdf2Sha256(password, salt, iterations, dkLen) {
  const subtle = globalThis.crypto.subtle;
  const k = await subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt, iterations}, k, dkLen * 8));
}

/* One DER TLV at `at`: {tag, start (of the value), end}. */
function tlv(der, at) {
  const tag = der[at];
  let len = der[at + 1];
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + der[start + i];
    start += n;
  }
  return {tag, start, end: start + len};
}
const children = (der, node) => {
  const out = [];
  for (let at = node.start; at < node.end;) { const c = tlv(der, at); out.push(c); at = c.end; }
  return out;
};

/* Press the digits one at a time, and stop once the device has answered (14b's reasoning). */
async function pressChallenge(digits, log, isAnswered = () => false) {
  const pressed = [];
  for (const d of digits) {
    await OkEmu.pressQueue(String(d), TAP);
    pressed.push(d);
    await delay(600);
    if (isAnswered()) break;
  }
  log(`pressed ${pressed.join('-')} of ${digits.join('-')}`);
}

let shared = null;
async function ready(log) {
  if (shared) return shared;
  if (!OkEmu.isRunning()) await OkEmu.start();
  const {device, okcrypto} = await getOnlyKey();
  let state = await device.connect();
  if (!/UNLOCKED/i.test(String(state.status))) {
    await device.unlock(PIN, {timeoutMs: 20000, enterDigits: pressDigits({log})});
    state = await device.connect();
  }
  log(`device: ${String(state.status).trim()}`);
  const caps = deviceLib.version.capabilities(String(state.status).trim(), {unreleased: buildInfo.unreleased});
  let record = null;
  try { record = JSON.parse((await AsyncStorage.getItem(RECORD_KEY)) || 'null'); } catch { record = null; }
  shared = {device, okcrypto, caps, record, probes: {}, rsa: null};
  return shared;
}

module.exports = function keyChain({describe, it}) {
  describe(keyChain.name, () => {
    it('what the last run wrote reads back: the pair, the App-made RSA key, and the wipes',
      async ({log, assert, skip}) => {
        const s = await ready(log);
        if (s.device.inConfigMode) skip('the device is in config mode - public keys cannot be read');
        if (!s.record) skip('no earlier run of 14c-keychainWrite on this device - the next run checks this one');
        log(`written by the run at ${s.record.at}`);
        const labels = new Map((await s.device.readKeyLabels()).keys.map(k => [k.slot, k.label || '']));

        for (const [slot, kind] of [[PAIR.decrypt, 'x25519'], [PAIR.sign, 'ed25519']]) {
          const p = await s.device.probeKeySlot(slot);
          s.probes[slot] = p;
          log(`ECC${slot - 100}: ${p.kind} "${labels.get(slot)}"`);
          assert.equal(p.kind, kind, `ECC${slot - 100} should hold the ${kind} key the last run generated`);
          assert.equal(labels.get(slot), s.record.pairLabel, `ECC${slot - 100} lost its label`);
        }

        const rsa = await s.device.probeKeySlot(4);
        log(`RSA4: ${rsa.kind} ${rsa.bits || ''}`);
        assert.equal(rsa.kind, 'rsa', 'RSA4 should hold the RSA key the last run made in the App');
        assert.equal(hex(rsa.publicKey), s.record.rsa4, 'RSA4 answers a different modulus than the key that was loaded');
        assert.equal(labels.get(4), s.record.rsa4Label, 'RSA4 lost its label');

        /*
         * The wipes. An ECC wipe stores type 0, so the slot is plainly empty.
         * An RSA wipe on 3.1.0 firmware leaves the type (FINDING-rsa-wipe-keeps-
         * key-type): the slot still answers a "modulus", and the lib reads that
         * as empty + wiped. A fixed firmware answers "no key" outright - both
         * are an empty slot to a client.
         */
        const ecc = await s.device.probeKeySlot(115);
        log(`ECC15 (wiped): ${JSON.stringify({kind: ecc.kind})}`);
        assert.equal(ecc.kind, 'empty', 'ECC15 was wiped but still holds a key');
        assert.equal(labels.get(115), '', 'the wipe left ECC15 its label');
        const rsa2 = await s.device.probeKeySlot(2);
        log(`RSA2 (wiped): ${JSON.stringify({kind: rsa2.kind, wiped: rsa2.wiped || false})}`);
        assert.equal(rsa2.kind, 'empty', 'RSA2 was wiped but reads as a key');
        assert.equal(labels.get(2), '', 'the wipe left RSA2 its label');
      });

    it('the PGP certificate for the pair: the Key signs it, and openpgp.js accepts it',
      async ({log, assert, skip}) => {
        const s = await ready(log);
        const sign = s.probes[PAIR.sign];
        const ecdh = s.probes[PAIR.decrypt];
        if (!sign || !ecdh) skip('no pair to build on (see the test above)');
        const openpgp = require('node-onlykey-lib/crypto/pgp');
        const cert = await pgpCert.buildCertificate(openpgp, {
          userId: 'Key Chain e2e <e2e@example.com>',
          curve: 'ed25519',
          created: 1700000000,
          signPublic: sign.publicKey,
          ecdhPublic: ecdh.publicKey,
          sign: digest => s.okcrypto.sign(PAIR.sign, digest, {
            timeoutMs: 25000,
            expectBytes: 64,
            confirm: ({digits, isAnswered}) => pressChallenge(digits, log, isAnswered),
          }),
        });
        log(`fingerprint ${cert.fingerprint}`);
        const key = await openpgp.readKey({armoredKey: cert.armored});
        await key.verifyPrimaryKey();
        const enc = await key.getEncryptionKey();
        assert.equal(key.getUserIDs()[0], 'Key Chain e2e <e2e@example.com>');
        assert.equal(enc.getAlgorithmInfo().algorithm, 'ecdh', 'the decrypt subkey is not an ECDH key');
        assert.equal(key.getFingerprint().toUpperCase(), cert.fingerprint, 'openpgp.js reads another fingerprint');
      });

    it('an RSA-2048 key made in the App (OpenSSL), for the copy below', async ({log, assert}) => {
      /* OpenSSL itself is checked in its own suite (1b-openssl); this is the key the copy holds */
      const s = await ready(log);
      s.rsa = await keychain.generate.hostKey('rsa', {bits: 2048});
      assert.equal(s.rsa.publicKey.length, 256, 'not a 2048-bit modulus');
    });

    it('the encrypted PEM copy opens again with its passphrase, and holds the same primes',
      async ({log, assert, skip}) => {
        const s = await ready(log);
        if (!s.rsa) skip('no RSA key from the test above');
        const {p, q} = s.rsa.material;
        const pem = await keychain.export.encryptedPem({type: 'rsa', p, q, e: s.rsa.e || 65537}, PASS, {confirm: PASS});
        assert.ok(pem.startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----'), 'not an encrypted PKCS#8 PEM');
        const der = fromBase64(pem.replace(/-----[^-]+-----|\s/g, ''));

        /* EncryptedPrivateKeyInfo { AlgorithmIdentifier PBES2 { PBKDF2 {salt, iter, ...}, AES-256-CBC {iv} }, data } */
        const top = tlv(der, 0);
        const [alg, data] = children(der, top);
        const [, params] = children(der, alg);
        const [kdf, scheme] = children(der, params);
        const [, kdfParams] = children(der, kdf);
        const [salt, iter] = children(der, kdfParams);
        const [, iv] = children(der, scheme);
        let rounds = 0;
        for (let i = iter.start; i < iter.end; i++) rounds = rounds * 256 + der[i];
        log(`PBES2: ${rounds} rounds, ${salt.end - salt.start}-byte salt, ${iv.end - iv.start}-byte IV`);
        assert.equal(rounds, 600000, 'the copy is not stretched by 600000 rounds');

        const aesKey = await pbkdf2Sha256(utf8(PASS), der.slice(salt.start, salt.end), rounds, 32);
        const plain = cbc(aesKey, der.slice(iv.start, iv.end)).decrypt(der.slice(data.start, data.end));
        /* PrivateKeyInfo { version, algorithm, OCTET STRING { RSAPrivateKey { 0, n, e, d, p, q, ... } } } */
        const pki = tlv(plain, 0);
        const [, , inner] = children(plain, pki);
        const rsaKey = tlv(plain, inner.start);
        const ints = children(plain, rsaKey).map(c => plain.slice(c.start, c.end));
        const strip = b => (b[0] === 0 ? b.slice(1) : b);
        assert.equal(hex(strip(ints[1])), hex(s.rsa.publicKey), 'the copy holds another modulus');
        assert.equal(hex(strip(ints[4])), hex(p), 'the copy holds another p');
        assert.equal(hex(strip(ints[5])), hex(q), 'the copy holds another q');
        keychain.generate.wipe(s.rsa);
      });

    it('derive: the same label gives the same public key, every time',
      async ({log, assert, skip}) => {
        const s = await ready(log);
        if (s.device.inConfigMode) skip('config mode drops the derive');
        const spec = {scheme: 'label', type: 'p256', label: 'keychain-e2e.example'};
        const a = await keychain.derive.derivePublic(s.okcrypto, spec);
        const b = await keychain.derive.derivePublic(s.okcrypto, spec);
        log(`derived ${a.artifacts.hex.slice(0, 16)}...`);
        assert.equal(a.kind, 'derived');
        assert.equal(a.artifacts.hex, b.artifacts.hex, 'the same label derived two different keys');
        /* kept the way the tab keeps it: derivePublic returns the key, the list makes it an entry */
        s.derived = keychain.list.createEntry(a);
      });

    it('the public list file: written, read back, merged - and it refuses a private key',
      async ({log, assert, skip}) => {
        const s = await ready(log);
        if (!s.derived) skip('no derived entry from the test above');
        const text = keychain.list.serialize([s.derived]);
        const back = keychain.list.parse(text);
        assert.equal(back.length, 1);
        assert.equal(back[0].id, s.derived.id, 'the entry came back as another one');
        assert.equal(hex(back[0].publicKey), hex(s.derived.publicKey));
        const {added, kept} = keychain.list.merge([s.derived], back);
        assert.equal(`${added}/${kept}`, '0/1', 'merging the same entry added a copy');
        let refused = null;
        try {
          keychain.list.createEntry({kind: 'external', type: 'ed25519', name: 'x', publicKey: fromHex('11'.repeat(32)), secret: fromHex('22'.repeat(32))});
        } catch (e) { refused = e; }
        log(`private field: ${refused ? refused.message : 'ACCEPTED'}`);
        assert.ok(refused, 'the list took an entry carrying a private key');
      });
  });
};
