import {
  MAX_LENGTH,
  MIN_LENGTH,
  classesIn,
  generatePassword,
} from '../src/passwordGenerator';

const ALL = {upper: true, lower: true, digits: true, symbols: true};

test('a password is the length asked for and holds one of every class chosen', () => {
  /*
   * Asking for symbols and getting none is the usual complaint about
   * generators, and the site that rejects the password will not say which
   * class was missing. Checked over many draws rather than one, because a
   * generator that satisfies it by luck would pass a single sample.
   */
  for (let i = 0; i < 200; i += 1) {
    const pw = generatePassword({length: 12, ...ALL});
    expect(pw).toHaveLength(12);
    expect(classesIn(pw).sort()).toEqual(['digits', 'lower', 'symbols', 'upper']);
  }
});

test('only the classes asked for appear', () => {
  for (let i = 0; i < 100; i += 1) {
    const pw = generatePassword({length: 20, upper: false, lower: true, digits: true, symbols: false});
    expect(classesIn(pw).sort()).toEqual(['digits', 'lower']);
  }
});

test('the guaranteed characters are not always at the front', () => {
  /*
   * One of each class is placed first and then the whole thing shuffled. If
   * the shuffle were missing, position 0 would be an uppercase letter every
   * single time.
   */
  const firsts = new Set<string>();
  for (let i = 0; i < 100; i += 1) {
    firsts.add(classesIn(generatePassword({length: 10, ...ALL})[0])[0]);
  }
  expect(firsts.size).toBeGreaterThan(1);
});

test('two passwords are not the same one', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100; i += 1) seen.add(generatePassword({length: 16, ...ALL}));
  expect(seen.size).toBe(100);
});

test('every character of the set is reachable, none is impossible', () => {
  /*
   * A rejection-sampled index has an easy failure mode: an off-by-one in
   * the limit makes the LAST character of the set unreachable. Over this
   * many draws from a ten-character set, a missing one is conclusive.
   */
  const digits = new Set<string>();
  for (let i = 0; i < 400; i += 1) {
    for (const c of generatePassword({length: 24, upper: false, lower: false, digits: true, symbols: false})) {
      digits.add(c);
    }
  }
  expect([...digits].sort().join('')).toBe('0123456789');
});

test('impossible requests are refused, not silently adjusted', () => {
  expect(() => generatePassword({length: 3, ...ALL})).toThrow(/length must be/);
  expect(() => generatePassword({length: MAX_LENGTH + 1, ...ALL})).toThrow(/length must be/);
  expect(() => generatePassword({length: 12.5, ...ALL})).toThrow(/whole number/);
  expect(() => generatePassword({length: 12, upper: false, lower: false, digits: false, symbols: false}))
    .toThrow(/at least one kind/);
  /* Four classes cannot each appear in a password of three. */
  expect(() => generatePassword({length: MIN_LENGTH, ...ALL})).not.toThrow();
});
