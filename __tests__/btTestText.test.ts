/**
 * The US-layout encoder the Password Manager types with (useBtKeyboard typeSecret): all of
 * printable ASCII, backslash and pipe included, one press and one release per character.
 */
import {reportsFor} from '../src/btTestText';

const pressOf = (ch: string) => {
  const {reports, skipped} = reportsFor(ch);
  expect(skipped).toEqual([]);
  expect(reports).toHaveLength(2);
  expect([...reports[1]]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  return {shift: reports[0][0] === 0x02, usage: reports[0][2]};
};

test('backslash and pipe share the US key 0x31, pipe shifted', () => {
  expect(pressOf('\\')).toEqual({shift: false, usage: 0x31});
  expect(pressOf('|')).toEqual({shift: true, usage: 0x31});
});

test('every printable ASCII character can be typed', () => {
  let all = '';
  for (let c = 0x20; c <= 0x7e; c += 1) all += String.fromCharCode(c);
  const {reports, skipped} = reportsFor(all);
  expect(skipped).toEqual([]);
  expect(reports).toHaveLength(all.length * 2);
});

test('a character outside the layout is reported, not dropped silently', () => {
  expect(reportsFor('pä').skipped).toEqual(['ä']);
});

test('Tab and Enter, as typeSecret adds them after a username or a password', () => {
  expect(pressOf('\t')).toEqual({shift: false, usage: 0x2b});
  expect(pressOf('\n')).toEqual({shift: false, usage: 0x28});
});
