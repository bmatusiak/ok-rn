import OkEmu, {IFACE} from './OkEmu';
import {buildMessage} from '../hooks/useOkEmu';

/**
 * Provisioning a soft key: setting its PIN.
 *
 * The sequence is not obvious from any single source, because it is spread
 * across a wizard's step table in OnlyKey-App. It is transcribed here from
 * onlykey-testing/lib/fixtures/states/initialized.js, which drives it against
 * both real and emulated devices:
 *
 *   OKPIN            -> "Enter PIN"
 *   press digits     -> one "password appended with" per digit
 *   OKPIN            -> "Storing PIN"
 *   OKPIN            -> "Confirm PIN"
 *   press digits     -> one ack per digit again
 *   OKPIN            -> "Both PINs Match"
 *
 * The same message byte drives every transition; what it means depends on the
 * state machine's position. That is why the acknowledgements have to be waited
 * for rather than assumed - sending the next OKPIN early silently advances
 * past a step.
 *
 * All of it is observed on the DEBUG serial interface, which exists only in
 * DEBUG firmware builds. This is a test and setup path, not something a
 * production build can rely on.
 */

/** okcore.h: #define OKxxx (TYPE_INIT | 0xNN), TYPE_INIT = 0x80. */
export const OKPIN = 0xe1;
export const OKPINSD = 0xe2;
export const OKPINSEC = 0xe3;

/**
 * The firmware prints one of these per digit: "password appended with", "SD
 * password appended with", "2nd profile password appended with". Counting them
 * is the only way to know a whole burst was consumed - one print per BYTE
 * means a first-match wait returns after the first digit.
 */
const DIGIT_ACK = /password appended with/gi;
const TOO_SHORT = /Error PIN is not between 7 - 10 digits/;
const MISMATCH = /Error PINs Don't Match/;

/** Accumulates the firmware's DEBUG output so a wait can span several reports. */
class DebugLog {
  private text = '';
  private off: (() => void) | null = null;

  start(): void {
    if (this.off) {
      return;
    }
    this.off = OkEmu.on('stream', event => {
      if (event.iface !== IFACE.SEREMU || event.dir !== 0) {
        return;
      }
      let chunk = '';
      for (const b of event.bytes) {
        if (b >= 0x20 && b <= 0x7e) chunk += String.fromCharCode(b);
        else if (b === 0x0a || b === 0x0d) chunk += '\n';
      }
      this.text += chunk;
    });
  }

  stop(): void {
    this.off?.();
    this.off = null;
  }

  clear(): void {
    this.text = '';
  }

  get contents(): string {
    return this.text;
  }

  /** Resolves once `pattern` appears. Rejects on `reject` patterns. */
  async waitFor(
    pattern: RegExp,
    opts: {timeoutMs?: number; reject?: RegExp[]} = {},
  ): Promise<string> {
    const {timeoutMs = 15000, reject = []} = opts;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const bad of reject) {
        const hit = bad.exec(this.text);
        if (hit) {
          throw new Error(`device reported: ${hit[0].trim()}`);
        }
      }
      if (pattern.test(this.text)) {
        return this.text;
      }
      await new Promise<void>(r => { setTimeout(r, 50); });
    }
    throw new Error(
      `timed out after ${timeoutMs}ms waiting for ${pattern}. Saw: ` +
        JSON.stringify(this.text.slice(-160)),
    );
  }

  /** Resolves once `pattern` has matched at least `count` times. */
  async waitForCount(pattern: RegExp, count: number, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const matches = this.text.match(new RegExp(pattern.source, 'gi'));
      if (matches && matches.length >= count) {
        return;
      }
      await new Promise<void>(r => { setTimeout(r, 50); });
    }
    throw new Error(
      `timed out waiting for ${count}x ${pattern}. Saw: ` +
        JSON.stringify(this.text.slice(-160)),
    );
  }
}

/**
 * Press buttons on the emulated device.
 *
 * One line for the whole sequence: the firmware queues the presses and replays
 * them one per loop() iteration, so there is no per-digit delay here to get
 * wrong. Sending a PIN as separate writes is how the test kit once ended up
 * with the "store" message landing mid-burst and the firmware seeing a
 * five-digit PIN.
 *
 * Digits are the button numbers 1..6; the firmware's DEBUG harness reads a
 * line of ASCII digits terminated by a newline.
 */
export async function pressLine(digits: string): Promise<void> {
  const line = `${digits}\n`;
  const bytes = new Uint8Array(line.length);
  for (let i = 0; i < line.length; i++) {
    bytes[i] = line.charCodeAt(i);
  }
  await OkEmu.write(IFACE.SEREMU, bytes);
}

export type ProvisionOptions = {
  /** 7-10 digits, each 1..6 - they are button presses, not a keypad. */
  pin: string;
  log?: (message: string) => void;
};

/**
 * Sets the primary PIN on an uninitialised device.
 *
 * Does NOT restart afterwards: `initialized` is only recomputed from flash in
 * setup(), so the caller decides when to take that cost. The firmware prints
 * its restart notice and then resets before the DEBUG buffer is flushed, so
 * the acknowledgement of a restart is the next boot, never a message.
 */
export async function provisionPin({pin, log = () => {}}: ProvisionOptions): Promise<void> {
  if (!/^[1-6]{7,10}$/.test(pin)) {
    throw new Error(
      `PIN must be 7-10 digits and each digit must be a button 1-6, got "${pin}"`,
    );
  }

  const debug = new DebugLog();
  debug.start();

  const advance = async (label: string, expect: RegExp, reject: RegExp[] = []) => {
    debug.clear();
    await OkEmu.write(IFACE.VENDOR, buildMessage(OKPIN));
    await debug.waitFor(expect, {reject});
    log(label);
  };

  const enterDigits = async () => {
    debug.clear();
    await pressLine(pin);
    await debug.waitForCount(DIGIT_ACK, pin.length);
    log(`entered ${pin.length} digits`);
  };

  try {
    await advance('armed', /Enter PIN/);
    await enterDigits();
    await advance('stored', /Storing PIN/, [TOO_SHORT]);
    await advance('confirming', /Confirm PIN/);
    await enterDigits();
    await advance('committed', /Both PINs Match/, [MISMATCH, TOO_SHORT]);
  } finally {
    debug.stop();
  }
}
