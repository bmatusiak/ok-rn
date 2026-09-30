/*
 * The FIDO bridge's GATES, with no radio and no key.
 *
 * "Each door has a gate, and a device must be targeted." The native side
 * refuses at the radio (setIoPolicy in NativeFidoGattModule.kt), and nothing
 * here can run Kotlin - so these cover the second copy of the gate, the one in
 * JS, which is what still holds if a request crosses a change of target in
 * flight or the native gate is ever wrong.
 *
 * The one behaviour both copies share: a refused request is ANSWERED, with
 * CTAP2_ERR_OPERATION_DENIED, never left to time out - silence makes a browser
 * sit on "talking to your security key", which reads as a broken
 * authenticator rather than one that said no.
 */
const mockRespond = jest.fn((_id: string, _hex: string) => Promise.resolve());

type RequestListener = (event: Record<string, unknown>) => void;
let mockRequestListener: RequestListener | null = null;

jest.mock('../src/transport/FidoGatt', () => ({
  __esModule: true,
  isFromTarget: (address: string | undefined, target: string | null) =>
    jest.requireActual('../src/transport/FidoGatt').isFromTarget(address, target),
  default: {
    on: (event: string, listener: RequestListener) => {
      if (event === 'request') mockRequestListener = listener;
      return () => {
        mockRequestListener = null;
      };
    },
    respondToRequest: (id: string, hex: string) => mockRespond(id, hex),
    sendKeepAlive: () => Promise.resolve(),
  },
}));

import {startFidoBridge} from '../src/fidoBridge';

const TARGET = 'AA:BB:CC:DD:EE:01';
const OTHER = 'AA:BB:CC:DD:EE:02';
const DENIED = '27';

/** A CTAP BLE MSG carrying authenticatorGetInfo. */
const getInfo = (address?: string) => ({
  requestId: 'req-1',
  iface: 'fido',
  command: 0x83,
  commandName: 'authenticatorGetInfo',
  hex: '04',
  rpId: '',
  address,
});

function start(opts: {webauthn?: () => boolean; target?: () => string | null} = {}) {
  const getKey = jest.fn(async () => {
    throw new Error('the key must not be asked');
  });
  const off = startFidoBridge({
    log: () => {},
    getKey: getKey as never,
    isWebAuthn: opts.webauthn ?? (() => true),
    getTarget: opts.target ?? (() => TARGET),
  });
  return {getKey, off};
}

/** Let the fire-and-forget handler settle. */
const settle = () => new Promise<void>(resolve => setImmediate(() => resolve()));

beforeEach(() => {
  mockRespond.mockClear();
  mockRequestListener = null;
});

test('WebAuthn off: the target is answered DENIED and the key is not asked', async () => {
  const {getKey, off} = start({webauthn: () => false});
  mockRequestListener!(getInfo(TARGET));
  await settle();
  expect(mockRespond).toHaveBeenCalledWith('req-1', DENIED);
  expect(getKey).not.toHaveBeenCalled();
  off();
});

test('a computer that is not the target is answered DENIED', async () => {
  const {getKey, off} = start();
  mockRequestListener!(getInfo(OTHER));
  await settle();
  expect(mockRespond).toHaveBeenCalledWith('req-1', DENIED);
  expect(getKey).not.toHaveBeenCalled();
  off();
});

test('target None refuses everyone, the would-be target included', async () => {
  const {getKey, off} = start({target: () => null});
  mockRequestListener!(getInfo(TARGET));
  await settle();
  expect(mockRespond).toHaveBeenCalledWith('req-1', DENIED);
  expect(getKey).not.toHaveBeenCalled();
  off();
});

test('a request with no sender address is refused - the gate fails shut', async () => {
  const {getKey, off} = start();
  mockRequestListener!(getInfo(undefined));
  await settle();
  expect(mockRespond).toHaveBeenCalledWith('req-1', DENIED);
  expect(getKey).not.toHaveBeenCalled();
  off();
});

test('a vendor request is not the FIDO bridge\'s to answer, target or not', async () => {
  const {off} = start();
  mockRequestListener!({...getInfo(TARGET), iface: 'vendor'});
  await settle();
  expect(mockRespond).not.toHaveBeenCalled();
  off();
});
