/**
 * @format
 *
 * This was `hex.test.ts`, testing `src/transport/hex.ts` — an app-local copy of
 * functions the library already had in `src/bytes.js`, down to the same
 * separator-stripping regex. The copy is gone and the library's own
 * `test/bytes.test.js` covers every case this file used to: the round trip, the
 * two-digit padding, separators on the way in, odd-length input and non-hex
 * characters.
 *
 * What is left is the pair below, which is not about hex at all.
 */

import {transport as contract} from 'node-onlykey-lib';

describe('toReport', () => {
  test('zero-fills a short payload to the report width', () => {
    expect(Array.from(contract.toReport(Uint8Array.from([1, 2, 3]), 8))).toEqual([
      1, 2, 3, 0, 0, 0, 0, 0,
    ]);
  });

  test('REFUSES an overflow where padReport silently truncated it', () => {
    // padReport returned the first N bytes, so an over-long frame went to the
    // device as a valid-looking short message. A caller could not tell.
    expect(() => contract.toReport(Uint8Array.from([1, 2, 3, 4, 5]), 3)).toThrow(
      /frame is 5 bytes/,
    );
  });
});
