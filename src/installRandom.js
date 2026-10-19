/*
 * crypto.getRandomValues ON THE GLOBAL, from our own native SecureRandom module
 * (specs/NativeRandom.ts) - imported FIRST by index.js.
 *
 * Hermes has no global `crypto`, so `crypto.getRandomValues` does not exist - and @noble calls it
 * to generate the X25519 secret key for every OKCONNECT, OpenPGP calls it for every key it makes,
 * and Guest Book's swap draws its invite seed from it. A weak source would not fail loudly, it
 * would just make keys predictable, so there is no pure-JS fallback: without the native module
 * the app stops here.
 *
 * Our own code, in this repo (Brad, 2026-10-18: "we must vendor anything we use for creating
 * crypto stuff"); it replaced the react-native-get-random-values package, and behaves as the Web
 * Crypto API does: integer typed arrays only, at most 65536 bytes a call, filled in place and
 * returned.
 */
import NativeRandom from '../specs/NativeRandom';

const MAX = 65536;
const INTEGER_ARRAYS = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array];
if (typeof BigInt64Array !== 'undefined') INTEGER_ARRAYS.push(BigInt64Array, BigUint64Array);

export function getRandomValues(array) {
  if (!INTEGER_ARRAYS.some(T => array instanceof T)) {
    throw new TypeError('crypto.getRandomValues: an integer typed array is needed');
  }
  if (array.byteLength > MAX) {
    throw new RangeError(`crypto.getRandomValues: at most ${MAX} bytes, not ${array.byteLength}`);
  }
  const hex = NativeRandom.getRandomHex(array.byteLength);
  if (typeof hex !== 'string' || hex.length !== array.byteLength * 2) {
    throw new Error('crypto.getRandomValues: the native random source answered wrongly');
  }
  const out = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return array;
}

if (typeof global.crypto !== 'object' || global.crypto === null) global.crypto = {};
global.crypto.getRandomValues = getRandomValues;
