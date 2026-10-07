/**
 * Bluetooth traffic, for the status icons in the top bar (Brad, 2026-10-07):
 * "when data is going over the wire, it switches to purple".
 *
 *   ⚿  the key service (computers, onlykey-js, FIDO): blinks purple
 *   ⌨  the keyboard (keystrokes sent):                 blinks purple
 *   ᛒ  any Bluetooth traffic:                          solid purple
 *
 * A blink lasts a second - purple, its colour, purple, its colour, 250 ms each -
 * then the icon shows its state again; ᛒ stays purple the whole second instead.
 * More traffic while it lasts keeps it going until a second after the last.
 *
 * The places data crosses the wire call ioPulse (transport/FidoGatt.ts: requests
 * in, replies out; vendorBridge.ts: vendor frames out; hooks/useBtKeyboard.ts:
 * keystroke reports). Nothing here is read back - it is only for the eye.
 */
export type IoChannel = 'key' | 'keyboard';

export const IO_SHOW_MS = 1000;
export const IO_STEP_MS = 250;

const listeners = new Set<(channel: IoChannel, at: number) => void>();

export function ioPulse(channel: IoChannel): void {
  const at = Date.now();
  for (const fn of [...listeners]) {
    try { fn(channel, at); } catch { /* a status icon never breaks the traffic it shows */ }
  }
}

export function onIo(fn: (channel: IoChannel, at: number) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/* one showing of traffic: from its first pulse until a second after its last */
export type IoShow = {start: number; end: number};

export function nextShow(was: IoShow | null, at: number): IoShow {
  return was && at < was.end ? {start: was.start, end: at + IO_SHOW_MS} : {start: at, end: at + IO_SHOW_MS};
}

/** purple now? solid: the whole showing; blink: every other 250 ms step, purple first */
export function ioPurple(show: IoShow | null, now: number, solid: boolean): boolean {
  if (!show || now >= show.end || now < show.start) return false;
  return solid || Math.floor((now - show.start) / IO_STEP_MS) % 2 === 0;
}
