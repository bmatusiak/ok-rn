/**
 * A random password for a slot.
 *
 * The desktop rewrite added one (ok-app-rewrite utils/passwordGenerator.ts)
 * and neither the old desktop app nor this one had it, so a password for a
 * slot was whatever a person typed. The character classes below are the
 * rewrite's, because a password generated on one client should be the same
 * shape as one generated on another.
 *
 * ## Why the index is drawn differently
 *
 * The reference picks a character with `random32 % charset.length`, which is
 * biased: 2^32 is not a multiple of most charset sizes, so the first
 * `2^32 mod n` characters of the set come up slightly more often than the
 * rest. It is a small bias and it is still a bias in a password generator,
 * which is the one place not to have one. This rejects the tail of the
 * range instead - draw again when the value lands in the part that would
 * skew the result - so every character is equally likely.
 *
 * Passwords are generated ON THE PHONE and typed BY THE KEY. Nothing here
 * keeps one: the caller puts it in the slot editor's field, the field goes
 * to the device, and the only copy afterwards is the device's.
 */

export type PasswordOptions = {
  length: number;
  upper: boolean;
  lower: boolean;
  digits: boolean;
  symbols: boolean;
};

/*
 * The rewrite splits its symbols across four toggles (special, punct,
 * braces, space). One toggle here: a phone form with seven checkboxes for
 * the punctuation of a password is a form nobody reads, and the union is
 * what "symbols" means to a person. Space is left out entirely - a leading
 * or trailing space in a typed password is invisible and unfixable.
 */
const CHARSETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '~!@#$%^&*+=-_"\';:,.?(){}[]<>',
};

export const MIN_LENGTH = 8;
/*
 * The device stores 56 bytes of password (slotConfig's own cap), and a
 * password longer than the field is one the device silently keeps half of.
 */
export const MAX_LENGTH = 56;

/*
 * React Native provides `crypto.getRandomValues` on the global and no
 * `crypto.subtle` (see src/installWebCrypto.js, which fills in the rest for
 * openpgp). TypeScript's DOM lib is not in this project's config, so the
 * global is declared here rather than pulled in wholesale.
 */
declare const crypto: {getRandomValues<T extends Uint32Array>(array: T): T};

/** One index in [0, max), without the modulo bias the reference has. */
function randomIndex(max: number): number {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

/**
 * A password with at least one character from every class that is on.
 *
 * Asking for symbols and getting a password with none in it is the common
 * complaint about generators, and the site that rejects it will not say
 * which class was missing. So one character of each chosen class is placed
 * first and the whole thing is then shuffled, which costs nothing and makes
 * the guarantee real.
 */
export function generatePassword(options: PasswordOptions): string {
  const {length} = options;
  if (!Number.isInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH) {
    throw new Error(`length must be a whole number ${MIN_LENGTH}..${MAX_LENGTH}`);
  }

  const classes = (Object.keys(CHARSETS) as (keyof typeof CHARSETS)[])
    .filter(name => options[name])
    .map(name => CHARSETS[name]);
  if (!classes.length) throw new Error('pick at least one kind of character');
  if (classes.length > length) {
    throw new Error(`a password of ${length} cannot hold one of each of ${classes.length} kinds`);
  }

  const all = classes.join('');
  const chars: string[] = classes.map(set => set[randomIndex(set.length)]);
  while (chars.length < length) chars.push(all[randomIndex(all.length)]);

  /* Fisher-Yates, so the guaranteed characters are not always at the front. */
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    const swap = chars[i];
    chars[i] = chars[j];
    chars[j] = swap;
  }
  return chars.join('');
}

/** Which classes a string actually contains, for a test or a strength hint. */
export function classesIn(password: string): (keyof typeof CHARSETS)[] {
  return (Object.keys(CHARSETS) as (keyof typeof CHARSETS)[])
    .filter(name => [...password].some(c => CHARSETS[name].includes(c)));
}
