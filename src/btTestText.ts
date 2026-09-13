/**
 * Text to HID keyboard reports, for TESTING THE BRIDGE ONLY.
 *
 * This is not how the key types. The key emits its own reports on
 * IFACE.KEYBOARD and useBtKeyboard forwards those bytes unchanged - that path
 * has no encoder in it and must not grow one, because the whole point is that
 * what the host receives is what the firmware produced.
 *
 * What this exists for is the question "is the Bluetooth link carrying
 * anything at all", which until now could only be answered by pressing a slot
 * and typing its real contents at whatever window had focus. That is a bad way
 * to debug a link, and a worse way to debug it on someone's own computer.
 *
 * US LAYOUT, printable ASCII, deliberately. The library's `keystrokes.js` maps
 * keycodes to characters across many layouts, but only in that direction - it
 * is a decoder - and inverting a layout spec properly means handling dead keys
 * and AltGr. A test string does not need that; a test string needs `a-z0-9`
 * and enough punctuation to be recognisable. Anything this cannot encode is
 * reported rather than silently dropped, so a test that types half a word says
 * so.
 *
 * Backslash and pipe are the two printable ASCII characters left out, and it
 * is deliberate rather than an oversight: nothing here needs them, and a test
 * string is not the place to be careful about escaping.
 */

/** Report layout: modifiers, reserved, then up to six concurrent keys. */
const REPORT_BYTES = 8;
const MOD_SHIFT = 0x02;

/* Unshifted keys, in USB HID usage order where that is contiguous. */
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '1234567890';

/** Characters that are a shifted form of another key, US layout. */
const SHIFTED: Record<string, string> = {
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5',
  '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  _: '-', '+': '=', '{': '[', '}': ']',
  ':': ';', '"': "'", '~': '`', '<': ',', '>': '.', '?': '/',
};

/** Keys that are neither letters nor digits, by usage code. */
const PUNCT: Record<string, number> = {
  '\n': 0x28, '\t': 0x2b, ' ': 0x2c,
  '-': 0x2d, '=': 0x2e, '[': 0x2f, ']': 0x30,
  ';': 0x33, "'": 0x34, '`': 0x35, ',': 0x36, '.': 0x37, '/': 0x38,
};

/** The usage code for one character, and whether it needs shift. */
function keyFor(ch: string): {usage: number; shift: boolean} | null {
  if (ch >= 'A' && ch <= 'Z') {
    return {usage: 0x04 + LOWER.indexOf(ch.toLowerCase()), shift: true};
  }
  const lower = LOWER.indexOf(ch);
  if (lower !== -1) return {usage: 0x04 + lower, shift: false};

  /*
   * '0' is 0x27 and sits AFTER '9', not before '1' - the usage block runs
   * 1..9 then 0. DIGITS is written in that order so the index is the offset.
   */
  const digit = DIGITS.indexOf(ch);
  if (digit !== -1) return {usage: 0x1e + digit, shift: false};

  const unshifted = SHIFTED[ch];
  if (unshifted) {
    const base = keyFor(unshifted);
    return base ? {usage: base.usage, shift: true} : null;
  }
  if (ch in PUNCT) return {usage: PUNCT[ch], shift: false};
  return null;
}

/**
 * One press report and one release report per character.
 *
 * A release between every character, including repeats: a report is an
 * ABSOLUTE state, so two identical press reports in a row are one key held
 * down, not two keystrokes. "ll" without the gap arrives as "l".
 */
export function reportsFor(text: string): {
  reports: Uint8Array[];
  skipped: string[];
} {
  const reports: Uint8Array[] = [];
  const skipped: string[] = [];
  const release = new Uint8Array(REPORT_BYTES);

  for (const ch of text) {
    const key = keyFor(ch);
    if (!key) {
      skipped.push(ch);
      continue;
    }
    const press = new Uint8Array(REPORT_BYTES);
    press[0] = key.shift ? MOD_SHIFT : 0;
    press[2] = key.usage;
    reports.push(press, release);
  }
  return {reports, skipped};
}
