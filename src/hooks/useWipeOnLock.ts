import {useEffect, useRef, useState} from 'react';
import {getOnlyKey} from '../onlykey';

/*
 * Everything the app learned while unlocked, forgotten when the key locks.
 *
 * The app holds a lot of plaintext now: a slot's password once it has been read
 * back, a derived per-site secret, whatever a vault blob opened into, and a
 * captured backup - which is the entire contents of the key. All of it arrived
 * because the device was unlocked, and none of it was being dropped when the
 * device stopped being unlocked. The screen went back to the PIN pad and the
 * secrets stayed in React state behind it, one unlock away from being on screen
 * again without anyone deriving anything.
 *
 * Two halves, because there are two places it lives:
 *
 *   the EPOCH remounts the screens, which is what drops component state. React
 *   has no way to ask a tree to forget; changing a `key` throws the tree away
 *   and builds a new one, and that is the only reliable way to be sure nothing
 *   was kept in a ref or a closure somewhere down the tree.
 *
 *   deviceVault.lockAll() drops the cached vault KEYS in the library, zeroing
 *   the bytes rather than dropping the reference. Those are not React state and
 *   would otherwise survive any number of remounts - they are cached precisely
 *   so they can outlive a screen.
 *
 * WHAT THIS DOES NOT DO is reach into the library's session key. plugins/session
 * is restricted to `device` and `okcrypto` (its `setup.allowed`), so the app
 * cannot reset it and should not be able to - that key is the transport's, not
 * the user's, and it is re-established by the next connect.
 */
export function useWipeOnLock(ready: boolean): number {
  const [epoch, setEpoch] = useState(0);

  /*
   * Only a TRANSITION out of ready counts. Without this the first render - when
   * ready is already false, because the app starts locked - would bump the
   * epoch and wipe a cache nobody had filled, and every unrelated re-render
   * while locked would do it again.
   */
  const wasReady = useRef(false);

  useEffect(() => {
    if (ready) {
      wasReady.current = true;
      return;
    }
    if (!wasReady.current) return;
    wasReady.current = false;

    setEpoch(n => n + 1);

    /*
     * Not awaited, and failure is not surfaced. This runs on the way to a
     * locked screen; there is nowhere to show an error and nothing the user
     * could do about it. The remount has already happened either way.
     */
    getOnlyKey()
      .then(({okcrypto}) => okcrypto.deviceVault.lockAll())
      .catch(() => {});
  }, [ready]);

  return epoch;
}
