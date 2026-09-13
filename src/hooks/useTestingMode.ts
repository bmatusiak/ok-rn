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
 * DEFAULTS OFF, in every build. It used to default to `__DEV__`, which meant
 * a debug build opened with the PIN bypassed and the screenshot block down -
 * so the app a developer looks at all day was never the app anyone ships, and
 * the door could not be examined without first turning something off.
 *
 * `npm run e2e:run` was the reason for the old default: it drives the app from
 * a terminal and cannot type a PIN, so with the gate up it would stall at the
 * login screen. It now turns the mode on for itself - LoginScreen carries a
 * `__DEV__`-only way in, and tools/e2e.js taps it before opening the drawer.
 * An explicit step in the runner, rather than a default that changed what
 * every debug launch looked like.
 *
 * NOT PERSISTED, and now by choice rather than by necessity. This used to say
 * the app had no storage dependency, which stopped being true when AsyncStorage
 * arrived for the vault (src/onlykey.ts wires it to the host plugin).
 *
 * It stays unpersisted because remembering it is the wrong behaviour: testing
 * mode bypasses the PIN and turns off the screenshot block, and a setting like
 * that surviving a relaunch is a setting someone forgets is on. Every launch
 * starts with the gate up.
 */
export function useTestingMode() {
  const [enabled, setEnabled] = useState<boolean>(false);

  const toggle = useCallback(() => setEnabled(prev => !prev), []);

  return {enabled, setEnabled, toggle};
}
