/**
 * TYPE NEVER INTERLEAVES WITH A BACKUP CAPTURE (PASSWORD-MANAGER-SPEC.md, "Typing a password over
 * Bluetooth": "it respects suspend(), so a backup capture and a manager Type can never interleave";
 * the spec's test: "a backup capture during a Type is refused"). The capture holds the keyboard
 * with suspend(); a Type asked meanwhile is refused before one keystroke goes out, and works again
 * once the capture ends. And the other way: while a Type is sending, a second one is refused.
 */
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

let mockStatus: ((e: any) => void) | null = null;
jest.mock('../specs/NativeBtKeyboard', () => ({
  __esModule: true,
  default: {
    isSupported: jest.fn(() => Promise.resolve(true)),
    isRadioOn: jest.fn(() => Promise.resolve(true)),
    requestPermissions: jest.fn(() => Promise.resolve(true)),
    register: jest.fn(() => Promise.resolve(true)),
    unregister: jest.fn(() => Promise.resolve()),
    requestDiscoverable: jest.fn(() => Promise.resolve(true)),
    localName: jest.fn(() => Promise.resolve('test')),
    hosts: jest.fn(() => Promise.resolve([])),
    connect: jest.fn(() => Promise.resolve(true)),
    disconnect: jest.fn(() => Promise.resolve()),
    sendReport: jest.fn(() => Promise.resolve(true)),
    onStatus: jest.fn((cb: (e: any) => void) => {
      mockStatus = cb;
      return {remove: () => undefined};
    }),
  },
}));

import NativeBtKeyboard from '../specs/NativeBtKeyboard';
import {useBtKeyboard} from '../src/hooks/useBtKeyboard';

const sent = NativeBtKeyboard.sendReport as jest.Mock;
/* the reports a Type sends, without the RELEASE_ALL the hook sends around everything */
const RELEASE_ALL = '0000000000000000';
const keystrokes = () => sent.mock.calls.map(c => c[0]).filter(h => h !== RELEASE_ALL);

/* unmounted after every test, failed or not: the hook's timers would otherwise keep jest running */
let mounted: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = null;
  sent.mockImplementation(() => Promise.resolve(true));
});

async function connectedKeyboard() {
  let kb!: ReturnType<typeof useBtKeyboard>;
  const Probe = () => {
    kb = useBtKeyboard();
    return null;
  };
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(<Probe />);
  });
  mounted = r;
  await act(async () => {
    mockStatus!({state: 'connected', name: 'NITRO16', address: 'AA:BB:CC:DD:EE:FF'});
    kb.setForwarding(true);
  });
  return {kb: () => kb, r};
}

beforeEach(() => sent.mockClear());

test('a Type asked while a backup capture holds the keyboard is refused, with nothing sent', async () => {
  const {kb} = await connectedKeyboard();
  let endCapture!: () => void;
  const capture = new Promise<void>(res => (endCapture = res));
  let holding!: Promise<unknown>;
  await act(async () => {
    holding = kb().suspend(() => capture);
  });
  await expect(kb().typeSecret('hunter2')).rejects.toThrow(/busy/);
  expect(keystrokes()).toHaveLength(0);
  await act(async () => {
    endCapture();
    await holding;
  });
  /* the capture is over: the same Type now goes out */
  await kb().typeSecret('hunter2');
  expect(keystrokes().length).toBeGreaterThan(0);
});

test('while one Type is sending, a second is refused', async () => {
  const {kb} = await connectedKeyboard();
  let release!: () => void;
  const slow = new Promise<boolean>(res => (release = () => res(true)));
  sent.mockImplementationOnce(() => slow);
  const first = kb().typeSecret('ab');
  await expect(kb().typeSecret('cd')).rejects.toThrow(/busy/);
  release();
  await first;
});
