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
 *
 * PRE-3.0.5 ONLY. See the note on setTouchFreeDerive().
 */
const DERIVE_WITHOUT_TOUCH = 8;

/**
 * The 3.0.5 spelling: an ENUM in field 30, not a bit in field 21.
 *
 * Two things changed at once and the old value fails on both counts.
 *
 *   THE ENCODING. Fields 21, 22 and 30 became a 0/1/2 enum - 0 = challenge
 *   code, 1 = button press, 2 = no press - and set_slot() refuses anything
 *   above 2 with "Error invalid user input mode". So 8 is not "a bit that
 *   stopped working", it is rejected outright, and the preference never
 *   arrives.
 *
 *   THE FIELD. Even a correctly encoded 2 in field 21 would not change this
 *   gate: okcore_user_input_mode_for_slot() routes slot 128 - the web-and-agent
 *   derivation key - straight to field 30, and web_agent_derive_gate() calls
 *   okcore_web_agent_derive_mode() directly. Field 21 is the RAW-HID derived
 *   key. (The maintainer's own GUI tests write 21 here; on the slot-128 path
 *   that is the wrong byte.)
 *
 * What it cost: the write was refused, the gate stayed at its default of
 * "button press", and every SHARED-SECRET derive answered
 * CTAP2_ERR_OPERATION_DENIED while every PUBLIC-KEY derive passed - because
 * public-key derives are never gated. Five failures that looked like a firmware
 * regression and were a host-side encoding.
 */
const USER_INPUT_CHALLENGE = 0;
const USER_INPUT_PRESS = 1;
const USER_INPUT_NONE = 2;

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
  /*
   * WHICH FIELD IS A CAPABILITY QUESTION, so both firmware lines keep working.
   * Before 3.0.5 the only knob is field 21's bit 3; from 3.0.5 it is field 30's
   * enum, and field 21 no longer reaches the derive gate at all.
   */
  const modern = device.capabilities && device.capabilities.deriveReqPress === false;

  if (!modern) {
    const legacy = await device.setPreference('derivedChallengeMode', DERIVE_WITHOUT_TOUCH);
    log(`derived key challenge mode (legacy bit): ${JSON.stringify(legacy.response ?? legacy)}`);
    return legacy;
  }

  /*
   * "No press" is not universally available: a build without OK_ALLOW_NO_PRESS
   * refuses it with "unsupported user input mode", and the firmware notes that
   * a stale 2 already in EEPROM fails CLOSED to the challenge code. So the
   * refusal is reported rather than swallowed - a caller that assumed the write
   * took would go on to blame the derive.
   */
  const result = await device.setPreference('webAgentDeriveMode', USER_INPUT_NONE);
  const text = String(result.response ?? result);
  log(`web and agent derived key mode: ${JSON.stringify(text)}`);
  if (/unsupported user input mode/i.test(text)) {
    log('  this build has no OK_ALLOW_NO_PRESS, so derives will want a confirmation');
  }
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
/**
 * Take the device into config mode, run `work` there, and restart out of it.
 *
 * EXTRACTED, because config mode is a ceremony with four separate traps in it
 * and a second copy would get at least one wrong. It is the whole of what
 * enableTouchFreeDerive() used to be, minus the one line that said what to do
 * once inside - so anything else needing config mode (writing a backup
 * passphrase, for one: OKSETPRIV is refused outside it unless the device has
 * never been initialised) gets the fade wait, the library's gesture, the
 * silent-unlock poll and the restart for free.
 *
 * @param device  the device service
 * @param pin     the PIN, pressed rather than sent - see below
 * @param log     the suite's log
 * @param work    async () => result, run while in config mode
 * @returns whatever `work` returned
 *
 * IT DOES NOT COME BACK OUT, and cannot. See the tail.
 */
async function inConfigMode(device, pin, log, work) {
  /*
   * CONFIG MODE IS AN APP STATE, and this is the first of three places that
   * says so out loud.
   *
   * The wire carries NO config-mode signal: the firmware logs CONFIG_MODE to a
   * debug console production builds do not have, and OKCONNECT answers
   * UNLOCKED from inside config mode exactly as it does outside
   * (okcore.cpp:1362-1367). So the state cannot be read back - only
   * remembered, by whoever performed the gesture. `device.inConfigMode` is
   * that memory, and everything downstream branches on it: okcrypto refuses a
   * derive up front rather than waiting out a timeout, and the Preferences
   * screen grays the Advanced group.
   *
   * Nothing asserted it, anywhere in the e2e, until now. A remembered state
   * that is never checked is a state that can drift without a single test
   * noticing.
   */
  if (device.inConfigMode) {
    throw new Error(
      'the app already believes this device is in config mode before the '
      + 'gesture. Config mode ends only at a restart, so either a previous '
      + 'suite left it there - and CTAPHID has been silent since - or the flag '
      + 'survived a restart it should have been cleared by.');
  }

  /*
   * AND IT MUST BE UNLOCKED FIRST, which is not the same requirement.
   *
   * enterConfigMode() proves the gesture landed by watching the device become
   * LOCKED - entering config mode locks it (OnlyKey.ino:914-926). That is
   * evidence ONLY if it was unlocked to begin with. Inside the sweep it always
   * is, because an earlier suite unlocked it; for a suite run ALONE the key is
   * locked from the start and "it is locked now" proves nothing whatever.
   *
   * Measured 2026-09-23 on the first `--only backupPassphrase` attempt: the
   * gesture was reported as landed on an already-locked key, the PIN went in,
   * and twenty seconds of polling never found a readable device - because it
   * was never in config mode, just locked.
   */
  const before = await device.connect();
  if (!/UNLOCKED/i.test(String(before.status))) {
    throw new Error(
      `this device is ${before.status}, and the config-mode gesture is proven `
      + 'by watching it LOCK - which proves nothing about a key that is locked '
      + 'already. Unlock before calling inConfigMode(); a suite run alone has '
      + 'to do that itself, since no predecessor did it.');
  }

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
   * THE APP STATE, not the device proxy. enterConfigMode() sets
   * session.configMode on success (plugins/device/index.js:1309) and
   * `inConfigMode` reads it. The lock above is the DEVICE's evidence; this is
   * the state the rest of the app will act on, and the two are set in
   * different places, so agreeing is a fact worth checking rather than
   * assuming.
   */
  if (!device.inConfigMode) {
    throw new Error(
      'the device locked, so the gesture landed, but the app does not believe '
      + 'it is in config mode - enterConfigMode() resolved without setting '
      + 'session.configMode, and every caller that branches on it is now wrong '
      + 'about this device.');
  }
  log('app state: inConfigMode = true');

  /*
   * JUST unlock(). THE LIBRARY ABSORBED THE HARD PART.
   *
   * This used to press the PIN and then poll readLabels by hand, under a
   * comment saying "Do not call device.unlock() here" - because unlocking
   * inside config mode IS NEVER ANNOUNCED (OnlyKey.ino:707, and
   * FINDING-config-mode-unlock-is-silent.md), so unlock() waiting on the
   * device's UNLOCKED broadcast could only ever time out saying the PIN might
   * be wrong. The PIN was fine; there was nothing to hear.
   *
   * That is no longer true. plugins/device/index.js:1135 does exactly this
   * poll INSIDE unlock(), gated on session.configMode, and resolves with a
   * bare `UNLOCKED` marker rather than a status line - "the app's Keys screen
   * already did exactly this, in its own copy. It belongs here, where every
   * GUI gets it rather than each one rediscovering it." This helper was the
   * third copy, and its comment had become false: following the instruction
   * not to call unlock() was, by then, the way to get the duplicate.
   *
   * The bare marker is also why session.observeStatus() tests `!seen.version`
   * rather than `=== null`: this unlock resolves with a version-less status by
   * design, and it must not erase the version the session already knows.
   */
  const said = await device.unlock(pin, {
    timeoutMs: 20000,
    enterDigits: pressDigits({log}),
  });
  log(`unlocked again, now in config mode (${said})`);

  const result = await work();

  /*
   * LEAVE CONFIG MODE, or nothing after this works.
   *
   * Config mode silences CTAPHID - the vendor interface still answers, so the
   * device looks healthy - and there is no message that ends it. The only way
   * out is a restart (okcore.cpp; the library's own derive() refuses up front
   * with "Config mode ends only at a restart" rather than waiting out a
   * timeout).
   *
   * This helper did not restart, and for a long time that went unnoticed
   * because its caller only reached it on firmware that named the preference in
   * its refusal - which 3.0.5 does not, so the helper was never running. The
   * moment it did, it set the preference correctly and then left the device
   * mute: every derive after it failed, INCLUDING ones that had just passed.
   * A fix that works and then breaks the six tests behind it is worse than the
   * failure it fixed, because it looks like a regression somewhere else.
   */
  /*
   * AND IT STAYS IN CONFIG MODE. There is no way out from here.
   *
   * This used to end with `await OkEmu.restart()`, which REJECTS
   * UNCONDITIONALLY: the firmware thread only exits through the AIRCR trap, so
   * NativeOkEmuModule refuses rather than pretending, and 1-softKey has a test
   * pinning that refusal. The line could never have done what it said.
   *
   * It survived because the only caller reached it solely when a derive asked
   * for confirmation, which 3.0.5 stops doing once field 30 is set - a dead
   * branch on current firmware. Extracting this function for the
   * backup-passphrase suite is what first executed it, and it threw
   * immediately (2026-09-23).
   *
   * The option to try it is gone rather than defaulted off, because a dead
   * branch that calls something guaranteed to throw is a trap wearing a
   * comment. What replaces it is the suite's own THREE-PASS shape: a run that
   * takes config mode IS the config-mode pass, the power cycle is the runner
   * force-stopping the app when that pass ends, and every caller defers its
   * verification to the next one.
   */
  log('still in config mode: CTAPHID stays silent until the app process '
      + 'restarts, which the runner does at the end of this pass');
  return result;
}

/**
 * The original caller, now one line: get into config mode and set the
 * preference. Kept by name because several suites import it.
 */
async function enableTouchFreeDerive(device, pin, log) {
  /*
   * THE CALLER MUST DEFER AFTER THIS. It does not come back out of config
   * mode, because nothing can: the in-place restart this used to attempt
   * rejects unconditionally (1-softKey pins that refusal), so the call could
   * never have done what its log line claimed. It went unnoticed because the
   * only caller reaches it solely when a derive asks for confirmation, which
   * 3.0.5 stops doing once field 30 is set - dead on current firmware, and
   * executing it at all is what exposed it (2026-09-23).
   *
   * The preference persists in EEPROM, so the pass after this one gets what
   * this pass set up. That is the three-pass shape, and 10-derive skips on
   * exactly that basis.
   */
  return inConfigMode(device, pin, log, () => setTouchFreeDerive(device, log));
}

module.exports = {
  setTouchFreeDerive,
  enableTouchFreeDerive,
  inConfigMode,
  DERIVE_WITHOUT_TOUCH,
  USER_INPUT_CHALLENGE,
  USER_INPUT_PRESS,
  USER_INPUT_NONE,
};
