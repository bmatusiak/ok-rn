/**
 * Edge's checks in OpenSSL (okssl) instead of JS.
 *
 * WHY (A13, 2026-10-07): a sync spent ~1 s in JS crypto under Hermes - SHA-256
 * over the stored copy and the budgets' hash chains, P-256 on checkpoints, the
 * ticket message hashes - while this app already links OpenSSL 3.5 for its KDF
 * and RSA. Brad: "try not to use JS crypto if okssl can provide it as a faster
 * version". node-onlykey-lib takes a crypto provider (src/crypto/provider.js);
 * this plugs okssl in, once, at start (index.js imports it third).
 *
 * TRUST, THEN USE: before plugging in, every function is checked against the
 * library's JS on pinned answers (and a bad signature must fail). One mismatch,
 * or an APK without these calls, and the checks stay in JS - slower, never wrong.
 *
 * copyHashCuts serves ok-rn's own copy hash (edgeStore.ts): one native pass over
 * the stored copy, the digest at each count asked for.
 */
import * as provider from 'node-onlykey-lib/crypto/provider';
import {fromHex, toHex} from 'node-onlykey-lib/bytes';

type OkSslEdge = {
  sha256Hex(hex: string): string;
  sha256RepeatHex(hex: string, times: number): string;
  sha256CutsHex(hex: string, cutsCsv: string): string;
  hmacSha256Hex(keyHex: string, msgHex: string): string;
  p256VerifyDigestHex(sigHex: string, digestHex: string, pubHex: string): boolean;
  ed25519VerifyHex(sigHex: string, msgHex: string, pubHex: string): boolean;
};

/* pinned answers (noble, node-onlykey-lib's vendored copy) */
const P256 = {
  sig: 'cbe2f586f0871d9d8255a5f0526cb7dd83d53b3df1511179394bcaddb245a9c9633658174c38681e291931ea1442895d5e732e0574be0ef3cf0b298a2bc11399',
  digest: 'dbc1b4c900ffe48d575b5da5c638040125f65db0fe3e24494b76ea986457d986',
  pub: '0410501cd59557f817e7bf5704c3ad78ec4503cd55410c10c1bb510988dc72509422b2ca757c0024bf93d3edccc731ed18f5edbcbc19f61ea49fe0db1c611678c9',
};
const ED25519 = {
  sig: 'bf2dfc08eec72a8fe1c113b43f3560280c36584befb6dbb86dd793722975c7977290cc5066ef6b8610579df05498a71eda52cba6a4d409444f0515a78659390b',
  msg: '040506',
  pub: '93fbce7316450a74e8a7f12dfb32131096cc06f4f08b63cbf649317b21869db8',
};

let ssl: OkSslEdge | null = null;

function flip(hex: string, at: number): string {
  const c = parseInt(hex[at], 16) ^ 1;
  return hex.slice(0, at) + c.toString(16) + hex.slice(at + 1);
}

/* every function against the JS, on known inputs; any difference -> null */
function trusted(n: OkSslEdge): string | null {
  const js = provider.js;
  const abc = Uint8Array.from([0x61, 0x62, 0x63]);
  const x = new Uint8Array(32).fill(7);
  const k = new Uint8Array(32).fill(9);
  const two = Uint8Array.from([...abc, ...x]);
  if (n.sha256Hex(toHex(abc)) !== toHex(js.sha256(abc))) return 'sha256';
  if (n.sha256Hex('') !== toHex(js.sha256(new Uint8Array(0)))) return 'sha256 of nothing';
  if (n.sha256RepeatHex(toHex(x), 5) !== toHex(js.sha256Repeat(x, 5))) return 'sha256Repeat';
  if (n.sha256CutsHex(toHex(two), `0,3,${two.length}`) !== [new Uint8Array(0), abc, two].map(b => toHex(js.sha256(b))).join(',')) return 'sha256Cuts';
  if (n.hmacSha256Hex(toHex(k), toHex(abc)) !== toHex(js.hmacSha256(k, abc))) return 'hmacSha256';
  if (n.p256VerifyDigestHex(P256.sig, P256.digest, P256.pub) !== true) return 'p256 good signature';
  if (n.p256VerifyDigestHex(flip(P256.sig, 10), P256.digest, P256.pub) !== false) return 'p256 bad signature';
  if (n.ed25519VerifyHex(ED25519.sig, ED25519.msg, ED25519.pub) !== true) return 'ed25519 good signature';
  if (n.ed25519VerifyHex(flip(ED25519.sig, 10), ED25519.msg, ED25519.pub) !== false) return 'ed25519 bad signature';
  return null;
}

function install(): void {
  let n: OkSslEdge;
  try {
    n = require('../specs/NativeOkSsl').default as OkSslEdge;
    if (typeof n?.sha256Hex !== 'function') throw new Error('this build has no okssl Edge calls');
    const t0 = Date.now();
    const wrong = trusted(n);
    if (wrong) throw new Error(`OpenSSL disagrees with the JS on ${wrong}`);
    console.log(`[crypto] Edge checks in OpenSSL (self-check ${Date.now() - t0} ms)`);
  } catch (e) {
    console.log(`[crypto] Edge checks stay in JS: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  ssl = n;
  provider.setCryptoProvider({
    sha256: (b: Uint8Array) => fromHex(n.sha256Hex(toHex(b))),
    sha256Repeat: (b: Uint8Array, times: number) => fromHex(n.sha256RepeatHex(toHex(b), times)),
    hmacSha256: (key: Uint8Array, msg: Uint8Array) => fromHex(n.hmacSha256Hex(toHex(key), toHex(msg))),
    p256VerifyDigest: (sig: Uint8Array, digest: Uint8Array, pub: Uint8Array) => n.p256VerifyDigestHex(toHex(sig), toHex(digest), toHex(pub)),
    ed25519Verify: (sig: Uint8Array, msg: Uint8Array, pub: Uint8Array) => n.ed25519VerifyHex(toHex(sig), toHex(msg), toHex(pub)),
  }, 'openssl');
}

/** the digest of bytes[0..cut) for each cut, in one native pass; null when OpenSSL is not in use */
export function copyHashCuts(bytes: Uint8Array, cuts: number[]): string[] | null {
  if (!ssl) return null;
  return ssl.sha256CutsHex(toHex(bytes), cuts.join(',')).split(',');
}

install();
