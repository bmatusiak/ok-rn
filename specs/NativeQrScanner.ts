/**
 * The camera QR scanner (onlykey-edge features/GUEST-BOOK-SPEC.md: "a small Kotlin TurboModule
 * using CameraX + ZXing ... the Password Manager's TOTP setup reuses it, so the app has one camera
 * module"). The Password Manager uses it first, for an authenticator's setup QR (otpauth://).
 *
 * scan(prompt) opens a full-screen camera (QrScanActivity) and resolves with the first QR code's
 * text, or null when the person backs out. The CAMERA permission is asked only then, when Scan is
 * pressed; refused -> rejects with PERMISSION. On a release build the screen blocks screenshots (a setup QR is a secret).
 */
import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

export interface Spec extends TurboModule {
  scan(prompt: string): Promise<string | null>;
  /**
   * Draws a QR code of `text`, `size` pixels square, as a PNG data URI: error correction H with
   * the OnlyKey logo in the middle, read back natively - if the logo made it unreadable, the plain
   * code comes back instead. Rejects TOO_BIG when the text does not fit one QR code (Guest Book's
   * My card offers Share / Copy then).
   */
  render(text: string, size: number): Promise<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeQrScanner');
