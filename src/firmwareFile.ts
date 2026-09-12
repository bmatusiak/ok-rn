import {device as okdevice} from 'node-onlykey-lib';

/**
 * What a signed firmware file says about itself, before anything is sent.
 *
 * The library parses and frames (device/firmware.js); this is the readable
 * half for the screen: how many blocks, how many bytes, the first block's
 * signature chain so a person can compare it with the release page, and the
 * version the image itself declares. Pure, so it is tested without a phone.
 */
export type FirmwareSummary = {
  blocks: number;
  bytes: number;
  first: {signature: string; nextSignature: string};
  last: {signature: string};
  /**
   * The version string compiled into the image, or null if none was found.
   *
   * Null is UNKNOWN, not "unsigned" - see the reader below for the two ways a
   * real file can legitimately fail to yield one.
   */
  declares: string | null;
};

/**
 * Hex characters of block header before the block's own data.
 *
 * 32-byte signature, 1-byte info, 32-byte next signature. The release images
 * are what pin it: their lines are 33026 and 32898 characters, so this leaves
 * 16448 and 16384 bytes, the second being exactly a 16 KB flash page. A
 * 129-character header - which one of the library's two describers used to
 * assume - leaves an odd number of characters, which is not bytes at all.
 * ok-rn/FINDING-two-block-describers-disagree-by-a-nibble.md
 */
const BLOCK_HEADER_HEX = 130;

/**
 * A version token: v2.1.0-prod, v3.0.4-prod, v0.2-beta.8c.
 *
 * Two shapes because the constant changed. The 3.0 line builds it from parts -
 * `"v" maj "." min "." pat OKversionkeyword` in onlykey.h - and appends the
 * model letter at runtime, so the compiled string ends at -prod. The 2019 beta
 * carried the whole thing as a literal, letter included.
 */
const VERSION = /v[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-[A-Za-z0-9.]+)?[a-z]?/;

/**
 * The version the image declares, read out of the compiled firmware.
 *
 * WHY THE BYTES ARE REVERSED IN FOURS. The block data is stored word-swapped,
 * so a straight decode gives text with its characters shuffled inside every
 * four-byte group: "ukcaaP phpssesarcuS" where "Backup Passphrase" is meant.
 * Reversing each group of four puts it back. This was found by trying the
 * decode at every plausible offset and group size and keeping the one that
 * produced readable English, then confirmed on all eight release files.
 *
 * WHY THIS IS WORTH HAVING. Before H2 a person types a word that re-images a
 * key, and the only thing naming the version was the FILENAME. A file renamed
 * by hand, or downloaded twice into "(1)", said whatever its name said. This
 * asks the image.
 *
 * Null has two innocent causes and so is never reported as tampering: a
 * release older than the version constant, and any future release that
 * encrypts rather than merely signs. The screen says "cannot tell" for both.
 */
function readDeclaredVersion(blocks: string[]): string | null {
  let hex = '';
  for (const block of blocks) hex += block.slice(BLOCK_HEADER_HEX);
  if (hex.length % 2) hex = hex.slice(0, -1);

  const raw = fromHex(hex);
  const swapped = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 4) {
    for (let j = 0; j < 4; j++) swapped[i + j] = raw[i + 3 - j] ?? 0;
  }

  let text = '';
  for (let i = 0; i < swapped.length; i++) text += String.fromCharCode(swapped[i]);
  return text.match(VERSION)?.[0] ?? null;
}

/** Hermes has no Buffer, so the hex decode is done here. */
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

export function summarizeFirmware(text: string): FirmwareSummary {
  const blocks = okdevice.firmware.parseSignedFirmware(text);
  const first = okdevice.firmware.describeBlock(blocks[0]);
  const last = okdevice.firmware.describeBlock(blocks[blocks.length - 1]);
  return {
    blocks: blocks.length,
    bytes: blocks.reduce((n, line) => n + line.length / 2, 0),
    first: {signature: first.signature, nextSignature: first.nextSignature},
    last: {signature: last.signature},
    declares: readDeclaredVersion(blocks),
  };
}

/** The word a person types to confirm each irreversible step. */
export const CONFIRM_WORD = 'UPDATE';

/**
 * Does the filename claim a version the image does not?
 *
 * A filename is the weakest thing in this whole path: it survives renaming,
 * a second download becomes "… (1)", and nothing checks it. Until the image
 * could be read, the name was the ONLY statement of which firmware a person
 * was about to put on a key they cannot re-image.
 *
 * Returns a sentence when the two disagree and null when they do not, which
 * includes the two cases where no comparison is possible: a name that carries
 * no version (`Signed_OnlyKey_Beta8_STD_Color`) and an image that declares
 * none. Silence here means "nothing to contradict", never "verified" - the
 * screen shows what the image declared either way, because that is the fact,
 * and this only catches the case where the two statements conflict.
 */
export function nameVersionMismatch(
  name: string,
  declares: string | null,
): string | null {
  const parts = name.match(/(\d+)_(\d+)_(\d+)/);
  if (!parts || !declares) return null;

  const fromName = `v${parts[1]}.${parts[2]}.${parts[3]}`;
  if (declares.startsWith(fromName)) return null;

  return (
    `${name} is named for ${fromName}, but the image inside it says ` +
    `${declares}. One of the two is wrong, and the image is the one that ` +
    'ends up on the key.'
  );
}

/**
 * Where the bundled signed releases live, in the repo and in the APK.
 *
 * ONE folder, not two: `android/app/build.gradle` adds this path to the asset
 * source set, so a file dropped into the repo is in the next build and there
 * is no copy step that can be forgotten. The name is the asset directory too,
 * which is what `NativeShare.listAssets` is given.
 */
export const BUNDLED_DIR = 'signed_firmware';
