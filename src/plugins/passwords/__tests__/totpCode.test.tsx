/**
 * A COUNTER CODE IS NEVER SHOWN TWICE (PASSWORD-MANAGER-SPEC.md, HOTP: "Tapping Next code raises
 * the counter, re-seals the entry, and only then shows the code. A crash never shows a code whose
 * counter wasn't saved"; the plan's test: "a failed save shows no code"). The RFC 4226 test key:
 * counter 0 gives 755224.
 */
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

jest.mock('../../../hooks/BtKeyboardContext', () => ({
  useSharedBtKeyboard: () => ({state: 'idle', forwarding: false, typeSecret: jest.fn()}),
}));

import {TotpCode} from '../TotpViews';

const RFC_KEY = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of "12345678901234567890"
const HOTP = {type: 'hotp', secret: RFC_KEY, counter: 0, digits: 6, algo: 'SHA1'};

const texts = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);

async function nextCode(onCounter: (n: number) => Promise<void>) {
  const failed: unknown[] = [];
  /* the screen's act(): runs the action, a rejection becomes an alert (here: recorded) */
  const run = (fn: () => void | Promise<void>) => {
    Promise.resolve(fn()).catch(e => failed.push(e));
  };
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(<TotpCode totp={HOTP} act={run} copy={async () => undefined} onCounter={onCounter} />);
  });
  const next = r.root.findAll(n => n.props.title === 'Next code' && typeof n.props.onPress === 'function')[0];
  await act(async () => {
    next.props.onPress();
    await new Promise<void>(res => setTimeout(() => res(), 0));
  });
  const shown = texts(r).some(t => t.replace(/\s/g, '') === '755224');
  act(() => r.unmount());
  return {shown, failed};
}

test('the counter is saved first: when the save fails, no code shows', async () => {
  const {shown, failed} = await nextCode(() => Promise.reject(new Error('the store could not be written')));
  expect(failed).toHaveLength(1);
  expect(shown).toBe(false);
});

test('when the save works, the code for the counter that was used shows (and the saved counter is the next one)', async () => {
  const saved: number[] = [];
  const {shown, failed} = await nextCode(async n => {
    saved.push(n);
  });
  expect(failed).toHaveLength(0);
  expect(saved).toEqual([1]);
  expect(shown).toBe(true);
});
