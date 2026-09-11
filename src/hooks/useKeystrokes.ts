import {useCallback, useEffect, useRef, useState} from 'react';
import {device as okdevice, transport as oktransport} from 'node-onlykey-lib';

import OkEmu from '../transport/OkEmu';
import UsbPipe from '../transport/UsbPipe';
import {useBackend} from './KeyContext';
import type {Backend} from './keySession';
import {useKeyboardLayout} from './useKeyboardLayout';

const {IFACE, DIR} = oktransport;

/**
 * What the ACTIVE key has typed, as text.
 *
 * THE KEYBOARD IS CAPTURED, NOT LET LOOSE. A hard key's interface 0 is
 * claimed by this app, which detaches it from the kernel's HID driver: what
 * the key types goes nowhere on the phone except here. The soft key never had
 * anywhere else to type. So for both, the only way to see a slot come out is
 * a pane that decodes the reports - and until this hook there was none. The
 * slot editor showed masked segments during a read and the backup screen
 * counted characters; nothing showed the text as it arrived.
 *
 * ## One source at a time
 *
 * Subscribed to whichever pipe is active - OkEmu or UsbPipe - never both.
 * They emit the same stream shape (iface, dir, bytes), so the decoder does
 * not know which key it is reading; the backend chooses the subscription and
 * a switch resets the text, because a buffer that carried on across keys
 * would show one key's password under the other's name.
 *
 * ## Decoded with the remembered layout
 *
 * useKeyboardLayout is what the slot editor and backup use, and the decoder
 * here is rebuilt when it changes - which is how a wrong layout becomes
 * VISIBLE: the pane shows the characters the phone thinks the key typed, and
 * a German key read through the US table shows its z and y swapped here
 * before it shows up as a wrong password anywhere else. See
 * FINDING-the-decode-layout-was-written-and-never-read.md.
 *
 * ## Flushed, not per report
 *
 * A slot is fifty reports in a burst; setState per report is fifty renders,
 * and a screen that never idles cannot be read by uiautomator (see useLog).
 * A short flush batches a burst into one render while still feeling live.
 */
const FLUSH_MS = 150;
const MAX_TEXT = 4000;

type StreamEvent = {iface: number; dir: number; bytes: Uint8Array};

export function useKeystrokes(backendOverride?: Backend): {
  /** Everything decoded so far, newest at the end. */
  text: string;
  /** How many 8-byte reports arrived. Counts key-ups too; it is the raw proof. */
  reports: number;
  /** The decode layout in use, so the pane can say it. */
  layout: string;
  clear: () => void;
} {
  /*
   * APP SCOPE, not screen scope. Mounted inside the Keyboard tab, this heard
   * nothing typed while another tab was open - and a press on a hard key's
   * own buttons happens whenever a finger lands. App.tsx owns one instance
   * and hands the backend in, since it renders the provider rather than
   * sitting under it.
   */
  const context = useBackend();
  const backend = backendOverride ?? context;
  const {layout} = useKeyboardLayout(backend);

  const [text, setText] = useState('');
  const [reports, setReports] = useState(0);

  const decoder = useRef(okdevice.keystrokes.createDecoder({layout}));
  const pendingText = useRef('');
  const pendingReports = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    decoder.current.reset();
    pendingText.current = '';
    pendingReports.current = 0;
    setText('');
    setReports(0);
  }, []);

  /* A new layout means a new table; what was decoded before stays as it was. */
  useEffect(() => {
    decoder.current = okdevice.keystrokes.createDecoder({layout});
  }, [layout]);

  useEffect(() => {
    /* A different key: what the other one typed is not this one's. */
    clear();

    const flush = () => {
      timer.current = null;
      const addText = pendingText.current;
      const addReports = pendingReports.current;
      pendingText.current = '';
      pendingReports.current = 0;
      if (addReports === 0) return;
      setReports(n => n + addReports);
      if (addText) {
        setText(prev => {
          const next = prev + addText;
          return next.length > MAX_TEXT ? next.slice(next.length - MAX_TEXT) : next;
        });
      }
    };

    const onStream = (event: StreamEvent) => {
      /* Device to host, which this library calls OUT. See UsbPipe's header. */
      if (event.iface !== IFACE.KEYBOARD || event.dir !== DIR.OUT) return;
      const before = decoder.current.text.length;
      decoder.current.push(Array.from(event.bytes));
      pendingText.current += decoder.current.text.slice(before);
      pendingReports.current += 1;
      if (timer.current === null) timer.current = setTimeout(flush, FLUSH_MS);
    };

    const pipe = backend === 'usb' ? UsbPipe : OkEmu;
    const off = pipe.on('stream', onStream);
    return () => {
      off();
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [backend, clear]);

  return {text, reports, layout, clear};
}
export type Keystrokes = ReturnType<typeof useKeystrokes>;
