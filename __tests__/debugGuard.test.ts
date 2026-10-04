/**
 * Spec rule 10, the app's lock: with debugging on, consent only for things marked TEST:.
 */
import NativeOkEmu from '../specs/NativeOkEmu';
import {consentRefusal, DEBUG_REFUSAL, isTestLabel, markTestConsent, testConsentActive} from '../src/debugGuard';

const debugging = (on: boolean) => (NativeOkEmu.debuggingOn as jest.Mock).mockReturnValue(on);

test('debugging off: every consent goes ahead, test or not', () => {
  debugging(false);
  expect(consentRefusal(false)).toBeNull();
  expect(consentRefusal(true)).toBeNull();
});

test('debugging on: a real consent is refused with "turn off debugging to approve this"; a TEST one goes ahead', () => {
  debugging(true);
  expect(consentRefusal(false)).toBe(DEBUG_REFUSAL);
  expect(DEBUG_REFUSAL).toMatch(/turn off debugging to approve this/);
  expect(consentRefusal(true)).toBeNull();
  debugging(false);
});

test('only a leading TEST: marks a test', () => {
  expect(isTestLabel('TEST: screenshot')).toBe(true);
  expect(isTestLabel('  TEST: padded')).toBe(true);
  expect(isTestLabel('Test B7 watcher')).toBe(false);
  expect(isTestLabel('Push the session\'s own work: TEST: not leading')).toBe(false);
  expect(isTestLabel(undefined)).toBe(false);
});

test('a test consent opens the Confirm panel for a minute, then closes', () => {
  jest.useFakeTimers();
  markTestConsent(60_000);
  expect(testConsentActive()).toBe(true);
  jest.advanceTimersByTime(61_000);
  expect(testConsentActive()).toBe(false);
  jest.useRealTimers();
});
