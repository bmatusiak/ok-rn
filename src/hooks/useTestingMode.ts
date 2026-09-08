import {useCallback, useState} from 'react';

/**
 * Testing mode: a real app mode, not a build flag.
 *
 * It does three things, and the third is why it is a mode rather than a
 * `__DEV__` check scattered around:
 *
 *   1. Bypasses login and PIN entry, so development does not need seven button
 *      taps every launch.
 *   2. Shows a banner, so it is never ambiguous that the gating is off.
 *   3. Reveals the developer surfaces - the E2E runner, USB HID, raw sends -
 *      which are hidden otherwise.
 *
 * DEFAULTS ON IN A DEBUG BUILD, and that is load-bearing: `npm run e2e:run`
 * drives the app from a terminal and cannot type a PIN, so a debug build that
 * demanded one would strand the suite at a login screen.
 *
 * Not persisted. React Native has no localStorage and this app has no storage
 * dependency; the choice lasts for the life of the process, which is enough
 * while the default is right for both builds. Persisting it means adding
 * AsyncStorage, and that is a decision to take on its own rather than in the
 * middle of a layout change.
 */
export function useTestingMode() {
  const [enabled, setEnabled] = useState<boolean>(__DEV__);

  const toggle = useCallback(() => setEnabled(prev => !prev), []);

  return {enabled, setEnabled, toggle};
}
