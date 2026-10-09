/**
 * SPEC RULE 10, ENFORCED IN THE APP (onlykey-edge build/scenarios.md, 2026-10-04):
 * "the agent never drives the approving device". On a soft key the phone IS the
 * key, so whatever can tap the phone can press. While USB or wireless debugging
 * is on, a computer can tap this phone - so ok-rn refuses to approve, press,
 * waive or accept loss for anything not marked as a test, and says why.
 *
 * The agent's own scripts check "TEST:" too; that is a seatbelt the agent
 * controls. This check is the lock: it lives on the approving device.
 *
 * Marked as a test: a request or budget whose identities are ALL on the phone's
 * test-identity list (below; testing mode only). A "TEST:" reason is only a label.
 * Hold is never refused - it only makes the key stricter.
 */
import NativeOkEmu from '../specs/NativeOkEmu';
import {buildInfo} from './buildInfo';

export const TEST_LABEL = /^TEST:/;
export const isTestLabel = (text: string | null | undefined) => TEST_LABEL.test(String(text ?? '').trim());

export const DEBUG_REFUSAL =
  'Debugging is on - turn off debugging to approve this. USB or wireless debugging lets a computer tap this phone, so nothing can be approved, pressed, waived or settled while it is on.';

/** USB or wireless debugging on. An APK without the call says no (it predates the rule). */
export function debuggingOn(): boolean {
  try {
    return NativeOkEmu.debuggingOn?.() === true;
  } catch {
    return false;
  }
}

/*
 * ONLY OUTSIDE TESTING MODE (Brad, 2026-10-04, rule 10 rewritten: "the Pixel is
 * yours, all test"). Testing mode exists only in debug builds - useTestingMode is
 * a no-op when __DEV__ is false, and setTestingMode below checks __DEV__ again -
 * so a production build (the A13) always has the full lock, and the Pixel in
 * testing mode may register, approve, press and mark test.
 * __tests__/debugGuard.test.ts proves a release build cannot turn it on.
 */
let testingMode = false;
export function setTestingMode(on: boolean): void {
  testingMode = __DEV__ && on;
}
export const testingModeOn = () => testingMode;

/**
 * THE ONE CHECK (Brad, 2026-10-05: "one shared check, not a per-sheet rule").
 * Every approve / press / waive / accept-loss / mark-test path in the app asks
 * this, with no argument: a budget, a registration, a place that keeps copies, a
 * sibling, a waive, a loss, the key's own Confirm panel. Nothing a path knows
 * about its request can loosen it - only testing mode does, and a production
 * build has none. __tests__/consentOneCheck.test.ts fails if a path asks
 * anything else. The refusal text, or null. Ask at render AND on the tap.
 */
export function consentRefusal(): string | null {
  /* a TEST build made with OKRN_DEBUG_LOCK=off has no lock - shown by a red banner, never in a pre-release (buildInfo.debugLock) */
  return !testingMode && buildInfo.debugLock && debuggingOn() ? DEBUG_REFUSAL : null;
}

