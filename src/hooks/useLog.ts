import {useCallback, useRef, useState} from 'react';

export type LogLevel = 'info' | 'tx' | 'rx' | 'error';

export type LogEntry = {
  id: number;
  at: string;
  level: LogLevel;
  text: string;
  /** How many times this line has arrived. 1 unless it is repeating. */
  count: number;
};

const MAX_ENTRIES = 200;

/**
 * How long a line stays open to being repeated rather than re-listed.
 *
 * A LOCKED DEVICE NEVER STOPS TALKING. It broadcasts its status once a second,
 * and the emulator prints the whole exchange - "INITIALIZED", the vendor report
 * in hex, two byteprints of the buffer, "Sending transport response data" -
 * about eight lines every second, forever.
 *
 * Without this, Clear appeared not to work: the list emptied and was full again
 * within five seconds, which looks exactly like the old contents coming back.
 * With it, that traffic settles into the same handful of rows with their counts
 * ticking up, so a cleared log stays legible and a NEW line is visible as one.
 *
 * Three seconds because the broadcast cycle is one; anything shorter and the
 * cycle outruns the window, anything much longer starts merging events that
 * are genuinely separate - two button presses, say.
 */
const REPEAT_WINDOW_MS = 3000;

/** Bounded, newest-first log buffer shared by the screens. */
export function useLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const nextId = useRef(0);
  /*
   * Arrival times live here rather than on the entry, because they are only
   * ever consulted while deciding whether to merge - putting them on the entry
   * would make every row re-render when nothing it displays had changed.
   */
  const seenAt = useRef(new Map<number, number>());

  const log = useCallback((level: LogLevel, text: string) => {
    const now = Date.now();

    setEntries(prev => {
      /*
       * Scan from the newest and stop at the first row older than the window.
       * The list is newest-first, so that bounds the work at however many
       * lines arrived in the last three seconds - a couple of dozen at worst -
       * rather than the whole 200.
       */
      for (let i = 0; i < prev.length; i++) {
        const at = seenAt.current.get(prev[i].id) ?? 0;
        if (now - at > REPEAT_WINDOW_MS) {
          break;
        }
        if (prev[i].level === level && prev[i].text === text) {
          seenAt.current.set(prev[i].id, now);
          const merged = prev.slice();
          merged[i] = {
            ...prev[i],
            at: new Date(now).toLocaleTimeString(),
            count: prev[i].count + 1,
          };
          return merged;
        }
      }

      const entry: LogEntry = {
        id: nextId.current++,
        at: new Date(now).toLocaleTimeString(),
        level,
        text,
        count: 1,
      };
      seenAt.current.set(entry.id, now);

      const next = [entry, ...prev];
      if (next.length > MAX_ENTRIES) {
        for (const dropped of next.slice(MAX_ENTRIES)) {
          seenAt.current.delete(dropped.id);
        }
        return next.slice(0, MAX_ENTRIES);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    seenAt.current.clear();
    setEntries([]);
  }, []);

  return {entries, log, clear};
}
