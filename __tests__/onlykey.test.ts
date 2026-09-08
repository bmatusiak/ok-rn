/**
 * The library, composed for this app.
 *
 * src/onlykey.ts is the entire wiring between ok-rn and node-onlykey-lib, and
 * nothing else exercises it: the hook only calls getOnlyKey() when the user
 * presses OKCONNECT or Set PIN, so a broken composition would ship and fail on
 * the phone rather than here.
 *
 * These run against the mocked NativeOkEmu from jest.setup.js, which is
 * drivable - __okEmu.emitStream() pushes a device report back - so the whole
 * stack from the library's transport down to the TurboModule boundary is real.
 */
import {getOnlyKey, resetOnlyKey} from '../src/onlykey';
import OkEmu, {IFACE} from '../src/transport/OkEmu';

declare const __okEmu: {
  emitStream: (hex: string, opts?: {iface?: number; dir?: number}) => void;
  reset: () => void;
};

const NativeOkEmu = require('../specs/NativeOkEmu').default;

describe('onlykey composition', () => {
  afterEach(async () => {
    await resetOnlyKey();
    /*
     * OkEmu is a process-wide singleton and latches `started` once it has
     * subscribed to the native module. Clearing the mock's listeners without
     * destroying it leaves that flag set, so ensureSubscribed() short-circuits
     * on the next test and no event ever arrives - which looks exactly like a
     * transport that dropped its reports.
     */
    OkEmu.destroy();
    __okEmu.reset();
    jest.clearAllMocks();
  });

  it('builds an app with the device and okcrypto services', async () => {
    const ok = await getOnlyKey();
    expect(typeof ok.device.setPin).toBe('function');
    expect(typeof ok.device.readLabels).toBe('function');
    expect(typeof ok.okcrypto.registerPgpHooks).toBe('function');
  });

  it('keeps the session key out of reach', async () => {
    /*
     * The session holds the transit key and plugins/session restricts it to
     * device and okcrypto. Proving that here matters more than in the
     * library's own tests: this is the composition that actually ships, and a
     * plugin added to src/onlykey.ts later must not quietly widen the door.
     */
    const ok = await getOnlyKey();
    expect((ok as any).session).toBeUndefined();
    expect(ok.transport.name).toBe('embedded');
  });

  it('returns the same app to concurrent callers', async () => {
    /*
     * The screen mounting and the auto-start effect race at launch. Two apps
     * against one firmware would mean two OKCONNECTs and two session keys, the
     * second silently invalidating the first.
     */
    const [a, b] = await Promise.all([getOnlyKey(), getOnlyKey()]);
    expect(a).toBe(b);
  });

  it('drives the real transport down to the native module', async () => {
    // Not a stub: the library builds the frame, the embedded transport pads it
    // and hands it to OkEmu, which calls writeHid with hex.
    const ok = await getOnlyKey();
    await ok.transport.write(IFACE.VENDOR, Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xe4]));

    expect(NativeOkEmu.writeHid).toHaveBeenCalledTimes(1);
    const [iface, hex] = NativeOkEmu.writeHid.mock.calls[0];
    expect(iface).toBe(IFACE.VENDOR);
    expect(hex.slice(0, 10)).toBe('ffffffffe4');
    expect(hex).toHaveLength(128); // 64 bytes, padded by the transport
  });

  it('a device report reaches the library as a report, not as an echo', async () => {
    /*
     * The pipe reports both directions on one callback. If the transport did
     * not filter on direction, the write above would come back as its own
     * reply and every request would resolve with what it just sent.
     */
    const ok = await getOnlyKey();
    const seen: Uint8Array[] = [];
    ok.transport.on('report', (e: {data: Uint8Array}) => seen.push(e.data));

    await ok.transport.write(IFACE.VENDOR, Uint8Array.from([1, 2, 3]));
    expect(seen).toHaveLength(0);

    __okEmu.emitStream('aabbcc', {iface: IFACE.VENDOR});
    expect(seen).toHaveLength(1);
  });

  it('debug output reaches the library as text with padding stripped', async () => {
    // The PIN flow is driven entirely by matching these lines, and a trailing
    // NUL makes a prompt fail to match something that is plainly there.
    const ok = await getOnlyKey();
    const lines: string[] = [];
    ok.transport.on('log', (e: {text: string}) => lines.push(e.text));

    // "Enter PIN" followed by NUL padding, as hidprint() sends it.
    const padded = '456e7465722050494e' + '00'.repeat(32);
    __okEmu.emitStream(padded, {iface: IFACE.SEREMU});

    expect(lines).toEqual(['Enter PIN']);
  });
});
