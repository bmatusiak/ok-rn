import {device as okdevice} from 'node-onlykey-lib';

/**
 * What a backup file says about itself, before any of it is sent.
 *
 * The mirror of summarizeFirmware, and for the same reason: the library
 * parses and verifies (device/parsers.js), this is the readable half for a
 * screen, and it is pure so it is tested without a phone.
 *
 * device.restore already verifies the digest chain and refuses a file that
 * fails, so nothing damaged was ever going to reach the key. What this adds
 * is the ability to FIND OUT without arming a destructive button: the only
 * way to learn a file was unusable used to be to press Restore and read the
 * error off a control whose whole visual language says it is about to
 * overwrite the key.
 */
export type BackupSummary = {
  ok: boolean;
  /** Data lines - markers and blanks are not counted. */
  lines: number;
  /** What a restore would send. */
  bytes: number;
  /** What the file's bytes compute to, and what its digest line claims. */
  digest: string | null;
  expected: string | null;
  /** Why not, in a sentence, when ok is false. */
  reason: string | null;
};

const EMPTY = {lines: 0, bytes: 0, digest: null, expected: null};

/**
 * Two ways a file is not restorable, and the restore error tells them apart
 * for nobody: a file that is not a backup at all fails in parseBackup, and a
 * backup whose bytes have changed fails in verifyBackup.
 *
 * A firmware file is the likely first case now that Advanced can flash one.
 * Both are armoured text between -- markers and they look alike at a glance,
 * so it is named rather than left as "no backup data found". The test is the
 * one that distinguishes them in the format itself: firmware lines are hex
 * and a firmware file has no digest line, where backup lines are base64 and
 * the digest is the marker that is neither BEGIN nor END.
 *
 * WHICH line broke is not knowable and is not claimed. There is ONE expected
 * value, on the digest line at the end, and each step folds the previous
 * digest into the next - so every line after the damaged one computes a
 * different value too, and no prefix of the chain can be checked against
 * anything. A mismatch says the file is not the file that was captured, and
 * nothing finer. Order is part of what it covers, not only content.
 */
export function summarizeBackup(text: string): BackupSummary {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const data = lines.filter(l => !okdevice.parsers.isMarker(l));
  const looksLikeFirmware =
    data.length > 0 && data.every(l => /^[0-9a-fA-F]+$/.test(l));

  if (looksLikeFirmware) {
    return {
      ...EMPTY,
      ok: false,
      lines: data.length,
      reason:
        'every line is hex and there is no digest - this looks like a FIRMWARE '
        + 'file, not a backup. Advanced is where one of those goes.',
    };
  }

  try {
    const verdict = okdevice.parsers.verifyBackup(text);
    const hex = okdevice.parsers.parseBackup(text);
    return {
      ok: verdict.ok,
      lines: data.length,
      bytes: hex.length / 2,
      digest: verdict.digest ?? null,
      expected: verdict.expected ?? null,
      reason: verdict.ok ? null : verdict.reason ?? 'the digest does not match',
    };
  } catch (e) {
    return {...EMPTY, ok: false, reason: String((e as Error)?.message ?? e)};
  }
}
