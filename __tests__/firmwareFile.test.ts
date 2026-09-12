import {CONFIRM_WORD, nameVersionMismatch, summarizeFirmware} from '../src/firmwareFile';

const BEGIN = '-----BEGIN SIGNED FIRMWARE-----';
const END = '-----END SIGNED FIRMWARE-----';

/** The same block shape the library's firmware.test.js builds: 64 + 2 + 64 hex, then data. */
function block(dataBytes: number, n: number) {
  const sig = n.toString(16).padStart(2, '0').repeat(32);
  const next = (n + 1).toString(16).padStart(2, '0').repeat(32);
  const data = Array.from({length: dataBytes}, (_, i) => ((i + n) & 0xff).toString(16).padStart(2, '0')).join('');
  return `${sig}a0${next}${data}`;
}

test('a signed file summarises to its block count, byte count and signature chain', () => {
  const b1 = block(70, 1);
  const b2 = block(10, 2);
  const s = summarizeFirmware(`${BEGIN}\n${b1}\n${b2}\n${END}\n`);
  expect(s.blocks).toBe(2);
  expect(s.bytes).toBe((b1.length + b2.length) / 2);
  expect(s.first.signature).toBe('01'.repeat(32));
  expect(s.first.nextSignature).toBe('02'.repeat(32));
  expect(s.last.signature).toBe('02'.repeat(32));
});

test('anything that is not signed firmware is refused before a byte could be sent', () => {
  expect(() => summarizeFirmware('-----BEGIN PGP PUBLIC KEY BLOCK-----')).toThrow(/not a signed firmware file/);
  expect(() => summarizeFirmware(`${BEGIN}\nnot hex at all\n${END}`)).toThrow(/not hex/);
});

test('the confirmation word is a word a person types, not a tap', () => {
  expect(CONFIRM_WORD).toBe('UPDATE');
});

/* ------------------------------------- the version the image declares */

import {BUNDLED_DIR} from '../src/firmwareFile';

/*
 * Node's fs, reached without @types/node.
 *
 * The project's tsconfig has no node types on purpose - this is a React
 * Native app and a screen that imported fs would be a bug tsc should catch.
 * A test reading the repo's own files is the one place it is wanted, so the
 * two functions used are declared here rather than opening the door globally.
 */
declare function require(name: string): any;
declare const __dirname: string;
const fs = require('fs') as {
  readFileSync(p: string, encoding: string): string;
  readdirSync(p: string): string[];
};
const path = require('path') as {join(...parts: string[]): string};

const DIR = path.join(__dirname, '..', BUNDLED_DIR);

/**
 * Every release that ships in the repo, and the version each one must state.
 *
 * Written out rather than derived from the filename, because deriving it would
 * make the test agree with the name instead of checking the name against the
 * image - which is the whole point of reading the version at all.
 */
const RELEASES: [string, string][] = [
  ['Signed_OnlyKey_2_1_0_STD.txt', 'v2.1.0-prod'],
  ['Signed_OnlyKey_2_1_1_STD.txt', 'v2.1.1-prod'],
  ['Signed_OnlyKey_2_1_2_STD.txt', 'v2.1.2-prod'],
  ['Signed_OnlyKey_3_0_1_STD.txt', 'v3.0.1-prod'],
  ['Signed_OnlyKey_3_0_2_STD.txt', 'v3.0.2-prod'],
  ['Signed_OnlyKey_3_0_3_STD.txt', 'v3.0.3-prod'],
  ['Signed_OnlyKey_3_0_4_STD.txt', 'v3.0.4-prod'],
  ['Signed_OnlyKey_Beta8_STD_Color.txt', 'v0.2-beta.8c'],
];

test.each(RELEASES)('%s declares %s', (file, version) => {
  const s = summarizeFirmware(fs.readFileSync(path.join(DIR, file), 'utf8'));
  expect(s.declares).toBe(version);
});

test('the bundled folder holds exactly the releases the tests know about', () => {
  /*
   * So a file added to the repo without a line above fails here rather than
   * shipping unchecked. A release nobody has read the version out of is a
   * release whose name is the only thing saying what it is.
   */
  const found = fs.readdirSync(DIR).filter((f: string) => f.endsWith('.txt')).sort();
  expect(found).toEqual(RELEASES.map(([f]) => f).sort());
});

test('a real release has whole-byte blocks after its header', () => {
  /*
   * The 65-byte header, checked against a file rather than against the
   * function that assumes it. An odd remainder would mean the header size is
   * wrong, which is exactly the bug the library had.
   * ok-rn/FINDING-two-block-describers-disagree-by-a-nibble.md
   */
  const text = fs.readFileSync(path.join(DIR, 'Signed_OnlyKey_3_0_2_STD.txt'), 'utf8');
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('--'));
  for (const line of lines) expect((line.length - 130) % 2).toBe(0);
});

test('anything with no readable version reports null rather than guessing', () => {
  /* A short synthetic block: signed-firmware shaped, no string table in it. */
  const block = 'a'.repeat(64) + '1f' + 'b'.repeat(64) + '00'.repeat(64);
  const text = `-----BEGIN SIGNED FIRMWARE-----\n${block}\n-----END SIGNED FIRMWARE-----\n`;
  expect(summarizeFirmware(text).declares).toBeNull();
});

/* ------------------------------------------ the name against the image */

test('every bundled release agrees with its own filename', () => {
  for (const [file, version] of RELEASES) {
    expect(nameVersionMismatch(file, version)).toBeNull();
  }
});

test('a renamed file is caught, and the message says which one wins', () => {
  const said = nameVersionMismatch('Signed_OnlyKey_3_0_4_STD.txt', 'v2.1.0-prod');
  expect(said).toMatch(/named for v3\.0\.4/);
  expect(said).toMatch(/says v2\.1\.0-prod/);
  expect(said).toMatch(/ends up on the key/);
});

test('nothing to compare is not a complaint', () => {
  /* A name with no version in it, and an image that declared none. */
  expect(nameVersionMismatch('Signed_OnlyKey_Beta8_STD_Color.txt', 'v0.2-beta.8c')).toBeNull();
  expect(nameVersionMismatch('Signed_OnlyKey_3_0_4_STD.txt', null)).toBeNull();
});
