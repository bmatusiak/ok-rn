/**
 * OPENSSL, the app's own crypto core (android/okssl: native-sea-openssl,
 * pinned by version and sha256 in its build.gradle). Owner, 2026-10-01:
 * "OpenSSL is all about security, so test its core for sanity and security
 * (randomness)".
 *
 * Key Chain makes RSA keys and stretches passphrases through it, so every
 * check here is about what reaches a user's key:
 *   - the linked library is the pinned release, and its RNG says it is seeded;
 *   - raw RAND_bytes, the primes it makes, and the platform RNG (the WebCrypto
 *     shim's salts and IVs) pass randomness tripwires;
 *   - the primes are prime (Miller-Rabin), far apart, and the key works;
 *   - every RSA size the Wizard offers, and two keys made at once;
 *   - native PBKDF2 against the RFC 7914 vector and against the JS PBKDF2;
 *   - bad input is refused.
 *
 * It touches no OnlyKey, so it runs early: a broken crypto core should stop
 * a run before anything is written to a key.
 */
'use strict';

const keychain = require('node-onlykey-lib/keychain');
const {pbkdf2: jsPbkdf2} = require('node-onlykey-lib/vendor/@noble/hashes/pbkdf2.js');
const {sha256} = require('node-onlykey-lib/vendor/@noble/hashes/sha2.js');
const NativeOkSsl = require('../specs/NativeOkSsl').default;
const NativeRsaGen = require('../specs/NativeRsaGen').default;
const NativeKdf = require('../specs/NativeKdf').default;

const PASS = 'openssl-e2e-passphrase-00000001';
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const fromHex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const utf8 = s => new TextEncoder().encode(s);

/* PBKDF2-HMAC-SHA256 the way the app does it: WebCrypto, i.e. the shim with the native hook (installWebCrypto.js). */
async function pbkdf2Sha256(password, salt, iterations, dkLen) {
  const subtle = globalThis.crypto.subtle;
  const k = await subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt, iterations}, k, dkLen * 8));
}

/* The primes below 2000 that divide a big-endian number: none, for a real RSA modulus or prime. */
function smallFactors(bytes) {
  const out = [];
  for (let p = 2; p < 2000; p++) {
    let prime = true;
    for (let d = 2; d * d <= p; d++) if (p % d === 0) { prime = false; break; }
    if (!prime) continue;
    let r = 0;
    for (const b of bytes) r = (r * 256 + b) % p;
    if (r === 0) out.push(p);
  }
  return out;
}

/* ---------------------------------------------------- OpenSSL self-checks */

/*
 * THE PINNED OPENSSL. android/okssl/build.gradle fetches native-sea-openssl
 * OPENSSL_RELEASE by version and sha256; this is that version, as the linked
 * library reports it. Move both together.
 */
const OPENSSL_PINNED = '3.5.9';

const big = b => BigInt('0x' + (hex(b) || '0'));
function modPow(base, exp, mod) {
  let r = 1n;
  let b = base % mod;
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
  }
  return r;
}
function modInverse(a, m) {
  let [r0, r1, t0, t1] = [m, ((a % m) + m) % m, 0n, 1n];
  while (r1) {
    const q = r0 / r1;
    [r0, r1, t0, t1] = [r1, r0 - q * r1, t1, t0 - q * t1];
  }
  return r0 === 1n ? ((t0 % m) + m) % m : null;
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
/* A random BigInt in [2, n-2], from getRandomValues. */
function randomBelow(n, bytes) {
  for (;;) {
    const v = big(globalThis.crypto.getRandomValues(new Uint8Array(bytes))) % n;
    if (v >= 2n && v <= n - 2n) return v;
  }
}
/* Miller-Rabin with `rounds` random bases: false means certainly composite. */
function probablyPrime(n, rounds, bytes) {
  if (n < 4n || !(n & 1n)) return false;
  let d = n - 1n;
  let r = 0;
  while (!(d & 1n)) { d >>= 1n; r++; }
  outer: for (let i = 0; i < rounds; i++) {
    let x = modPow(randomBelow(n, bytes), d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let j = 1; j < r; j++) {
      x = (x * x) % n;
      if (x === n - 1n) continue outer;
    }
    return false;
  }
  return true;
}

/*
 * RANDOMNESS CHECKS on a byte sample. Not a certification - a tripwire for the
 * failures that do happen: an RNG never seeded, returning zeros, or repeating
 * itself (a fixed seed, a buffer reused across calls). Each bound is about 5
 * sigma, so a working RNG all but never fails it and a broken one does.
 */
function randomnessChecks(name, bytes, assert, log) {
  let ones = 0;
  for (const b of bytes) for (let v = b; v; v >>= 1) ones += v & 1;
  const bits = bytes.length * 8;
  const counts = new Array(256).fill(0);
  for (const b of bytes) counts[b]++;
  const expected = bytes.length / 256;
  /* chi-square, 255 degrees of freedom: mean 255, sd ~22.6 */
  const chi = counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
  const blocks = new Set();
  let repeats = 0;
  for (let i = 0; i + 16 <= bytes.length; i += 16) {
    const k = hex(bytes.slice(i, i + 16));
    if (blocks.has(k)) repeats++;
    blocks.add(k);
  }
  log(`${name}: ${bytes.length} bytes, ones ${(ones / bits * 100).toFixed(2)}%, chi-square ${chi.toFixed(0)}, repeated blocks ${repeats}`);
  assert.ok(Math.abs(ones - bits / 2) < 5 * (Math.sqrt(bits) / 2), `${name}: ${ones} of ${bits} bits set - not random`);
  assert.ok(chi < 255 + 5 * 22.6, `${name}: byte frequencies far from uniform (chi-square ${chi.toFixed(0)})`);
  assert.equal(repeats, 0, `${name}: a 16-byte block repeats`);
}
const concat = chunks => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};


/* What one test makes and the next checks (the RSA key for the primality test). */
const shared = {rsa: null};

module.exports = function openssl({describe, it}) {
  describe(openssl.name, () => {
    it('RSA-2048 from OpenSSL: two 1024-bit halves, and no small prime divides anything',
      async ({log, assert}) => {
        const s = shared;
        const t0 = Date.now();
        const key = await keychain.generate.hostKey('rsa', {bits: 2048});
        log(`made in ${Date.now() - t0} ms`);
        const {p, q} = key.material;
        assert.equal(p.length, 128, 'p is not 1024 bits');
        assert.equal(q.length, 128, 'q is not 1024 bits');
        assert.equal(key.publicKey.length, 256, 'the modulus is not 2048 bits');
        assert.ok(p[0] & 0x80 && q[0] & 0x80, 'a prime is shorter than its 1024 bits');
        assert.equal(BigInt('0x' + hex(p)) * BigInt('0x' + hex(q)), BigInt('0x' + hex(key.publicKey)), 'n is not p*q');
        for (const [name, v] of [['n', key.publicKey], ['p', p], ['q', q]]) {
          assert.equal(smallFactors(v).join(','), '', `${name} has a small prime factor: not an RSA key`);
        }
        s.rsa = key;
      });

    it('the primes are prime (Miller-Rabin), far apart, and the key works (e*d = 1, a CRT round trip)',
      async ({log, assert, skip}) => {
        const s = shared;
        if (!s.rsa) skip('no RSA key from the test above');
        const p = big(s.rsa.material.p);
        const q = big(s.rsa.material.q);
        const n = big(s.rsa.publicKey);
        const e = 65537n;
        const t0 = Date.now();
        assert.ok(probablyPrime(p, 16, 136), 'p is composite (Miller-Rabin): OpenSSL handed back a non-prime');
        assert.ok(probablyPrime(q, 16, 136), 'q is composite (Miller-Rabin): OpenSSL handed back a non-prime');
        log(`Miller-Rabin, 16 rounds each: ${Date.now() - t0} ms`);
        const diff = p > q ? p - q : q - p;
        assert.ok(diff > 1n << 924n, '|p - q| is under 2^(1024-100): a key Fermat factoring breaks (FIPS 186-5 B.3.1)');
        const lambda = ((p - 1n) * (q - 1n)) / gcd(p - 1n, q - 1n);
        const d = modInverse(e, lambda);
        assert.ok(d !== null, 'e is not invertible mod lcm(p-1, q-1): not a usable RSA key');
        /* encrypt with e, decrypt with d by CRT: the way a device uses the key */
        const m = randomBelow(n, 264);
        const c = modPow(m, e, n);
        const mp = modPow(c, d % (p - 1n), p);
        const mq = modPow(c, d % (q - 1n), q);
        const h = (modInverse(q, p) * (mp - mq + p)) % p;
        const back = mq + h * q;
        assert.ok(back === m, 'a CRT decrypt with this key does not give back what e encrypted');
        log(`RSA round trip (e then CRT d): ${Date.now() - t0} ms in all`);
      });

    it('3072 and 4096 bits: the sizes the Wizard offers', async ({log, assert}) => {
      for (const bits of [3072, 4096]) {
        const t0 = Date.now();
        const key = await keychain.generate.hostKey('rsa', {bits});
        log(`RSA-${bits}: ${Date.now() - t0} ms`);
        assert.equal(key.publicKey.length, bits / 8, `RSA-${bits}: a ${key.publicKey.length * 8}-bit modulus`);
        assert.equal(key.material.p.length, bits / 16, `RSA-${bits}: p is not ${bits / 2} bits`);
        assert.equal(smallFactors(key.publicKey).join(','), '', `RSA-${bits}: the modulus has a small prime factor`);
        keychain.generate.wipe(key);
      }
    });

    it('two keys made at the same time are two different keys', async ({log, assert}) => {
      /* each OpenSSL call runs on its own thread: concurrent calls must not share state */
      const [a, b] = await Promise.all([
        keychain.generate.hostKey('rsa', {bits: 2048}),
        keychain.generate.hostKey('rsa', {bits: 2048}),
      ]);
      const primes = new Set([a.material.p, a.material.q, b.material.p, b.material.q].map(hex));
      log(`distinct primes: ${primes.size} of 4`);
      assert.equal(primes.size, 4, 'two concurrent key generations shared a prime');
      for (const k of [a, b]) {
        assert.equal(smallFactors(k.publicKey).join(','), '', 'a concurrently made modulus has a small prime factor');
        keychain.generate.wipe(k);
      }
    });

    it('OpenSSL is the pinned release, and its RNG says it is seeded', async ({log, assert}) => {
      const version = await NativeOkSsl.version();
      log(`linked: ${version}`);
      assert.ok(new RegExp(`^OpenSSL ${OPENSSL_PINNED.replace(/\./g, '\\.')}\\b`).test(version),
        `the APK links "${version}", not OpenSSL ${OPENSSL_PINNED} - android/okssl/build.gradle's pin`);
      assert.equal(await NativeOkSsl.randStatus(), true, 'RAND_status() says the RNG is not seeded');
    });

    it('RANDOMNESS: raw RAND_bytes, OpenSSL\'s primes, and the platform RNG all look random',
      async ({log, assert}) => {
        /* raw RAND_bytes: two draws must differ; 8 KiB of it through the checks */
        const one = fromHex(await NativeOkSsl.randomBytes(4096));
        const two = fromHex(await NativeOkSsl.randomBytes(4096));
        assert.ok(hex(one) !== hex(two), 'RAND_bytes returned the same 4096 bytes twice');
        randomnessChecks('RAND_bytes', concat([one, two]), assert, log);

        /*
         * Where the randomness ends up: 8 RSA-2048 keys, 16 primes. A prime's
         * first bytes have their top bits set and its last is odd, so only the
         * middle bytes count.
         */
        const sample = [];
        const primes = new Set();
        const t0 = Date.now();
        for (let i = 0; i < 8; i++) {
          const key = await keychain.generate.hostKey('rsa', {bits: 2048});
          for (const prime of [key.material.p, key.material.q]) {
            primes.add(hex(prime));
            sample.push(prime.slice(2, prime.length - 2));
          }
          keychain.generate.wipe(key);
        }
        log(`8 RSA-2048 keys in ${Date.now() - t0} ms`);
        assert.equal(primes.size, 16, 'OpenSSL produced the same prime twice: its RNG repeats');
        randomnessChecks('OpenSSL primes', concat(sample), assert, log);

        /* getRandomValues: what the WebCrypto shim draws salts and IVs from */
        const platform = [];
        for (let i = 0; i < 16; i++) platform.push(globalThis.crypto.getRandomValues(new Uint8Array(512)));
        assert.equal(new Set(platform.map(hex)).size, 16, 'getRandomValues returned the same bytes twice');
        randomnessChecks('getRandomValues', concat(platform), assert, log);
      });

    it('native PBKDF2 agrees with the JavaScript one on random inputs', async ({log, assert}) => {
      for (const [rounds, dkLen] of [[1, 16], [1000, 32], [4096, 64]]) {
        const rnd = n => globalThis.crypto.getRandomValues(new Uint8Array(n));
        const password = rnd(1 + (rnd(1)[0] % 40));
        const salt = rnd(8 + (rnd(1)[0] % 25));
        const native = await pbkdf2Sha256(password, salt, rounds, dkLen);
        const js = jsPbkdf2(sha256, password, salt, {c: rounds, dkLen});
        log(`${rounds} rounds, ${password.length}-byte password, ${salt.length}-byte salt -> ${dkLen} bytes: ${hex(native) === hex(js) ? 'same' : 'DIFFERENT'}`);
        assert.equal(hex(native), hex(js), `native and JS PBKDF2 disagree (${rounds} rounds)`);
      }
    });

    it('bad input is refused, not computed', async ({log, assert}) => {
      const refused = async (what, call) => {
        let err = null;
        try { await call(); } catch (e) { err = e; }
        log(`${what}: ${err ? `refused (${String(err.message || err).slice(0, 70)})` : 'ACCEPTED'}`);
        assert.ok(err, `${what} was accepted`);
      };
      await refused('RSA-1024', () => NativeRsaGen.generatePrimes(1024, 65537));
      await refused('PBKDF2 with 0 rounds', () => NativeKdf.pbkdf2Sha256('70', '73', 0, 32));
      await refused('PBKDF2 asking for 2000 bytes', () => NativeKdf.pbkdf2Sha256('70', '73', 1, 2000));
      await refused('RAND_bytes(0)', () => NativeOkSsl.randomBytes(0));
      await refused('RAND_bytes(70000)', () => NativeOkSsl.randomBytes(70000));
    });

    it('native PBKDF2-HMAC-SHA256 gives the RFC 7914 vector, and 600000 rounds are quick',
      async ({log, assert}) => {
        log(`native PBKDF2 hook: ${typeof (globalThis.okShim && globalThis.okShim.nativePbkdf2)}`);
        const out = await pbkdf2Sha256(utf8('passwd'), utf8('salt'), 1, 64);
        assert.equal(hex(out),
          '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc'
          + '49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783',
          'PBKDF2-HMAC-SHA256("passwd", "salt", 1, 64) is not RFC 7914 section 11');
        const t0 = Date.now();
        await pbkdf2Sha256(utf8(PASS), utf8('saltsaltsaltsalt'), 600000, 32);
        const ms = Date.now() - t0;
        log(`600000 rounds: ${ms} ms`);
        assert.ok(ms < 15000, `600000 rounds took ${ms} ms - the native path is not in use`);
      });

  });
};
