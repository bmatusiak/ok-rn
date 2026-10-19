/**
 * crypto.getRandomValues from our own SecureRandom module (src/installRandom.js): fills integer
 * typed arrays in place from the native hex, refuses what Web Crypto refuses, and refuses a native
 * answer of the wrong length rather than handing back zeros.
 */
const mockNative = {getRandomHex: jest.fn((n: number) => 'ab'.repeat(n))};
jest.mock('../specs/NativeRandom', () => ({__esModule: true, default: mockNative}));

const {getRandomValues} = require('../src/installRandom');

test('fills the array in place and returns it; the global is set', () => {
  const a = new Uint8Array(4);
  expect(getRandomValues(a)).toBe(a);
  expect(Array.from(a)).toEqual([0xab, 0xab, 0xab, 0xab]);
  const w = new Uint32Array(2);
  getRandomValues(w);
  expect(mockNative.getRandomHex).toHaveBeenLastCalledWith(8);
  expect((global as any).crypto.getRandomValues).toBe(getRandomValues);
});

test('refuses what Web Crypto refuses', () => {
  expect(() => getRandomValues(new Float32Array(2))).toThrow(TypeError);
  expect(() => getRandomValues(new Uint8Array(65537))).toThrow(RangeError);
});

test('a wrong-length native answer is an error, never zeros', () => {
  mockNative.getRandomHex.mockImplementationOnce(() => 'ab');
  expect(() => getRandomValues(new Uint8Array(4))).toThrow(/answered wrongly/);
});
