/*
 * The vendor bridge's ROUTING, with no radio and no phone.
 *
 * What the hardware proves is the wire: tools/vendor_probe.py drives the GATT
 * service from a Windows host and python-onlykey's tests/ble_live.py drives a
 * key through it. Neither can be run by CI, and neither exercises the decisions
 * this file makes - which requests to answer, what to do when API is off or
 * the sender is not the target, which reports go out, and in what order.
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
  /* The real comparison - it is part of what these tests are about. */
  isFromTarget: (address: string | undefined, target: string | null) =>
    jest.requireActual('../src/transport/FidoGatt').isFromTarget(address, target),
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

/** The targeted computer, and one that is bonded but not targeted. */
const TARGET = 'AA:BB:CC:DD:EE:01';
const OTHER = 'AA:BB:CC:DD:EE:02';

/** Pad to a 64-byte report, as pipeTransport does before a write goes out. */
function padded(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(64);
  out.set(data);
  return out;
}

/**
 * A stand-in for the key's transport: records writes, replays reports, and
 * echoes every write on 'write' - padded, AFTER it has gone out - the way both
 * real pipes do (UsbPipe.write, OkEmu's stream).
 */
function fakeTransport() {
  const writes: Array<{iface: number; data: Uint8Array}> = [];
  let reportListener: ReportListener | null = null;
  let writeListener: ReportListener | null = null;
  return {
    writes,
    emitReport(iface: number, data: Uint8Array) {
      if (reportListener) reportListener({iface, data});
    },
    /** The APP writing to the key - Slots asking for labels, say. */
    appWrite(iface: number, data: Uint8Array) {
      if (writeListener) writeListener({iface, data: padded(data)});
    },
    transport: {
      name: 'fake',
      async write(iface: number, data: Uint8Array) {
        writes.push({iface, data});
        if (writeListener) writeListener({iface, data: padded(data)});
      },
      on(event: string, listener: ReportListener) {
        if (event === 'report') reportListener = listener;
        if (event === 'write') writeListener = listener;
        return () => {
          if (event === 'report') reportListener = null;
          if (event === 'write') writeListener = null;
        };
      },
    },
  };
}

function start(opts: {api?: () => boolean; target?: () => string | null} = {}) {
  const fake = fakeTransport();
  const logged: Array<[string, string]> = [];
  const off = startVendorBridge({
    log: (level, text) => logged.push([level, text]),
    getKey: async () => ({transport: fake.transport} as never),
    isApi: opts.api,
    getTarget: opts.target ?? (() => TARGET),
  });
  return {fake, logged, off};
}

/** Let the bridge's own promise chain settle. */
const settle = () => new Promise<void>(resolve => setImmediate(() => resolve()));

beforeEach(() => {
  mockSendVendorReport.mockClear();
  mockSendVendorReport.mockImplementation((_hex: string) => Promise.resolve());
  mockRequestListener = null;
});

test('a vendor request is written to IFACE.VENDOR, unexamined', async () => {
  const {fake, off} = start();
  await mockRequestListener!({iface: 'vendor', hex: 'ffffffffe4', requestId: '', address: TARGET});
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
  await mockRequestListener!({iface: 'fido', hex: 'aabb', requestId: 'req-1', address: TARGET});
  expect(fake.writes).toHaveLength(0);
  expect(mockSendVendorReport).not.toHaveBeenCalled();
  off();
});

test('a vendor report is notified back as hex', async () => {
  const {fake, off} = start();
  await mockRequestListener!({iface: 'vendor', hex: 'e4', requestId: '', address: TARGET});
  fake.emitReport(IFACE.VENDOR, Uint8Array.from([0x55, 0x4e, 0x4c]));
  await settle();
  expect(mockSendVendorReport).toHaveBeenCalledWith('554e4c');
  off();
});

test('a report on another interface is not notified', async () => {
  /* KEYBOARD is not carried by the radio - it is delivered to whatever the
   * phone is paired with - and SEREMU is a debug console. Neither is ours. */
  const {fake, off} = start();
  await mockRequestListener!({iface: 'vendor', hex: 'e4', requestId: '', address: TARGET});
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
  await mockRequestListener!({iface: 'vendor', hex: 'e5', requestId: '', address: TARGET});
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
  await mockRequestListener!({iface: 'vendor', hex: 'e5', requestId: '', address: TARGET});
  fake.emitReport(IFACE.VENDOR, Uint8Array.from([1]));
  fake.emitReport(IFACE.VENDOR, Uint8Array.from([2]));
  await settle();
  await settle();
  expect(mockSendVendorReport).toHaveBeenCalledTimes(2);
  off();
});

test('API off drops the write and never reaches the key', async () => {
  const {fake, off} = start({api: () => false});
  await mockRequestListener!({iface: 'vendor', hex: 'e4', requestId: '', address: TARGET});
  expect(fake.writes).toHaveLength(0);
  off();
});

/*
 * THE TARGET GATE, second copy. The native side refuses these at the radio;
 * this is the check that still holds if a request crosses a change of target
 * in flight, or if the native gate is ever wrong.
 */
test('a write from a computer that is not the target never reaches the key', async () => {
  const {fake, logged, off} = start();
  await mockRequestListener!({iface: 'vendor', hex: 'e4', requestId: '', address: OTHER});
  expect(fake.writes).toHaveLength(0);
  expect(logged.some(([, text]) => /not the target/.test(text))).toBe(true);
  off();
});

test('target None: nothing reaches the key', async () => {
  const {fake, off} = start({target: () => null});
  await mockRequestListener!({iface: 'vendor', hex: 'e4', requestId: '', address: TARGET});
  expect(fake.writes).toHaveLength(0);
  off();
});

test('a request with no sender address is refused - the gate fails shut', async () => {
  const {fake, off} = start();
  await mockRequestListener!({iface: 'vendor', hex: 'e4', requestId: ''});
  expect(fake.writes).toHaveLength(0);
  off();
});

test('the target is matched case-insensitively', async () => {
  /* Stored targets come out of AsyncStorage; the radio reports upper-case. */
  const {fake, off} = start({target: () => TARGET.toLowerCase()});
  await mockRequestListener!({iface: 'vendor', hex: 'e4', requestId: '', address: TARGET});
  expect(fake.writes).toHaveLength(1);
  off();
});

/*
 * THE LEAK. Every vendor report used to be notified to the central whenever
 * the switch was on - the answers to the APP's own requests included, so a
 * paired computer heard the slot list every time the Slots tab opened.
 */
test('a report nobody over BLE asked for is not notified', async () => {
  const {fake, off} = start();
  /* Subscribe the bridge the way a real request does, then let the app talk. */
  await mockRequestListener!({iface: 'vendor', hex: 'e4', requestId: '', address: TARGET});
  fake.appWrite(IFACE.VENDOR, Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xe5]));
  fake.emitReport(IFACE.VENDOR, Uint8Array.from([0x4c, 0x41, 0x42]));
  await settle();
  expect(mockSendVendorReport).not.toHaveBeenCalled();
  off();
});

test('our own write echoing back does not hand the conversation to the app', async () => {
  /* The fake echoes every write, as both real pipes do; the reply must still
   * go to the computer that asked. */
  const {fake, off} = start();
  await mockRequestListener!({iface: 'vendor', hex: 'e5', requestId: '', address: TARGET});
  fake.emitReport(IFACE.VENDOR, Uint8Array.from([1]));
  await settle();
  expect(mockSendVendorReport).toHaveBeenCalledWith('01');
  off();
});

test('the BLE computer speaking again takes the conversation back', async () => {
  const {fake, off} = start();
  await mockRequestListener!({iface: 'vendor', hex: 'e5', requestId: '', address: TARGET});
  fake.appWrite(IFACE.VENDOR, Uint8Array.from([0xe4]));
  fake.emitReport(IFACE.VENDOR, Uint8Array.from([1]));
  await mockRequestListener!({iface: 'vendor', hex: 'e5', requestId: '', address: TARGET});
  fake.emitReport(IFACE.VENDOR, Uint8Array.from([2]));
  await settle();
  expect(mockSendVendorReport.mock.calls.map(c => c[0])).toEqual(['02']);
  off();
});

test('API switched off mid-conversation stops the reports', async () => {
  let api = true;
  const {fake, off} = start({api: () => api});
  await mockRequestListener!({iface: 'vendor', hex: 'e5', requestId: '', address: TARGET});
  api = false;
  fake.emitReport(IFACE.VENDOR, Uint8Array.from([1]));
  await settle();
  expect(mockSendVendorReport).not.toHaveBeenCalled();
  off();
});

test('a change of target stops the reports to the old one', async () => {
  let target: string | null = TARGET;
  const {fake, off} = start({target: () => target});
  await mockRequestListener!({iface: 'vendor', hex: 'e5', requestId: '', address: TARGET});
  target = OTHER;
  fake.emitReport(IFACE.VENDOR, Uint8Array.from([1]));
  await settle();
  expect(mockSendVendorReport).not.toHaveBeenCalled();
  off();
});

test('unsubscribing stops the bridge answering', async () => {
  const {fake, off} = start();
  await mockRequestListener!({iface: 'vendor', hex: 'e4', requestId: '', address: TARGET});
  expect(fake.writes).toHaveLength(1);
  off();
  expect(mockRequestListener).toBeNull();
});

test('OKFWUPDATE is REFUSED and never reaches the key', async () => {
  /*
   * On a physical developer key this message locks the bootloader and turns it
   * into a production key for good, and this bridge relays to whichever key is
   * active - a plugged-in hard key included. So it must not cross the radio.
   * Silence rather than a reply, and a log line saying why.
   */
  const {fake, logged, off} = start();
  await mockRequestListener!({iface: 'vendor', hex: 'fffffffff4' + '00'.repeat(59), requestId: '', address: TARGET});
  expect(fake.writes).toHaveLength(0);
  expect(logged.some(([level, text]) => level === 'error' && /OKFWUPDATE refused/.test(text))).toBe(true);
  off();
});

test('the refusal matches the MESSAGE, not a byte that happens to be 0xf4', async () => {
  /*
   * The other direction of the same check. A refusal that fired on 0xf4
   * anywhere would silently drop ordinary traffic - a set-time payload, a slot
   * label, a key blob - and a dropped write looks exactly like a slow key.
   * OKCONNECT with 0xf4 in its payload must go through untouched.
   */
  const {fake, off} = start();
  await mockRequestListener!({iface: 'vendor', hex: 'ffffffffe4f4f4f4', requestId: '', address: TARGET});
  expect(fake.writes).toHaveLength(1);
  expect(fake.writes[0].data[4]).toBe(0xe4);
  off();
});

/*
 * A COMPUTER'S CONVERSATION HOLDS THE KEY'S LANE (2026-10-03): an app request
 * (Key Chain, the background Edge copy) waits until the computer's
 * conversation is over - the key quiet AND not waiting for a press - instead
 * of landing in the middle of a push or a gpg signature and taking its answer.
 */
test('a computer conversation holds the key: an app request waits for quiet and for the press', async () => {
  const fake = fakeTransport();
  let tail: Promise<unknown> = Promise.resolve();
  const lane = (fn: () => Promise<unknown>) => {
    const run = tail.then(fn, fn);
    tail = run.then(() => {}, () => {});
    return run;
  };
  (fake.transport as unknown as {exclusive: typeof lane}).exclusive = lane;
  let waiting = true;
  const off = startVendorBridge({
    log: () => {},
    getKey: async () => ({transport: fake.transport} as never),
    getTarget: () => TARGET,
    isKeyWaiting: async () => waiting,
  });
  await mockRequestListener!({iface: 'vendor', hex: 'ffffffffe4', requestId: '', address: TARGET});
  expect(fake.writes).toHaveLength(1);
  let appRan = false;
  const app = lane(async () => {
    appRan = true;
  });
  await new Promise<void>(r => setTimeout(r, 1700));
  expect(appRan).toBe(false); /* quiet, but the key waits for a press: still the computer's */
  waiting = false;
  await new Promise<void>(r => setTimeout(r, 1700));
  await app;
  expect(appRan).toBe(true);
  off();
}, 10000);
