import {device as okdevice} from 'node-onlykey-lib';

/**
 * What a signed firmware file says about itself, before anything is sent.
 *
 * The library parses and frames (device/firmware.js); this is the readable
 * half for the screen: how many blocks, how many bytes, and the first
 * block's signature chain so a person can compare it with the release page
 * before pressing anything. Pure, so it is tested without a phone.
 */
export type FirmwareSummary = {
  blocks: number;
  bytes: number;
  first: {signature: string; nextSignature: string};
  last: {signature: string};
};

export function summarizeFirmware(text: string): FirmwareSummary {
  const blocks = okdevice.firmware.parseSignedFirmware(text);
  const first = okdevice.firmware.describeBlock(blocks[0]);
  const last = okdevice.firmware.describeBlock(blocks[blocks.length - 1]);
  return {
    blocks: blocks.length,
    bytes: blocks.reduce((n, line) => n + line.length / 2, 0),
    first: {signature: first.signature, nextSignature: first.nextSignature},
    last: {signature: last.signature},
  };
}

/** The word a person types to confirm each irreversible step. */
export const CONFIRM_WORD = 'UPDATE';
