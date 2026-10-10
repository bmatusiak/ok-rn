/**
 * THE DEBUG LOCK (onlykey-edge DEVELOPMENT.md; 2026-10-04: "the agent never drives the approving
 * device"). On a soft key the phone IS the key, so whatever can tap the phone can press. While
 * USB or wireless debugging is on, a computer can tap this phone - so ok-rn refuses to approve,
 * press, settle or accept a loss, and says why. Two ways around it, both for development only:
 * testing mode (debug builds only), and a TEST build made with OKRN_DEBUG_LOCK=off, which shows a
 * red banner and never ships. Hold is never refused - it only makes the key stricter.
 */
import NativeOkEmu from '../specs/NativeOkEmu';
import {buildInfo} from './buildInfo';

export const TEST_LABEL = /^TEST:/;
export const isTestLabel = (text: string | null | undefined) => TEST_LABEL.test(String(text ?? '').trim());

export const DEBUG_REFUSAL =
  'Debugging is on - turn off debugging to approve this. USB or wireless debugging lets a computer tap this phone, so nothing can be approved, pressed or settled while it is on.';

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
 * so a production build always has the full lock, and the Pixel in testing mode
 * may approve and press.
 * __tests__/debugGuard.test.ts proves a release build cannot turn it on.
 */
let testingMode = false;
export function setTestingMode(on: boolean): void {
  testingMode = __DEV__ && on;
}
export const testingModeOn = () => testingMode;

/**
 * THE ONE CHECK (Brad, 2026-10-05: "one shared check, not a per-sheet rule").
 * Every approve / press / settle / accept-loss path in the app asks this, with no
 * argument: a budget, a merge of another device's log, a settle, a loss, the press sheet. Nothing a path knows
 * about its request can loosen it - only testing mode does, and a production
 * build has none. __tests__/consentOneCheck.test.ts fails if a path asks
 * anything else. The refusal text, or null. Ask at render AND on the tap.
 */
export function consentRefusal(): string | null {
  /* a TEST build made with OKRN_DEBUG_LOCK=off has no lock - shown by a red banner, never in a pre-release (buildInfo.debugLock) */
  return !testingMode && buildInfo.debugLock && debuggingOn() ? DEBUG_REFUSAL : null;
}

