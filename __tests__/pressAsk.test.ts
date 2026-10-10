/*
 * The press sheet's facts (src/pressAsk.ts; Brad, 2026-10-10: "blind presses is a blocker").
 * The firmware record is built here byte by byte from okplugin_key_chain.cpp's layout, and the
 * identity's label straight from SHA-256 of its text - never with the code under test's shaping.
 */
import {_resetPressAsk, _setPress, decodePress, firmwarePressFor, nameOfLabel} from '../src/pressAsk';

jest.mock('../specs/NativeOkEmu', () => ({__esModule: true, default: {onPluginEvent: () => ({remove() {}})}}));
const LIST: any[] = [];
jest.mock('../src/keyChainRecorder', () => ({readKeyChainList: async () => LIST}));

const hex = (bytes: number[]) => bytes.map(b => b.toString(16).padStart(2, '0')).join('');
const {sha256} = require('node-onlykey-lib/vendor/@noble/hashes/sha2.js');
const sha = (s: string): string => hex(Array.from(sha256(Uint8Array.from(s, c => c.charCodeAt(0))) as Uint8Array));
const wait = (slot: number, what = 'sign') => ({what, opcode: 0xed, slot, mode: 'press', entered: 0} as any);

beforeEach(() => _resetPressAsk());

test('decodePress: the key_chain plugin\'s press record - version, transport, opcode, slot, subject, label', () => {
  const subject = Array.from({length: 32}, (_, i) => i);
  const label = Array.from({length: 32}, (_, i) => 0xa0 + (i % 16));
  const p = decodePress(hex([1, 0, 0xed, 221, 1, ...subject, ...label]), 1000)!;
  expect(p).toEqual({transport: 'vendor', opcode: 0xed, slot: 221, subject: hex(subject), label: hex(label), at: 1000});
  expect(decodePress(hex([1, 1, 0xf0, 2, 0, ...subject, ...new Array(32).fill(0)]))!.label).toBeNull();
  expect(decodePress(hex([2, 0, 0xed, 221, 1, ...subject, ...label]))).toBeNull(); /* another version */
  expect(decodePress('00')).toBeNull();
});

test('firmwarePressFor: only the record of THIS wait - same opcode and slot, made just before it', () => {
  const rec = {transport: 'vendor' as const, opcode: 0xed, slot: 221, subject: 'aa', label: null, at: 10_000};
  _setPress(rec);
  expect(firmwarePressFor(wait(221), 11_000)).toBe(rec);
  expect(firmwarePressFor(wait(222), 11_000)).toBeNull(); /* another slot */
  expect(firmwarePressFor(wait(221), 20_000)).toBeNull(); /* an older wait's record */
});

test('nameOfLabel: the firmware label names the Key Chain entry it hashes from; a recorded hash is listed, unnamed', async () => {
  const uid = 'Claude (nitro16) 2026 <bmatusiak+agent@gmail.com>';
  const label = sha(`gpg://${uid}`);
  expect(await nameOfLabel(label)).toEqual({listed: false, name: null});
  LIST.push({kind: 'derived', label: `hash:${label}`});
  expect(await nameOfLabel(label)).toEqual({listed: true, name: null});
  LIST.push({kind: 'derived', scheme: 'gpg', label: uid});
  expect(await nameOfLabel(label)).toEqual({listed: true, name: `gpg://${uid}`});
  expect(await nameOfLabel(sha('claude@nitro16'))).toEqual({listed: false, name: null});
  LIST.push({kind: 'derived', scheme: 'ssh', label: 'claude@nitro16'});
  expect(await nameOfLabel(sha('claude@nitro16'))).toEqual({listed: true, name: 'ssh://claude@nitro16'});
});
