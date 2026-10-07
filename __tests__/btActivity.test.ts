/**
 * The Bluetooth status icons (Brad, 2026-10-07): purple while data crosses the wire;
 * ⌨ and ⚿ blink every 250 ms, ᛒ is solid; it lasts until a second with no traffic.
 */
import {ioPulse, ioPurple, nextShow, onIo} from '../src/btActivity';

test('a blink: purple, colour, purple, colour - 250 ms each - then the state again', () => {
  const show = nextShow(null, 1000);
  expect([1000, 1249, 1250, 1500, 1750, 1999, 2000].map(t => ioPurple(show, t, false)))
    .toEqual([true, true, false, true, false, false, false]);
});

test('solid (ᛒ): purple the whole second', () => {
  const show = nextShow(null, 1000);
  expect([1000, 1300, 1999, 2000].map(t => ioPurple(show, t, true))).toEqual([true, true, true, false]);
});

test('the second is a grace: more traffic keeps it going until a second with none', () => {
  let show = nextShow(null, 1000);
  show = nextShow(show, 1800); /* still showing: same start, later end */
  expect(show).toEqual({start: 1000, end: 2800});
  expect(ioPurple(show, 2500, true)).toBe(true);
  expect(ioPurple(show, 2800, true)).toBe(false);
  expect(nextShow(show, 3000)).toEqual({start: 3000, end: 4000}); /* after a quiet second: a new one */
});

test('pulses reach the listeners, with their channel', () => {
  const got: string[] = [];
  const off = onIo(c => got.push(c));
  ioPulse('key');
  ioPulse('keyboard');
  off();
  ioPulse('key');
  expect(got).toEqual(['key', 'keyboard']);
});
