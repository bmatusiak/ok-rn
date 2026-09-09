/**
 * The soft-key transport, against the mocked native module.
 *
 * These could not exist before: `NativeOkEmu` was missing from jest.setup.js,
 * so importing this module threw from TurboModuleRegistry.getEnforcing. That
 * gap is why the most protocol-heavy code in the app has never had a unit test.
 */
import {OkEmu, IFACE, DIR} from '../src/transport/OkEmu';
import {bytes as okbytes} from 'node-onlykey-lib';

declare const __okEmu: {
  emitStream: (hex: string, opts?: {iface?: number; dir?: number}) => void;
  emitLed: (pixels: number[]) => void;
  reset: () => void;
};

const NativeOkEmu = require('../specs/NativeOkEmu').default;

describe('OkEmu', () => {
  afterEach(() => {
    OkEmu.destroy();
    __okEmu.reset();
    jest.clearAllMocks();
  });

  it('reports availability from the native module', () => {
    expect(OkEmu.isAvailable()).toBe(true);
  });

  it('writes bytes to the interface as hex', async () => {
    await OkEmu.write(IFACE.VENDOR, Uint8Array.from([0xff, 0x00, 0xe4]));
    expect(NativeOkEmu.writeHid).toHaveBeenCalledWith(IFACE.VENDOR, 'ff00e4');
  });

  it('surfaces a device report as bytes, not hex', async () => {
    const seen: Uint8Array[] = [];
    OkEmu.on('report', ({bytes}) => seen.push(bytes));
    await OkEmu.start();

    __okEmu.emitStream('deadbeef');

    expect(seen).toHaveLength(1);
    expect(okbytes.toHex(seen[0])).toBe('deadbeef');
  });

  it('only host-bound traffic becomes a report, though everything is a stream', async () => {
    // dir is the demultiplexer: a report is device->host. Treating an inbound
    // echo as a reply would make every request resolve with its own payload.
    const reports: number[] = [];
    const streams: number[] = [];
    OkEmu.on('report', () => reports.push(1));
    OkEmu.on('stream', () => streams.push(1));
    await OkEmu.start();

    __okEmu.emitStream('aa', {dir: DIR.OUT});
    __okEmu.emitStream('bb', {dir: DIR.IN});

    expect(streams).toHaveLength(2);
    expect(reports).toHaveLength(1);
  });

  it('nextReport resolves with the reply for its own interface', async () => {
    await OkEmu.start();
    const pending = OkEmu.nextReport(IFACE.VENDOR, 1000);

    __okEmu.emitStream('01020304', {iface: IFACE.VENDOR});

    expect(okbytes.toHex(await pending)).toBe('01020304');
  });

  it('nextReport ignores a report from a different interface', async () => {
    // The firmware multiplexes four interfaces onto one callback, so a SEREMU
    // debug line arriving mid-request must not be mistaken for the reply.
    await OkEmu.start();
    const pending = OkEmu.nextReport(IFACE.VENDOR, 1000);

    __okEmu.emitStream('ffff', {iface: IFACE.SEREMU});
    __okEmu.emitStream('5678', {iface: IFACE.VENDOR});

    expect(okbytes.toHex(await pending)).toBe('5678');
  });

  it('restart rejects, because the firmware thread cannot be restarted', async () => {
    // Asserted rather than skipped: the spec and OkEmu.ts both type this as
    // Promise<StartResult>, and nothing else in the suite says otherwise.
    await expect(OkEmu.restart()).rejects.toThrow(/not implemented/);
  });
});
