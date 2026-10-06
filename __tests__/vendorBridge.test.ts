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
/* every frame the bridge sends, with its command (Part T: 0x84 sealed, 0x85 pairing) */
const mockFrames: Array<{cmd: number; hex: string}> = [];

jest.mock('../specs/NativeFidoGatt', () => ({
  __esModule: true,
  default: {
    sendVendorReport: (hex: string) => mockSendVendorReport(hex),
    /* a plaintext report (0x83) is what the tests below have always asserted on */
    sendVendorFrame: (cmd: number, hex: string) => {
      mockFrames.push({cmd, hex});
      return cmd === 0x83 ? mockSendVendorReport(hex) : Promise.resolve();
    },
  },
}));

/*
 * The tests below are about the bridge's OTHER gates - the target, API, who
 * owns the conversation, the lane - and send plaintext reports. They run
 * through a gate in testing mode with transit switched off, the one setting
 * where plaintext passes. The pairing gate itself has its own tests at the end
 * (and in btTransit.test.ts).
 */
jest.mock('../src/btTransit', () => {
  const actual = jest.requireActual('../src/btTransit');
  const m = new Map<string, string>();
  const gate = actual.createBtTransit({
    isTestingMode: () => true,
    storage: {getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => void m.set(k, v), removeItem: async (k: string) => void m.delete(k)},
    box: {boxSeal: async (_a: string, h: string) => h, boxOpen: async (_a: string, h: string) => h},
  });
  return {...actual, btTransit: gate};
});

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
      /* a plaintext vendor message unless the test says otherwise */
      if (event === 'request') mockRequestListener = e => listener({command: 0x03, ...e});
      return () => {
        mockRequestListener = null;
      };
    },
  },
}));

import {startVendorBridge, computerHoldsKey} from '../src/vendorBridge';

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

beforeAll(async () => {
  await jest.requireMock<typeof import('../src/btTransit')>('../src/btTransit').btTransit.setTransitOff(true);
});

beforeEach(() => {
  mockFrames.length = 0;
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

test('rule 8: a Hold waiting at the front goes in at the next computer request - not after its quiet', async () => {
  const {lane} = jest.requireActual('node-onlykey-lib/transport');
  const fake = fakeTransport();
  const t = fake.transport as unknown as {exclusive: unknown; urgentWaiting: unknown};
  t.exclusive = (fn: () => Promise<unknown>, opts?: {urgent?: boolean}) => lane.laneOf(fake.transport)(fn, opts);
  t.urgentWaiting = () => lane.laneOf(fake.transport).urgentWaiting();
  const off = startVendorBridge({log: () => {}, getKey: async () => ({transport: fake.transport} as never), getTarget: () => TARGET});
  await mockRequestListener!({iface: 'vendor', hex: 'ffffffffe401', requestId: '', address: TARGET});
  expect(fake.writes).toHaveLength(1);
  expect(computerHoldsKey()).toBe(true);
  /* the person taps Hold: urgent, at the front */
  let writesWhenHeld = -1;
  const hold = lane.inLane(fake.transport, async () => {
    writesWhenHeld = fake.writes.length;
  }, {urgent: true});
  await settle();
  expect(writesWhenHeld).toBe(-1); /* not into the computer's conversation */
  /* the computer's next request is the boundary: the Hold first, then this request */
  const t0 = Date.now();
  await mockRequestListener!({iface: 'vendor', hex: 'ffffffffe402', requestId: '', address: TARGET});
  await hold;
  await settle();
  expect(writesWhenHeld).toBe(1);
  expect(fake.writes).toHaveLength(2);
  expect(Date.now() - t0).toBeLessThan(1000); /* not after the 1.5 s quiet */
  off();
  expect(computerHoldsKey()).toBe(false);
});

test('rule 8: only the phone taps are urgent - a computer Hold (OKEDGE GRANT_HOLD) queues as normal, behind the app', async () => {
  const {lane} = jest.requireActual('node-onlykey-lib/transport');
  const fake = fakeTransport();
  const asked: Array<{urgent?: boolean} | undefined> = [];
  const t = fake.transport as unknown as {exclusive: unknown; urgentWaiting: unknown};
  t.exclusive = (fn: () => Promise<unknown>, opts?: {urgent?: boolean}) => {
    asked.push(opts);
    return lane.laneOf(fake.transport)(fn, opts);
  };
  t.urgentWaiting = () => lane.laneOf(fake.transport).urgentWaiting();
  const off = startVendorBridge({log: () => {}, getKey: async () => ({transport: fake.transport} as never), getTarget: () => TARGET});
  /* the app is in a conversation with the key, and another app request waits */
  const order: string[] = [];
  let endApp: () => void = () => undefined;
  const app = lane.inLane(fake.transport, () => new Promise<void>(r => { order.push('app'); endApp = () => r(); }));
  const appNext = lane.inLane(fake.transport, async () => { order.push('app next'); });
  /* a computer sends a Hold of budget 7 - the very message the phone's own Hold sends */
  const req = mockRequestListener!({iface: 'vendor', hex: 'fffffffff813' + '00000007', requestId: '', address: TARGET});
  await settle();
  expect(t.urgentWaiting && (t.urgentWaiting as () => boolean)()).toBe(false);
  expect(fake.writes).toHaveLength(0); /* not into the app's conversation */
  endApp();
  await app;
  await appNext;
  await req;
  await settle();
  expect(order).toEqual(['app', 'app next']);
  expect(fake.writes).toHaveLength(1); /* written after both app conversations: in line, not at the front */
  expect(asked.every(o => !o || !o.urgent)).toBe(true); /* the bridge never asks for urgent */
  off();
});

/*
 * EDGE_REQUEST (OKEDGE_REQUEST 0xF7, mcp-service.md 4.7a): the bridge KEEPS it
 * for the app - the person approves the text and the names on the phone - and
 * answers the same way. Nothing of it is written to the key.
 */
describe('an agent\'s budget request', () => {
  const {wire} = jest.requireActual('node-onlykey-lib/edge');
  const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

  function startEdge(answer: (msg: any, from: string) => Promise<unknown | null>, opts: {api?: () => boolean} = {}) {
    const fake = fakeTransport();
    const got: Array<{msg: any; from: string}> = [];
    const off = startVendorBridge({
      log: () => undefined,
      getKey: async () => ({transport: fake.transport} as never),
      isApi: opts.api,
      getTarget: () => TARGET,
      onEdgeRequest: async (msg, from) => {
        got.push({msg, from});
        return answer(msg, from);
      },
    });
    return {fake, got, off};
  }
  const send = async (msg: unknown, address = TARGET) => {
    for (const f of wire.encode(wire.KIND.REQUEST, msg)) {
      await mockRequestListener!({iface: 'vendor', hex: hex(f), requestId: '', address});
    }
  };
  const answered = () => {
    const asm = wire.createAssembler();
    let out: any = null;
    for (const [h] of mockSendVendorReport.mock.calls) {
      const r = asm.push(Uint8Array.from((h as string).match(/../g)!.map(x => parseInt(x, 16))));
      if (r && !('error' in r)) out = r;
    }
    return out;
  };
  const MSG = {type: 'EDGE_REQUEST', reason: 'push bm-ok/ok-rn - a reason long enough to need several reports', scopes: [{op: 'sign', slot: 222, cap: 5, identity: 'ssh://agent@nitro16'}], lifetime: 60};

  test('it is gathered for the app and never written to the key; the answer goes back as OKEDGE_REQUEST reports', async () => {
    const {fake, got, off} = startEdge(async () => ({ok: false, refusal: 'declined'}));
    await send(MSG);
    await settle();
    await settle();
    expect(fake.writes).toHaveLength(0);
    expect(got).toEqual([{msg: MSG, from: TARGET}]);
    expect(answered()).toEqual({kind: wire.KIND.ANSWER, message: {ok: false, refusal: 'declined'}});
    off();
  });

  test('dropped (null) is answered with nothing', async () => {
    const {fake, off} = startEdge(async () => null);
    await send(MSG);
    await settle();
    expect(fake.writes).toHaveLength(0);
    expect(mockSendVendorReport).not.toHaveBeenCalled();
    off();
  });

  test('the same gates: not the target, or API off - not even read', async () => {
    let api = false;
    const {fake, got, off} = startEdge(async () => ({ok: true}), {api: () => api});
    await send(MSG);
    api = true;
    await send(MSG, OTHER);
    await settle();
    expect(got).toHaveLength(0);
    expect(fake.writes).toHaveLength(0);
    off();
  });
});

/*
 * PART T THROUGH THE BRIDGE: the real gate, transit ON (every build outside
 * testing mode). Vendor interface only - the same bridge, the same gates
 * (target, API), with the pairing gate in front of the key.
 */
describe('the pairing gate (Part T)', () => {
  const bt = jest.requireActual('node-onlykey-lib/btpair');
  const {createBtTransit} = jest.requireActual('../src/btTransit');
  const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map(x => parseInt(x, 16)));
  const hexOf = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

  function startGated() {
    const fake = fakeTransport();
    const m = new Map<string, string>();
    const gate = createBtTransit({
      isTestingMode: () => false,
      storage: {getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => void m.set(k, v), removeItem: async (k: string) => void m.delete(k)},
      box: {boxSeal: async (_a: string, h: string) => h, boxOpen: async (_a: string, h: string) => h},
    });
    const off = startVendorBridge({
      log: () => undefined,
      getKey: async () => ({transport: fake.transport} as never),
      getTarget: () => TARGET,
      transit: gate,
    });
    return {fake, gate, off};
  }
  const send = async (command: number, bytes: Uint8Array, address = TARGET) => {
    await mockRequestListener!({iface: 'vendor', command, hex: hexOf(bytes), requestId: '', address});
    await settle();
  };
  const lastFrame = (cmd: number) => {
    const f = [...mockFrames].reverse().find(x => x.cmd === cmd);
    return f ? fromHex(f.hex) : null;
  };

  test('plaintext gets nothing: not written to the key, nothing sent back', async () => {
    const {fake, off} = startGated();
    await send(0x03, Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xe4]));
    expect(fake.writes).toHaveLength(0);
    expect(mockFrames).toHaveLength(0);
    off();
  });

  test('pair, connect, and a report goes to the key and back sealed', async () => {
    const {fake, gate, off} = startGated();
    const cli = bt.generateIdentity();
    gate.openPairWindow();
    const s1 = bt.cliPairStart({identity: cli, name: 'NITRO16'});
    await send(0x05, s1.msg);
    const s2 = bt.cliPairOnKeys(s1.state, lastFrame(0x85));
    await send(0x05, s2.msg);
    expect(gate.pairing()).toMatchObject({stage: 'code', code: s2.code});
    gate.approvePairing();
    await settle();
    const s3 = bt.cliPairOnDone(s2.state, lastFrame(0x85), Date.now());
    await send(0x05, s3.msg);
    expect(bt.cliPairOnAck(s3.record, lastFrame(0x85))).toBe(true);

    const h = bt.cliHello(s3.record, {name: 'NITRO16'});
    await send(0x05, h.msg);
    const session = bt.cliOnHelloOk(h.state, lastFrame(0x85));
    const req = Uint8Array.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xe4]);
    await send(0x04, bt.seal(session, req));
    expect(fake.writes).toHaveLength(1);
    expect(Array.from(fake.writes[0].data)).toEqual([0xff, 0xff, 0xff, 0xff, 0xe4]);

    fake.emitReport(IFACE.VENDOR, padded(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x99])));
    await settle();
    const back = bt.open(session, lastFrame(0x84));
    expect(back[0]).toBe(0x01);
    expect(Array.from(back.slice(1, 6))).toEqual([0xff, 0xff, 0xff, 0xff, 0x99]);
    expect(mockSendVendorReport).not.toHaveBeenCalled(); /* nothing went out in plaintext */
    off();
  });

  test('several reports in one write: each reaches the key alone, in order, through the same checks (Brad, 2026-10-06)', async () => {
    const {fake, gate, off} = startGated();
    const cli = bt.generateIdentity();
    gate.openPairWindow();
    const s1 = bt.cliPairStart({identity: cli, name: 'NITRO16'});
    await send(0x05, s1.msg);
    const s2 = bt.cliPairOnKeys(s1.state, lastFrame(0x85));
    await send(0x05, s2.msg);
    gate.approvePairing();
    await settle();
    const s3 = bt.cliPairOnDone(s2.state, lastFrame(0x85), Date.now());
    await send(0x05, s3.msg);
    const h = bt.cliHello(s3.record, {name: 'NITRO16'});
    await send(0x05, h.msg);
    const session = bt.cliOnHelloOk(h.state, lastFrame(0x85));

    const one = padded(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xe4, 1]));
    const fw = padded(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xf4]));
    const three = padded(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xe4, 3]));
    const pt = new Uint8Array(1 + 192);
    pt[0] = 0x03;
    [one, fw, three].forEach((r, i) => pt.set(r, 1 + i * 64));
    await send(0x04, bt.seal(session, pt));
    /* the firmware update refused on its own; the two around it written, in order */
    expect(fake.writes.map(w => Array.from(w.data.slice(0, 6)))).toEqual([Array.from(one.slice(0, 6)), Array.from(three.slice(0, 6))]);
    off();
  });

  test('a pairing request from a computer that is not the target never reaches the gate', async () => {
    const {gate, off} = startGated();
    gate.openPairWindow();
    await send(0x05, bt.cliPairStart({identity: bt.generateIdentity(), name: 'X'}).msg, OTHER);
    expect(mockFrames).toHaveLength(0);
    off();
  });
});
