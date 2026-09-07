import {useCallback, useRef, useState} from 'react';

export type LogLevel = 'info' | 'tx' | 'rx' | 'error';

export type LogEntry = {
  id: number;
  at: string;
  level: LogLevel;
  text: string;
};

const MAX_ENTRIES = 200;

/** Bounded, newest-first log buffer shared by both screens. */
export function useLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const nextId = useRef(0);

  const log = useCallback((level: LogLevel, text: string) => {
    const entry: LogEntry = {
      id: nextId.current++,
      at: new Date().toLocaleTimeString(),
      level,
      text,
    };
    setEntries(prev => [entry, ...prev].slice(0, MAX_ENTRIES));
  }, []);

  const clear = useCallback(() => setEntries([]), []);

  return {entries, log, clear};
}
