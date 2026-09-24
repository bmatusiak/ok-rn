/*
 * The vendor bridge's ROUTING, with no radio and no phone.
 *
 * What the hardware proves is the wire: tools/vendor_probe.py drives the GATT
 * service from a Windows host and python-onlykey's tests/ble_live.py drives a
 * key through it. Neither can be run by CI, and neither exercises the decisions
 * this file makes - which requests to answer, what to do when relaying is off,
 * and in what order reports go out.
 *
 * Those decisions are the ones that break quietly:
 *
 *  - answering a request tagged for another interface puts a reply on a
 *    characteristic whose host is waiting for something else entirely
 *  - sending reports concurrently rejects all but the first, because the notify
 *    budget is per LINK, and loses a label list
 *  - sending them out of order corrupts one, because the host reassembles by
 *    arrival
 *
 * The phone cannot be its own BLE central, so there is no ok-rn e2e suite that
 * could cover this. These are the coverage.
 */
import {transport as oktransport} from 'node-onlykey-lib';

const mockSendVendorReport = jest.fn((_hex: string) => Promise.resolve());

jest.mock('../specs/NativeFidoGatt', () => ({
  __esModule: true,
  default: {
    sendVendorReport: (hex: string) => mockSendVendorReport(hex),
  },
}));

type RequestListener = (event: Record<string, unknown>) => void;
type ReportListener = (event: {iface: number; data: Uint8Array}) => void;

let mockRequestListener: RequestListener | null = null;

jest.mock('../src/transport/FidoGatt', () => ({
  __esModule: true,
  default: {
    on: (event: string, listener: RequestListener) => {
      if (event === 'request') mockRequestListener = listener;
      return () => {
        mockRequestListener = null;
      };
    },
  },
}));

import {startVendorBridge} from '../src/vendorBridge';

const IFACE = oktransport.IFACE;

/** A stand-in for the key's transport: records writes, replays reports. */
function fakeTransport() {
  const writes: Array<{iface: number; data: Uint8Array}> = [];
  let reportListener: ReportListener | null = null;
  return {
    writes,
    emitReport(iface: number, data: Uint8Array) {
      if (reportListener) reportListener({iface, data});
    },
    transport: {
      name: 'fake',
      async write(iface: number, data: Uint8Array) {
        writes.push({iface, data});
      },
      on(event: string, listener: ReportListener) {
        if (event === 'report') reportListener = listener;
        return () => {
          reportListener = null;
        };
      },
    },
  };
}

function start(opts: {relaying?: () => boolean} = {}) {
  const fake = fakeTransport();
  const logged: Array<[string, string]> = [];
  const off = startVendorBridge({
    log: (level, text) => logged.push([level, text]),
    getKey: async () => ({transport: fake.transport} as never),
    isRelaying: opts.relaying,
  });
  return {fake, logged, off};
}

/** Let the bridge's own promise chain settle. */
const settle = () => new Promise<void>(resolve => setImmediate(() => resolve()));

beforeEach(() => {
  mockSendVendorReport.mockClear();
  mockRequestListener = null;
});

test('a vendor request is written to IFACE.VENDOR, unexamined', async () => {
  const {fake, off} = start();
  await mockRequestListener!({iface: 'vendor', hex: 'ffffffffe4', requestId: ''});
  expect(fake.writes).toHaveLength(1);
  expect(fake.writes[0].iface).toBe(IFACE.VENDOR);
  expect(Array.from(fake.writes[0].data)).toEqual([0xff, 0xff, 0xff, 0xff, 0xe4]);
  off();
});

test('a FIDO request is IGNORED, not answered', async () => {
  /*
   * The whole reason the event carries an interface. Every field fidoBridge
   * reads is CTAP and every field this reads is an OnlyKey report; answering
   * each other's requests would put a reply on the wrong characteristic.
   */
  const {fake, off} = start();
  await mockRequestListener!({iface: 'fido', hex: 'aabb', requestId: 'req-1'});
  expect(fake.writes).toHaveLength(0);
  expect(mockSendVendorReport).not.toHaveBeenCalled();
  off();
});

test('a vendor report is notified back as hex', async () => {
  const {fake, off} = start();
  await mockRequestListener!({iface: 'vendor', hex: 'e4', requestId: ''});
  fake.emitReport(IFACE.VENDOR, Uint8Array.from([0x55, 0x4e, 0x4c]));
  await settle();
  expect(mockSendVendorReport).toHaveBeenCalledWith('554e4c');
  off();
});

test('a report on another interface is not notified', async () => {
  /* KEYBOARD is not carried by the radio - it is delivered to whatever the
   * phone is paired with - and SEREMU is a debug console. Neither is ours. */
  const {fake, off} = start();
  await mockRequestListener!({iface: 'vendor', hex: 'e4', requestId: ''});
  fake.emitReport(IFACE.KEYBOARD, Uint8Array.from([1, 2, 3]));
  fake.emitReport(IFACE.SEREMU, Uint8Array.from([4, 5, 6]));
  await settle();
  expect(mockSendVendorReport).not.toHaveBeenCalled();
  off();
});

test('a burst of reports goes out ONE AT A TIME, in order', async () => {
  /*
   * The case a label list is. Android allows one outstanding notification per
   * LINK, so the native sendVendorReport rejects a second call before the first
   * drains - and getlabels answers with twelve reports in a burst with nothing
   * between them. Without the chain, one goes out and eleven are rejected.
   */
  const order: string[] = [];
  let release: (() => void) | null = null;
  mockSendVendorReport.mockImplementation(((hex: string) => {
    order.push(hex);
    if (order.length === 1) {
      return new Promise<void>(resolve => {
        release = resolve;
      });
    }
    return Promise.resolve();
  }) as never);

  const {fake, off} = start();
  await mockRequestListener!({iface: 'vendor', hex: 'e5', requestId: ''});
  fake.emitReport(IFACE.VENDOR, Uint8Array.from([1]));
  fake.emitReport(IFACE.VENDOR, Uint8Array.from([2]));
  fake.emitReport(IFACE.VENDOR, Uint8Array.from([3]));
  await settle();

  expect(order).toEqual(['01']);          // the second waits on the first
  release!();
  await settle();
  await settle();
  expect(order).toEqual(['01', '02', '03']);
  off();
});

test('a failed notify does not strand the reports behind it', async () => {
  /*
   * A notify usually fails because the central went away mid-answer. Letting
   * that reject the chain would leave every later report unsent with no way
   * back short of a reconnect.
   */
  mockSendVendorReport.mockImplementation(((hex: string) =>
    hex === '01' ? Promise.reject(new Error('central gone')) : Promise.resolve()
  ) as never);

  const {fake, off} = start();
  await mockRequestListener!({iface: 'vendor', hex: 'e5', requestId: ''});
  fake.emitReport(IFACE.VENDOR, Uint8Array.from([1]));
  fake.emitReport(IFACE.VENDOR, Uint8Array.from([2]));
  await settle();
  await settle();
  expect(mockSendVendorReport).toHaveBeenCalledTimes(2);
  off();
});

test('relaying off drops the write and never reaches the key', async () => {
  const {fake, off} = start({relaying: () => false});
  await mockRequestListener!({iface: 'vendor', hex: 'e4', requestId: ''});
  expect(fake.writes).toHaveLength(0);
  off();
});

test('unsubscribing stops the bridge answering', async () => {
  const {fake, off} = start();
  await mockRequestListener!({iface: 'vendor', hex: 'e4', requestId: ''});
  expect(fake.writes).toHaveLength(1);
  off();
  expect(mockRequestListener).toBeNull();
});
