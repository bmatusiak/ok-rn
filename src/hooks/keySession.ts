/**
 * The vocabulary both keys share.
 *
 * Extracted so `useOkEmu` and `useHardKey` mean the same thing by the same
 * words rather than each defining its own copy. Two enums that drift by one
 * value is the kind of thing that produces a screen showing "running" over a
 * device that is not.
 */

/**
 * What the DEVICE says about itself, which is not what the transport says.
 *
 * Two different questions, and a screen needs both: the soft key's firmware can
 * be running perfectly while the device is locked and refuses everything, and a
 * hard key can be plugged in and claimed while sitting behind a PIN.
 */
/** 'bootloader' is a hard key that took a firmware-update kick and is waiting for blocks. */
export type DeviceState = 'unknown' | 'uninitialized' | 'locked' | 'unlocked' | 'bootloader';

/**
 * What the TRANSPORT is doing.
 *
 * The names are the soft key's, because it had them first, and they carry over
 * with only the cause changing:
 *
 *   unavailable  the soft key's native library is missing for this ABI;
 *                for a hard key, no key is attached
 *   stopped      not open
 *   starting     opening - booting firmware, or claiming interfaces
 *   running      open
 *   halted       the soft key's firmware thread exited. A hard key cannot halt
 *                without also disconnecting, so it never reports this
 *   error        it said why
 */
export type KeyState =
  | 'unavailable'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'halted'
  | 'error';

/** Which key a screen is looking at. Never both at once. */
export type Backend = 'embedded' | 'usb';

/** For anything that has to name it to a person. */
export const BACKEND_NAME: Record<Backend, string> = {
  embedded: 'Soft Key',
  usb: 'Hard Key',
};
