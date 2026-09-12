import {summarizeBackup} from '../src/backupFile';
import {device as okdevice, bytes as okbytes} from 'node-onlykey-lib';

const BEGIN = '-----BEGIN ONLYKEY BACKUP-----';
const END = '-----END ONLYKEY BACKUP-----';

/**
 * Build a file the way the firmware types one: base64 data lines, then a
 * digest line that is a marker which is neither BEGIN nor END.
 *
 * The digest is computed with the library's own verifier rather than
 * restated here, because a hand-written expectation would only prove this
 * test agrees with itself.
 */
function backup(lines: string[]) {
  const body = `${BEGIN}\n${lines.join('\n')}\n${END}\n`;
  const {digest} = okdevice.parsers.verifyBackup(body);
  const b64 = okbytes.toBase64(okbytes.fromHex(digest));
  return `${BEGIN}\n${lines.join('\n')}\n--${b64}\n${END}\n`;
}

const A = okbytes.toBase64(okbytes.utf8ToBytes('the first chunk'));
const B = okbytes.toBase64(okbytes.utf8ToBytes('and the second'));

test('a good file reports its lines, its bytes and a verified chain', () => {
  const s = summarizeBackup(backup([A, B]));
  expect(s.ok).toBe(true);
  expect(s.lines).toBe(2);
  expect(s.bytes).toBe('the first chunk'.length + 'and the second'.length);
  expect(s.reason).toBeNull();
});

test('a changed byte is caught, and both digests are shown', () => {
  const changed = okbytes.toBase64(okbytes.utf8ToBytes('the FIRST chunk'));
  const text = backup([A, B]).replace(A, changed);
  const s = summarizeBackup(text);
  expect(s.ok).toBe(false);
  expect(s.digest).not.toBe(s.expected);
  expect(s.digest).toMatch(/^[0-9a-f]{64}$/);
});

test('a reordering is caught, not only a changed byte', () => {
  /* Same lines, same bytes, same count - only the order differs. */
  const good = backup([A, B]);
  const swapped = good.replace(`${A}\n${B}`, `${B}\n${A}`);
  expect(summarizeBackup(swapped).ok).toBe(false);
});

test('a firmware file is named as one rather than called empty', () => {
  /*
   * The mistake this exists for: both formats are armoured text between --
   * markers, and Advanced can flash a firmware file, so the two are one
   * wrong paste apart.
   */
  const s = summarizeBackup(
    '-----BEGIN SIGNED FIRMWARE-----\n' + 'ab'.repeat(80) + '\n-----END SIGNED FIRMWARE-----\n',
  );
  expect(s.ok).toBe(false);
  expect(s.reason).toMatch(/FIRMWARE/);
});

test('a file with no digest line says so instead of claiming a mismatch', () => {
  const s = summarizeBackup(`${BEGIN}\n${A}\n${END}\n`);
  expect(s.ok).toBe(false);
  expect(s.reason).toMatch(/no digest/);
});

test('nothing that could be data at all is refused, not summarised', () => {
  const s = summarizeBackup(`${BEGIN}\n${END}\n`);
  expect(s.ok).toBe(false);
  expect(s.bytes).toBe(0);
  expect(s.reason).toMatch(/no backup data|no digest/);
});
