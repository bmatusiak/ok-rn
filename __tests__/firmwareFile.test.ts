import {CONFIRM_WORD, summarizeFirmware} from '../src/firmwareFile';

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
