/**
 * Spec rule 10, the app's lock: with debugging on, no consent outside testing mode.
 */
import NativeOkEmu from '../specs/NativeOkEmu';
import {consentRefusal, DEBUG_REFUSAL, isTestLabel} from '../src/debugGuard';

const debugging = (on: boolean) => (NativeOkEmu.debuggingOn as jest.Mock).mockReturnValue(on);

test('debugging off: every consent goes ahead', () => {
  debugging(false);
  expect(consentRefusal()).toBeNull();
});

test('debugging on, outside testing mode: every consent is refused with "turn off debugging to approve this"', () => {
  debugging(true);
  expect(consentRefusal()).toBe(DEBUG_REFUSAL);
  expect(DEBUG_REFUSAL).toMatch(/turn off debugging to approve this/);
  debugging(false);
});

test('only a leading TEST: marks a test', () => {
  expect(isTestLabel('TEST: screenshot')).toBe(true);
  expect(isTestLabel('  TEST: padded')).toBe(true);
  expect(isTestLabel('Test B7 watcher')).toBe(false);
  expect(isTestLabel('Push the session\'s own work: TEST: not leading')).toBe(false);
  expect(isTestLabel(undefined)).toBe(false);
});

test('a request is a test only if EVERY identity it names is marked test on the phone - not by its reason', () => {
  const {setTestIdentities, scopesAreTest, setTestingMode} = require('../src/debugGuard');
  setTestIdentities(['ssh://test@nitro16']);
  setTestingMode(false); /* outside testing mode the list does not count at all */
  expect(scopesAreTest([{identity: 'ssh://test@nitro16'}])).toBe(false);
  setTestingMode(true);
  expect(scopesAreTest([{identity: 'ssh://test@nitro16'}])).toBe(true);
  expect(scopesAreTest([{identity: 'ssh://claude@nitro16'}])).toBe(false); /* a "TEST:" reason changes nothing */
  expect(scopesAreTest([{identity: 'ssh://test@nitro16'}, {identity: 'ssh://claude@nitro16'}])).toBe(false);
  expect(scopesAreTest([{}])).toBe(false); /* a slot scope names no identity */
  expect(scopesAreTest([])).toBe(false);
  setTestIdentities([]);
  expect(scopesAreTest([{identity: 'ssh://test@nitro16'}])).toBe(false);
  setTestingMode(false);
});

/*
 * Option 1 (Brad, 2026-10-04): the lock applies only outside testing mode, and
 * testing mode exists only in debug builds. These prove a RELEASE build (__DEV__
 * false) can neither turn testing mode on nor open the lock with it.
 */
test('debug build in testing mode: debugging on, the lock lets every consent through', () => {
  const g = require('../src/debugGuard');
  debugging(true);
  g.setTestingMode(true);
  expect(g.consentRefusal()).toBeNull();
  g.setTestingMode(false);
  expect(g.consentRefusal()).toBe(g.DEBUG_REFUSAL);
  debugging(false);
});

test('release build: setTestingMode(true) does nothing - the lock stays on with debugging on', () => {
  const was = (globalThis as any).__DEV__;
  (globalThis as any).__DEV__ = false;
  try {
    jest.isolateModules(() => {
      const NativeOkEmuR = require('../specs/NativeOkEmu').default;
      (NativeOkEmuR.debuggingOn as jest.Mock).mockReturnValue(true);
      const g = require('../src/debugGuard');
      g.setTestingMode(true);
      expect(g.testingModeOn()).toBe(false);
      expect(g.consentRefusal()).toBe(g.DEBUG_REFUSAL);
    });
  } finally {
    (globalThis as any).__DEV__ = was;
  }
});

test('release build: useTestingMode cannot be switched on - not by setEnabled, not by toggle', () => {
  const was = (globalThis as any).__DEV__;
  (globalThis as any).__DEV__ = false;
  try {
    jest.isolateModules(() => {
      const React = require('react');
      const TestRenderer = require('react-test-renderer');
      const {useTestingMode} = require('../src/hooks/useTestingMode');
      let t: any;
      const Probe = () => { t = useTestingMode(); return null; };
      TestRenderer.act(() => { TestRenderer.create(React.createElement(Probe)); });
      expect(t.available).toBe(false);
      TestRenderer.act(() => t.setEnabled(true));
      expect(t.enabled).toBe(false);
      TestRenderer.act(() => t.toggle());
      expect(t.enabled).toBe(false);
    });
  } finally {
    (globalThis as any).__DEV__ = was;
  }
});
