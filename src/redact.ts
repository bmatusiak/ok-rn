/**
 * What a log line is allowed to say about a secret.
 *
 * ## The rule
 *
 * A RELEASE LOGS WHAT IS HAPPENING. A DEBUG BUILD MAY LOG WHAT WAS SENT.
 *
 * Taken from the OnlyKey desktop app, which has had this right all along.
 * `OnlyKey-App/app/scripts/onlyKey/OnlyKeyComm.js:517-520`:
 *
 *     OnlyKey.prototype.sendPinMessage = function ({ msgId="", pin="", … }) {
 *       console.info(`sendPinMessage ${msgId}`);
 *
 * The PIN is right there in the signature and it logs the MESSAGE NAME. Every
 * other line in that file is the same shape - "Flushing pending ${msgId}",
 * "PIN attempts exceeded", "Incorrect PIN attempt". Events and outcomes, never
 * payloads.
 *
 * ## Why this app needed it
 *
 * The Log tab ships in every release - `App.tsx` puts 'Log' in the base TABS
 * and only gates the Testing tab on __DEV__ - and it was printing the unlock
 * PIN into it in cleartext, as `buttons 1 2 3 4 5 6 7`, seconds after the PIN
 * was entered, two taps from the unlock screen. The line that printed it whole
 * was the BIOMETRIC unlock, which is exactly the path that holds the complete
 * PIN. The tab is not even screenshot-blocked, while Backup and Crypto are.
 *
 * ## Why at the source and not at the renderer
 *
 * A secret must never ENTER the ring buffer. Filtering on render, or on level,
 * leaves it sitting in memory where a screenshot, a future log export, or a
 * crash reporter can still reach it. By the time it is a `LogEntry` it is too
 * late to be careful.
 *
 * ## Why __DEV__ and not testing mode
 *
 * Same reason `BLOCK_SCREENSHOTS` uses it: `__DEV__` is a property of the BUILD
 * and Metro folds the dead branch out of a release bundle, so the format string
 * is not merely unreachable - it is absent. Testing mode is a runtime flag
 * somebody can turn on, which is not a boundary to put a PIN behind.
 */

/**
 * The value when debugging, a description of it otherwise.
 *
 * @param value what to say in a debug build - the actual digits, the hex
 * @param shape what to say in a release - a count, a length, a name
 *
 * Callers read the same either way, so the choice is made once, here, rather
 * than as an `if` at every log site where it could be forgotten.
 */
export function secret(value: string, shape: string): string {
  return __DEV__ ? value : shape;
}

/**
 * Bytes as hex when debugging, and nothing about them otherwise.
 *
 * NOT THE LENGTH EITHER. A SEREMU frame is exactly the PIN plus a newline -
 * `pressLine` in node-onlykey-lib writes `${digits}
` as one frame - so
 * "SEREMU 8 bytes" states that the PIN has seven digits. The frames that are
 * a fixed 64 bytes tell an operator nothing by their length anyway, and the
 * frames whose length varies are the ones carrying the secret, so printing
 * the length can only ever leak. The line already carries the direction and
 * the interface, which is the event.
 */
export function secretBytes(hex: string): string {
  return __DEV__ ? hex : 'frame';
}
