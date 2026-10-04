/**
 * The phone records every derive its soft key answers (src/keyChainRecorder.ts):
 * the key_chain plugin's record decodes, becomes a public-only Key Chain entry,
 * is stored once (last seen after that), and never carries "yours".
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {decodeDerive, deriveEntry, recordDerive, KEYCHAIN_LIST_KEY} from '../src/keyChainRecorder';

const keychain = require('node-onlykey-lib/keychain');

/* okplugin_key_chain.cpp's layout */
function record({transport = 0, code = 232, keytype = 1, label = 7, rp = null as number | null, pub = new Uint8Array(64).fill(9)}) {
  const b = new Uint8Array(72 + pub.length);
  b[0] = 1;
  b[1] = transport;
  b[2] = code & 0xff;
  b[3] = code >> 8;
  b[4] = keytype;
  b[5] = rp === null ? 0 : 1;
  b.fill(label, 6, 38);
  if (rp !== null) b.fill(rp, 38, 70);
  b[70] = pub.length & 0xff;
  b[71] = pub.length >> 8;
  b.set(pub, 72);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

beforeEach(() => AsyncStorage.clear());

test('an agent v2 derive over the vendor interface: ed25519, 32 bytes kept, the label hash as its label', () => {
  const r = decodeDerive(record({}));
  expect(r).toMatchObject({transport: 'vendor', code: 232, keytype: 1, rpIdHash: null});
  const e = deriveEntry(r, '2026-10-03T00:00:00Z');
  expect(e.scheme).toBe('agent-v2');
  expect(e.type).toBe('ed25519');
  expect(e.publicKey.length).toBe(32);
  expect(e.label).toBe(`hash:${'07'.repeat(32)}`);
  expect(e.yours).toBeUndefined();
});

test('a FIDO web derive: P-256 with its 0x04 dropped, the rpId hash kept', () => {
  const pub = new Uint8Array(65).fill(3);
  pub[0] = 4;
  const e = deriveEntry(decodeDerive(record({transport: 1, code: 128, keytype: 2, rp: 5, pub})), 'now');
  expect(e).toMatchObject({scheme: 'web', type: 'p256', transport: 'fido', rpIdHash: '05'.repeat(32)});
  expect(e.publicKey.length).toBe(64);
});

test('recorded once, last seen after that; a bad record throws (and is dropped by the listener)', async () => {
  const hex = record({});
  await recordDerive(decodeDerive(hex));
  await recordDerive(decodeDerive(hex));
  const list = keychain.list.parse(await AsyncStorage.getItem(KEYCHAIN_LIST_KEY));
  expect(list.length).toBe(1);
  expect(list[0].tools).toEqual(['soft key']);
  expect(() => decodeDerive('00')).toThrow();
});
