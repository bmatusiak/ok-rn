import {useEffect, useState} from 'react';
import {useActiveKey} from './KeyContext';

/**
 * Whether the ACTIVE key is in config mode, read from the library.
 *
 * The app used to keep its own `configMode` boolean in App.tsx and thread it
 * through six screens with a `setConfigMode` beside it. Anything could write
 * it, and one thing wrote it wrongly: the Enter button set it the moment it
 * was tapped, so on a production hard key - which the app cannot press at all
 * - the whole app believed a key was in config mode that nobody had touched.
 * Reported 2026-09-19.
 *
 * `session.configMode` cannot do that. The library writes it in three places
 * and no more: true at device/index.js:1252, which is INSIDE the branch where
 * a label read came back refused - the key locked, and the lock is the only
 * proof config mode exists, because nothing on the wire reports it - and false
 * in restart() and wipeUserspace(). It also dies with the session, so pulling
 * a hard key clears it without anybody remembering to.
 *
 * ## Why this polls
 *
 * `inConfigMode` is a getter over a plain variable, not an event source, and
 * React cannot see a variable change. So the answer is fetched on a timer.
 *
 * It costs nothing: no I/O, no frame on any interface - which matters, because
 * the one thing this must not do is talk to the key. A repeated vendor read
 * while somebody is entering a PIN interferes with the digits going in, which
 * is why the label probe is a button and never a poll. This is only a property
 * read, so it can be as often as it likes.
 */
export function useInConfigMode(): boolean {
  const getKey = useActiveKey();
  const [on, setOn] = useState(false);

  useEffect(() => {
    let stopped = false;
    const read = async () => {
      try {
        const {device} = await getKey();
        if (!stopped) setOn(device.inConfigMode === true);
      } catch {
        /* No key yet - and no key is not in config mode. */
        if (!stopped) setOn(false);
      }
    };
    const timer = setInterval(read, 500);
    read().catch(() => {});
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [getKey]);

  return on;
}
