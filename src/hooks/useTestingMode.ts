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
 * NOT PERSISTED, and now by choice rather than by necessity. This used to say
 * the app had no storage dependency, which stopped being true when AsyncStorage
 * arrived for the vault (src/onlykey.ts wires it to the host plugin).
 *
 * It stays unpersisted because remembering it is the wrong behaviour: testing
 * mode bypasses the PIN and turns off the screenshot block, and a setting like
 * that surviving a relaunch is a setting someone forgets is on. The default is
 * already right for both builds - on in debug, off in release - so there is
 * nothing worth carrying across a restart.
 */
export function useTestingMode() {
  const [enabled, setEnabled] = useState<boolean>(__DEV__);

  const toggle = useCallback(() => setEnabled(prev => !prev), []);

  return {enabled, setEnabled, toggle};
}
