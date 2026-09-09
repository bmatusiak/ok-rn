import {useEffect} from 'react';
import NativeSecrets from '../../specs/NativeSecrets';

/*
 * Keep a screen out of screenshots and the recents preview while it is showing
 * a secret.
 *
 * FLAG_SECURE is a WINDOW flag, not a view one, so this is necessarily global
 * to the app while it is set - there is no way to protect one component. That
 * is why it is applied on mount and cleared on unmount rather than left on:
 * the whole app being unscreenshottable forever is a worse default than the
 * one screen that needs it saying so.
 *
 * TOGGLEABLE ON PURPOSE. The same flag that stops a shoulder-surfer's photo
 * also blanks the adb screenshots this project's UI is verified with, so a
 * build that could not turn it off would be a build whose UI could not be
 * checked. `enabled` is threaded from the app's testing mode.
 */
export function useSecureScreen(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return undefined;

    NativeSecrets.setScreenshotsBlocked(true).catch(() => {
      /*
       * Swallowed deliberately. The only way this fails is the activity being
       * gone, which means there is no window to protect and nothing useful to
       * tell anyone - and a screen that refused to render because it could not
       * set a window flag would be worse than one that renders unprotected.
       * The caller shows whether it took, via screenshotsBlocked().
       */
    });

    return () => {
      NativeSecrets.setScreenshotsBlocked(false).catch(() => {});
    };
  }, [enabled]);
}
