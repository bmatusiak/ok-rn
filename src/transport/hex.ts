/**
 * Byte <-> hex helpers.
 *
 * Payloads cross the TurboModule boundary as hex strings rather than
 * number[]: a 64-byte report is one 128-char string instead of 64 boxed
 * doubles, which matters when reports stream at HID interrupt rates.
 */

export function bytesToHex(bytes: ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] & 0xff).toString(16).padStart(2, '0');
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[\s:_-]/g, '');
  if (clean.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length hex string (${clean.length} chars)`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`hexToBytes: bad hex at offset ${i * 2}: "${clean.substr(i * 2, 2)}"`);
    }
    out[i] = byte;
  }
  return out;
}

/** `01 ff 00 aa` - for logs. */
export function formatHex(hex: string): string {
  return (hex.match(/.{1,2}/g) ?? []).join(' ');
}

/** Right-pad (or truncate) to exactly `size` bytes; HID reports are fixed-width. */
export function padReport(bytes: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set(bytes.subarray(0, size));
  return out;
}
