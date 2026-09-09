import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * Handing a file to another app.
 *
 * React Native's own `Share` sends TEXT — `ACTION_SEND` with `EXTRA_TEXT` — and
 * that is not what a backup wants. Drive, Files and every other storage target
 * treat shared text as something to paste into a note, not as a document to
 * save; what they accept is a `content://` URI naming an actual file.
 *
 * And a file:// URI cannot be used: sharing one has thrown
 * FileUriExposedException since Android 7. So the file is staged in the app's
 * cache and handed out through a FileProvider, which grants the receiving
 * activity read access to that one URI for the life of the share.
 */
export type PickedFile = {
  /**
   * False when the user backed out without choosing.
   *
   * Cancelling is not an error — it is the most common outcome of showing a
   * picker — so it comes back as a value rather than a rejection, and the
   * caller can tell it apart from a file that failed to open.
   */
  picked: boolean;
  /** The chosen file's display name. Empty when nothing was picked. */
  name: string;
  /** Its text. Empty when nothing was picked. */
  content: string;
};

export interface Spec extends TurboModule {
  /**
   * Write `content` to a file and offer it to another app.
   *
   * @param filename  what the receiving app should call it
   * @param content   the file's text
   * @param mimeType  e.g. 'text/plain'
   * @param title     the chooser's title
   * @returns whether a chooser was shown. False means there was nothing
   *   installed that could receive it, which is a real answer rather than an
   *   error - a device with no storage or mail app is a device that cannot be
   *   backed up this way, and the caller should say so.
   */
  shareFile(
    filename: string,
    content: string,
    mimeType: string,
    title: string,
  ): Promise<boolean>;

  /**
   * Delete everything previously staged for sharing.
   *
   * A backup left in the cache is a plaintext copy of the key's secrets sitting
   * in a directory other apps cannot read but the user's own file manager can
   * reach through the app's storage. Called when the screen is done with it.
   */
  clearShared(): Promise<number>;

  /**
   * Let the user choose a file, and read it.
   *
   * ACTION_OPEN_DOCUMENT rather than a path: an app cannot browse the
   * filesystem on modern Android, and the picker is the only way to reach a
   * file the user chose — including one in Drive, which the picker downloads on
   * demand. The content comes back as text because the one thing this app opens
   * is a backup, which is base64 and header lines.
   *
   * @param mimeType e.g. 'text/plain'. Advisory: a backup saved by another app
   *   may well be typed as something else, so the picker is told not to hide
   *   anything.
   */
  pickTextFile(mimeType: string): Promise<PickedFile>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeShare');
