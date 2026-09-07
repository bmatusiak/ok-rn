/**
 * @format
 */

import {bytesToHex, formatHex, hexToBytes, padReport} from '../src/transport/hex';

describe('hex', () => {
  test('round-trips arbitrary bytes', () => {
    const bytes = Uint8Array.from([0x00, 0x01, 0x7f, 0x80, 0xff]);
    expect(bytesToHex(bytes)).toBe('00017f80ff');
    expect(Array.from(hexToBytes('00017f80ff'))).toEqual(Array.from(bytes));
  });

  test('pads each byte to two digits', () => {
    expect(bytesToHex([0x0a, 0x00])).toBe('0a00');
  });

  test('tolerates separators on the way in', () => {
    expect(Array.from(hexToBytes('01:02 03-04_05'))).toEqual([1, 2, 3, 4, 5]);
  });

  test('rejects an odd-length string rather than dropping a nibble', () => {
    expect(() => hexToBytes('abc')).toThrow(/odd-length/);
  });

  test('rejects non-hex characters rather than yielding NaN bytes', () => {
    expect(() => hexToBytes('zz')).toThrow(/bad hex/);
  });

  test('formatHex groups bytes for logs', () => {
    expect(formatHex('01ff00aa')).toBe('01 ff 00 aa');
  });

  test('padReport zero-fills a short payload to the report width', () => {
    const padded = padReport(Uint8Array.from([1, 2, 3]), 8);
    expect(Array.from(padded)).toEqual([1, 2, 3, 0, 0, 0, 0, 0]);
  });

  test('padReport truncates a payload that overflows the report', () => {
    const padded = padReport(Uint8Array.from([1, 2, 3, 4, 5]), 3);
    expect(Array.from(padded)).toEqual([1, 2, 3]);
  });
});
