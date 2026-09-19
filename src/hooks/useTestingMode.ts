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
/**
 * IT CANNOT BE TURNED ON IN A RELEASE BUILD, and that is enforced HERE.
 *
 * The UI gates were not enough, and the reason is worth keeping: LoginScreen's
 * way in was correctly wrapped in `__DEV__`, and the drawer's footer button was
 * not - so a production apk shipped with "Enter testing mode" one tap inside
 * the menu. In an app whose whole job is a PIN, that is a shipped PIN bypass,
 * a factory reset and the raw USB surface, behind no gate at all.
 *
 * Two call sites, one of them remembered. So the invariant belongs in the mode
 * itself rather than in whoever renders a button for it: a third entry point
 * added later cannot reintroduce this, because there is nothing to turn on.
 *
 * `__DEV__` is statically false in a release bundle, so the branch below is
 * dead code the minifier removes - the capability is not merely hidden, it is
 * not built.
 */
const AVAILABLE = __DEV__;

export function useTestingMode() {
  const [enabled, setEnabled] = useState<boolean>(false);

  const toggle = useCallback(() => {
    if (!AVAILABLE) return;
    setEnabled(prev => !prev);
  }, []);

  const set = useCallback((next: boolean) => {
    if (!AVAILABLE) return;
    setEnabled(next);
  }, []);

  return {
    enabled: AVAILABLE && enabled,
    setEnabled: set,
    toggle,
    /** Whether to offer a way in at all. False in every release build. */
    available: AVAILABLE,
  };
}
