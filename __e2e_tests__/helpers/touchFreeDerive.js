/**
 * "Derived keys per site without touch" - the preference the vault needs.
 *
 * The vault derives its public key WITHOUT a press and its shared secret WITH
 * one, because that is what the web app does and the pairing decides the key.
 * The press flag is an INPUT to the derivation, not a permission check in front
 * of one - see FINDING-the-press-flag-changes-the-derived-key.md. So the
 * touch-free half is not optional, and retrying it with a touch would derive a
 * different key and seal blobs nothing else can open.
 *
 * Without bit 3 of `derived_key_challenge_mode` the firmware refuses that half
 * as CTAP2_ERR_EXTENSION_NOT_SUPPORTED, which names the wrong cause entirely.
 * onlykey-testing sets the same bit before its password-generator test.
 *
 * ## Why this is two functions
 *
 * okcore.cpp:2013 gates field 21 on `configmode == true || !initcheck`, so the
 * preference cannot be set on a plain unlocked device. Reaching config mode is
 * an 80-tick hold on button 6, and that hold ALSO LOCKS the device, so the PIN
 * has to go back in afterwards.
 *
 * 9-cryptoSign already pays that cost for its own reasons and runs before the
 * derive suite, so it calls `setTouchFreeDerive` while it is already there -
 * one gesture, two purposes, and the byte persists in EEPROM afterwards.
 * `enableTouchFreeDerive` is the standalone version for a caller that is not
 * already in config mode.
 *
 * The setting takes effect immediately: ok_extension.cpp:261 reloads the byte
 * from EEPROM at the check rather than trusting the RAM cache, and explains in
 * a comment why. No restart is needed, which is fortunate - an in-process one
 * is not implemented.
 */
'use strict';

const OkEmuModule = require('../../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;
const {pressDigits} = require('./pressDigits');

/**
 * Bit 3 of derived_key_challenge_mode - a BITMASK, not a flag.
 *
 * The library models this as a preference and its table says why the value is 8
 * rather than 1: bit 0 makes raw-HID derives raise a three-button challenge,
 * bit 3 is the one that allows a FIDO2 derive without a touch.
 */
const DERIVE_WITHOUT_TOUCH = 8;

const delay = ms => new Promise(r => setTimeout(r, ms));

/**
 * Set the preference. THE DEVICE MUST ALREADY BE IN CONFIG MODE.
 *
 * setPreference, not setSlot: these are device-global and go to
 * slots.GLOBAL_SLOT, while setSlot plans its writes from SLOT_FIELDS, which
 * does not contain the preferences - it would have returned an empty plan and
 * reported success without sending anything.
 */
async function setTouchFreeDerive(device, log) {
  const result = await device.setPreference('derivedChallengeMode', DERIVE_WITHOUT_TOUCH);
  log(`derived key challenge mode: ${JSON.stringify(result.response ?? result)}`);
  return result;
}

/**
 * The same thing, entering config mode first, for a caller that is not in it.
 *
 * ## The wait is not padding
 *
 * The gesture is `duration >= 72 && button_selected == '6' && !isfade`
 * (OnlyKey.ino:914). That last clause is the one that bites: after any press
 * the LED is fading, and while it fades the gesture branch is SKIPPED - the
 * hold falls through and is handled as an ordinary long press, which types the
 * slot's contents at the keyboard.
 *
 * Measured, not guessed. Running this straight after a derive produced five
 * 0x61 bytes in the key buffer ("aaaaa", a slot's password) and no lock at all,
 * so the unlock that follows sat waiting twenty seconds for an UNLOCKED
 * transition from a device that had never locked.
 */
async function enableTouchFreeDerive(device, pin, log) {
  /*
   * Long enough for the fade to finish. The same figure the derive suite waits
   * for pending_operation, and for a related reason - the firmware holds
   * post-ceremony state for about twenty seconds.
   */
  log('waiting for the LED fade to end, or the gesture is read as a long press');
  await delay(22000);

  /*
   * THE SEQUENCE IS THE LIBRARY'S. device.enterConfigMode() owns the gesture,
   * the retry and the lock-as-proof; this file used to carry its own copy of
   * all three, which is exactly the duplication that let the DUO's different
   * gesture go unnoticed until a DUO was emulated.
   *
   * Three attempts here, not the one a person gets: nobody is watching a suite,
   * and the window that swallows a hold is transient.
   */
  const off = device.on('progress', e => {
    if (e.step === 'configMode') {
      log(`config mode: ${e.attempt ? `attempt ${e.attempt} ` : ''}${e.button ? `button ${e.button} for ${e.ticks} ticks` : ''}`);
    }
  });

  try {
    await device.enterConfigMode({
      hold: (button, ticks) => OkEmu.holdTicks(button, ticks, {allowGesture: true}),
      settle: delay,
      attempts: 3,
    });
  } finally {
    off();
  }
  log('device locked, so the gesture landed');

  /*
   * PRESS THE PIN, THEN POLL. Do not call device.unlock() here.
   *
   * Entering config mode locks the device (OnlyKey.ino:914-926), and unlocking
   * WHILE IN IT IS NEVER ANNOUNCED (OnlyKey.ino:707) - see
   * FINDING-config-mode-unlock-is-silent.md. unlock() resolves on the device's
   * own UNLOCKED broadcast, so here it can only ever time out, and it does so
   * saying the PIN may be wrong. The PIN is fine; there is no announcement to
   * hear. The app's useConfigMode hook already polls for exactly this reason.
   *
   * readLabels is the probe: it works unlocked and is refused while locked, so
   * a successful read is the evidence the broadcast never gives.
   */
  await pressDigits({log})(pin);

  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      await device.readLabels({timeoutMs: 2500});
      break;
    } catch (e) {
      if (Date.now() > deadline) {
        throw new Error(
          'the PIN was entered but the device never became readable in config ' +
          `mode: ${String(e && e.message)}`,
        );
      }
      await delay(1500);
    }
  }
  log('unlocked again, now in config mode');

  return setTouchFreeDerive(device, log);
}

module.exports = {
  setTouchFreeDerive,
  enableTouchFreeDerive,
  DERIVE_WITHOUT_TOUCH,
};
