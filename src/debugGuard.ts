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
 * Marked as a test: a budget request whose reason starts "TEST:", an agent whose
 * name starts "TEST:", debts and losses that belong only to such budgets. Hold is
 * never refused - it only makes the key stricter.
 */
import NativeOkEmu from '../specs/NativeOkEmu';

export const TEST_LABEL = /^TEST:/;
export const isTestLabel = (text: string | null | undefined) => TEST_LABEL.test(String(text ?? '').trim());

export const DEBUG_REFUSAL =
  'Debugging is on - turn off debugging to approve this. USB or wireless debugging lets a computer tap this phone, so only budgets marked TEST: can be approved, pressed, waived or settled while it is on.';

/** USB or wireless debugging on. An APK without the call says no (it predates the rule). */
export function debuggingOn(): boolean {
  try {
    return NativeOkEmu.debuggingOn?.() === true;
  } catch {
    return false;
  }
}

/** The refusal text, or null when this consent may go ahead. Ask at render AND on the tap. */
export function consentRefusal(isTest: boolean): string | null {
  return !isTest && debuggingOn() ? DEBUG_REFUSAL : null;
}

/*
 * The key's own Confirm panel cannot see what it is confirming. A test consent
 * (a TEST: budget approved, a test waive) marks itself here for a minute; the
 * panel lets an Edge press through while debugging is on only inside that window.
 */
let testConsentUntil = 0;
export function markTestConsent(ms = 60_000): void {
  testConsentUntil = Date.now() + ms;
}
export function testConsentActive(): boolean {
  return Date.now() < testConsentUntil;
}
