import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * Handling a secret once it is on screen.
 *
 * Two things that both need the Android side and that a JS-only implementation
 * gets quietly wrong.
 *
 * THE CLIPBOARD ANNOUNCES WHAT IT HOLDS. Since Android 13 the system shows a
 * preview chip of whatever was just copied, so copying a password flashes it
 * on screen even though the app never displayed it. `ClipDescription`'s
 * EXTRA_IS_SENSITIVE suppresses that - the chip reads "Copied" with the content
 * hidden - and there is no way to set it from JavaScript. React Native's own
 * (deprecated) Clipboard does not, and neither does the community package.
 *
 * AND IT KEEPS WHAT IT HOLDS. A password copied to paste into a browser stays
 * on the clipboard until something else replaces it, readable by any app the
 * user opens next. Clearing it after a timeout is the mitigation, and doing it
 * natively means the timer survives the JS bundle reloading.
 *
 * FLAG_SECURE is the third: it stops the screen appearing in screenshots, in
 * the recents thumbnail, and on non-secure external displays. It is a WINDOW
 * flag, so only the Activity can set it.
 */
export interface Spec extends TurboModule {
  /**
   * Copy text the system must not preview, and forget it afterwards.
   *
   * @param text
   * @param clearAfterMs  0 leaves it on the clipboard indefinitely.
   * @returns whether the sensitive flag was actually applied. FALSE on
   *   Android 12 and below, where the API does not exist and the preview chip
   *   does not either - so false means "not needed", not "failed". The caller
   *   shows it either way; pretending otherwise would be lying about what the
   *   platform did.
   */
  copySensitive(text: string, clearAfterMs: number): Promise<boolean>;

  /**
   * Clear the clipboard if it still holds what we put there.
   *
   * Checked rather than assumed: clearing unconditionally would delete
   * something the user copied from another app in the meantime, which is a
   * password manager stealing your clipboard rather than protecting it.
   */
  clearClipboard(): Promise<boolean>;

  /**
   * Block screenshots and recents previews of this window.
   *
   * Toggleable on purpose. It is the right default for a screen showing a
   * password, and it also blocks the adb screenshots this project's UI is
   * verified with - so a debug build needs to be able to turn it off.
   */
  setScreenshotsBlocked(blocked: boolean): Promise<void>;

  /** Whether FLAG_SECURE is currently set on the activity window. */
  screenshotsBlocked(): Promise<boolean>;

  /* ---- biometric-gated storage ---------------------------------------- */

  /**
   * Whether a biometric can be used at all, and if not, why.
   *
   *   'available'      a fingerprint or face is enrolled and usable
   *   'none-enrolled'  the hardware is there and nothing is registered
   *   'no-hardware'    this device has none
   *   'unavailable'    hardware present but temporarily unusable
   *
   * The REASON matters, not just the yes or no. "None enrolled" is fixable by
   * the person holding the phone and "no hardware" is not, and a screen that
   * says only "unavailable" sends someone to Settings for nothing.
   */
  biometricStatus(): Promise<string>;

  /**
   * Encrypt a secret under a key that only a biometric can use, and store it.
   *
   * The key lives in the Android Keystore with setUserAuthenticationRequired,
   * so the ciphertext is useless without the prompt - including to anything
   * that can read the app's files. The plaintext never touches AsyncStorage.
   *
   * Prompts, because using the key at all requires authentication. That is not
   * a formality: it confirms the person storing it is present.
   */
  biometricStore(
    alias: string,
    secret: string,
    title: string,
    subtitle: string,
  ): Promise<boolean>;

  /** Prompt, then decrypt. Rejects if the prompt is cancelled or fails. */
  biometricLoad(alias: string, title: string, subtitle: string): Promise<string>;

  /** Whether something is stored under this alias, WITHOUT prompting. */
  biometricHas(alias: string): Promise<boolean>;

  /** Forget it, and destroy the key that opened it. */
  biometricForget(alias: string): Promise<boolean>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeSecrets');
