import {useCallback, useEffect, useRef, useState} from 'react';

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

/**
 * How often the screen is allowed to change because of the log.
 *
 * THE SCREEN HAS TO GO QUIET SOMETIMES. A hard key's once-a-second broadcast
 * is five reports in a burst, and rendering each as it arrived changed the
 * Traffic panel's text five times a second, forever. Android's uiautomator -
 * what tools/e2e.js reads the screen with, and what an accessibility service
 * is built on - waits for a second of no content changes before it will
 * describe a window, and gave up every time: "could not get idle state". The
 * runner then read a dump from BEFORE its last tap and drove a screen that was
 * no longer there. See FINDING-uiautomator-cannot-dump-a-screen-that-never-idles.md.
 *
 * So arrivals are queued and applied together, at most this often. Longer
 * than the second uiautomator needs, with room for the render itself; short
 * enough that a line still appears while the thing that caused it is on your
 * mind. Nobody can read five updates a second anyway.
 */
const FLUSH_INTERVAL_MS = 2500;

type Arrival = {level: LogLevel; text: string; now: number};

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

  const pending = useRef<Arrival[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    const batch = pending.current;
    pending.current = [];
    if (!batch.length) {
      return;
    }

    setEntries(prev => {
      let next = prev;
      for (const {level, text, now} of batch) {
        next = apply(next, level, text, now, seenAt.current, nextId);
      }
      return next;
    });
  }, []);

  const log = useCallback(
    (level: LogLevel, text: string) => {
      /* Stamped on arrival, not on flush, so a merged line's time is honest. */
      pending.current.push({level, text, now: Date.now()});
      if (timer.current === null) {
        timer.current = setTimeout(flush, FLUSH_INTERVAL_MS);
      }
    },
    [flush],
  );

  const clear = useCallback(() => {
    pending.current = [];
    seenAt.current.clear();
    setEntries([]);
  }, []);

  /* A flush after unmount would set state on nothing. */
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  return {entries, log, clear};
}

/** One arrival into the list: merged into a recent identical row, or added. */
function apply(
  prev: LogEntry[],
  level: LogLevel,
  text: string,
  now: number,
  seenAt: Map<number, number>,
  nextId: {current: number},
): LogEntry[] {
  /*
   * Scan from the newest and stop at the first row older than the window.
   * The list is newest-first, so that bounds the work at however many
   * lines arrived in the last three seconds - a couple of dozen at worst -
   * rather than the whole 200.
   */
  for (let i = 0; i < prev.length; i++) {
    const at = seenAt.get(prev[i].id) ?? 0;
    if (now - at > REPEAT_WINDOW_MS) {
      break;
    }
    if (prev[i].level === level && prev[i].text === text) {
      seenAt.set(prev[i].id, now);
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
  seenAt.set(entry.id, now);

  const next = [entry, ...prev];
  if (next.length > MAX_ENTRIES) {
    for (const dropped of next.slice(MAX_ENTRIES)) {
      seenAt.delete(dropped.id);
    }
    return next.slice(0, MAX_ENTRIES);
  }
  return next;
}
