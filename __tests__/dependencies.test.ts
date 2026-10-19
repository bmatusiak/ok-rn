/**
 * NOTHING THAT MAKES CRYPTO COMES FROM OUTSIDE THIS REPO (Brad, 2026-10-18: "as a security app, we
 * must vendor anything we use for creating crypto stuff ... the lib used to generate the phrase
 * must be vendored, and not external to the repo").
 *
 * Crypto libraries live once, vendored in node-onlykey-lib (src/vendor, with integrity hashes);
 * randomness is our own native module (specs/NativeRandom.ts). This test fails when a new outside
 * package is added - each one is a decision, written down here - or when app code loads a crypto
 * library from node_modules instead of through the lib.
 */
const fs = require('fs') as {readFileSync(p: string, e: string): string; readdirSync(p: string, o: {withFileTypes: true}): Array<{name: string; isDirectory(): boolean}>};
const path = require('path') as {join(...p: string[]): string};

const ROOT = path.join(__dirname, '..');

/* every outside package the app may load, and why it is not vendored */
const ALLOWED: Record<string, string> = {
  'node-onlykey-lib': 'our library, pinned to a commit; it carries the vendored crypto',
  '@bmatusiak/rectify': "Brad's plugin system, pinned to a commit; makes no crypto",
  react: 'the UI framework',
  'react-native': 'the UI framework',
  '@react-native/new-app-screen': 'React Native template screen; makes no crypto',
  'react-native-safe-area-context': 'screen insets; makes no crypto',
  '@react-native-async-storage/async-storage': 'storage of public or already-sealed data; makes no crypto',
};

/* crypto and randomness libraries that must only ever come through node-onlykey-lib */
const CRYPTO = /^(@noble\/|@scure\/|tweetnacl|openpgp|elliptic|crypto-js|bip39|bip32|secp256k1|ethers|bitcoinjs|libsodium|sodium|node-forge|react-native-get-random-values|react-native-quick-crypto|expo-crypto|expo-random|uuid)/;

test('package.json lists only reviewed outside packages', () => {
  const deps = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies);
  expect(deps.filter(d => !(d in ALLOWED))).toEqual([]);
});

test('app code loads no crypto library except through node-onlykey-lib', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '__tests__' && e.name !== 'generated') walk(p);
      } else if (/\.(js|ts|tsx)$/.test(e.name)) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/(?:from\s+|require\()\s*['"]([^'"]+)['"]/g)) {
          if (CRYPTO.test(m[1])) offenders.push(`${p.slice(ROOT.length + 1)}: ${m[1]}`);
        }
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  for (const f of ['index.js', 'App.tsx']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/(?:from\s+|require\()\s*['"]([^'"]+)['"]/g)) if (CRYPTO.test(m[1])) offenders.push(`${f}: ${m[1]}`);
  }
  expect(offenders).toEqual([]);
});
