import {splitPublicKeys} from '../src/armoredKeys';

const BEGIN = '-----BEGIN PGP PUBLIC KEY BLOCK-----';
const END = '-----END PGP PUBLIC KEY BLOCK-----';
const key = (body: string) => `${BEGIN}\n\n${body}\n${END}`;

test('several keys in one box come out in order', () => {
  const a = key('mQINBFaaaa');
  const b = key('mQINBFbbbb');
  const blocks = splitPublicKeys(`please encrypt to both\n${a}\n\nand\n\n${b}\n`);
  expect(blocks).toEqual([a, b]);
});

test('one key is one block, and the blank lines inside it are not separators', () => {
  /*
   * Blocks are found by their armour headers rather than by splitting on
   * blank lines, because an armoured key is full of them - the line between
   * the header and the base64 is one.
   */
  const one = key('mQINBFaaaa\n\nbbbb');
  expect(splitPublicKeys(one)).toEqual([one]);
});

test('a box with no key block is empty, not a guess', () => {
  expect(splitPublicKeys('')).toEqual([]);
  expect(splitPublicKeys('just some words')).toEqual([]);
  /* A PRIVATE key is not a recipient, and is not picked up as one. */
  expect(splitPublicKeys('-----BEGIN PGP PRIVATE KEY BLOCK-----\nx\n-----END PGP PRIVATE KEY BLOCK-----')).toEqual([]);
});
