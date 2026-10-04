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

export const TEST_LABEL = /^TEST:/;
export const isTestLabel = (text: string | null | undefined) => TEST_LABEL.test(String(text ?? '').trim());

export const DEBUG_REFUSAL =
  'Debugging is on - turn off debugging to approve this. USB or wireless debugging lets a computer tap this phone, so while it is on only budgets naming test identities (marked in the Agents drawer) can be approved, pressed, waived or settled.';

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
 * TEST IDENTITIES (rule 10, 2026-10-04): what makes a request a test is not its
 * reason text - the agent writes that - but the identities it names. Brad marks
 * test identities on this phone (Agents drawer), like "yours"; the CLI, agents
 * and imported files cannot set or clear the mark, and marking is itself refused
 * while debugging is on (or a script could mark the real identity). Kept here in
 * memory for the render-time checks; src/edgeAgents.ts loads and saves the list.
 */
let testIdentities = new Set<string>();
/*
 * TESTING MODE ONLY (Brad, 2026-10-04): "if i use this app to manage security
 * infrastructure... a testing panel should ALWAYS be under testing mode". Outside
 * testing mode the list does not exist as far as consent goes: with debugging on,
 * every approve / press / waive / accept loss is refused, no exceptions. A release
 * build cannot turn testing mode on (useTestingMode is a no-op outside __DEV__), so
 * a production phone never has test identities at all. App.tsx sets this.
 */
let testingMode = false;
export function setTestingMode(on: boolean): void {
  testingMode = on;
}
export function setTestIdentities(names: string[]): void {
  testIdentities = new Set(names.map(n => n.trim()).filter(Boolean));
}
export const isTestIdentity = (id: string | null | undefined) => testingMode && !!id && testIdentities.has(String(id).trim());
/** A request or a budget is a test only if it names identities and EVERY one is marked test. */
export function scopesAreTest(scopes: {identity?: string}[] | null | undefined): boolean {
  return !!scopes && scopes.length > 0 && scopes.every(sc => isTestIdentity(sc.identity));
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
