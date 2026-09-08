/**
 * TurboModuleRegistry.getEnforcing throws when the native module is absent,
 * which it always is under Jest. Both specs are mocked here so component tests
 * can import the app without a native runtime.
 */

const noopSubscription = {remove: () => {}};

jest.mock('./specs/NativeUsbHid', () => ({
  __esModule: true,
  default: {
    setTransport: jest.fn(),
    getTransport: jest.fn(() => 'auto'),
    configureTcp: jest.fn(),
    listDevices: jest.fn(() => Promise.resolve([])),
    requestPermission: jest.fn(() => Promise.resolve(true)),
    connect: jest.fn(() =>
      Promise.resolve({transport: 'tcp', vendorId: 0, productId: 0, packetSize: 64}),
    ),
    disconnect: jest.fn(() => Promise.resolve()),
    isConnected: jest.fn(() => false),
    write: jest.fn(() => Promise.resolve(64)),
    onStatus: jest.fn(() => noopSubscription),
    onData: jest.fn(() => noopSubscription),
  },
}));

jest.mock('./specs/NativeFidoGatt', () => ({
  __esModule: true,
  default: {
    isSupported: jest.fn(() => Promise.resolve(true)),
    requestPermissions: jest.fn(() => Promise.resolve(true)),
    configure: jest.fn(),
    startAdvertising: jest.fn(() => Promise.resolve()),
    stopAdvertising: jest.fn(() => Promise.resolve()),
    getState: jest.fn(() => 'idle'),
    respondToRequest: jest.fn(() => Promise.resolve()),
    createCredential: jest.fn(() => Promise.resolve('aabb')),
    signWithCredential: jest.fn(() => Promise.resolve('ccdd')),
    onGattStatus: jest.fn(() => noopSubscription),
    onCtapRequest: jest.fn(() => noopSubscription),
  },
}));

/*
 * NativeOkEmu was missing from this file, so any test importing the soft-key
 * transport threw from TurboModuleRegistry.getEnforcing before reaching a
 * single assertion. That is why there are no transport tests.
 *
 * Unlike the two above, this mock is DRIVABLE: it keeps the registered stream
 * listener and exposes __emitStream so a test can push a device report back.
 * A mock that only records calls can prove a message was written but never
 * that the reply was parsed, which is where protocol bugs actually live.
 */
const okEmuListeners = {stream: [], led: [], restart: []};

const subscribe = (bucket) => (cb) => {
  bucket.push(cb);
  return {
    remove: () => {
      const at = bucket.indexOf(cb);
      if (at !== -1) bucket.splice(at, 1);
    },
  };
};

global.__okEmu = {
  listeners: okEmuListeners,
  /** Push a device->host report. `hex` is the payload, `iface` defaults to VENDOR. */
  emitStream(hex, {iface = 2, dir = 0} = {}) {
    const event = {iface, dir, hex, length: hex.length / 2};
    for (const cb of [...okEmuListeners.stream]) cb(event);
  },
  emitLed(pixels) {
    for (const cb of [...okEmuListeners.led]) cb({pixels});
  },
  reset() {
    okEmuListeners.stream.length = 0;
    okEmuListeners.led.length = 0;
    okEmuListeners.restart.length = 0;
  },
};

jest.mock('./specs/NativeOkEmu', () => ({
  __esModule: true,
  default: {
    isAvailable: jest.fn(() => true),
    isRunning: jest.fn(() => true),
    start: jest.fn(() =>
      Promise.resolve({started: true, message: '', storageDir: '/mock/okemu'}),
    ),
    stop: jest.fn(() => Promise.resolve()),
    factoryReset: jest.fn(() => Promise.resolve()),
    // Never resolves in the app either - the process is gone.
    restartApp: jest.fn(() => new Promise(() => {})),
    writeHid: jest.fn(() => Promise.resolve(64)),
    setButton: jest.fn(() => Promise.resolve()),
    kbdSetReport: jest.fn(() => Promise.resolve()),
    kbdGetReport: jest.fn(() => Promise.resolve('')),
    /*
     * Rejects, because the real one does: the firmware thread only exits
     * through the AIRCR trap, so there is no in-process restart. A mock that
     * resolved here would let code ship that cannot work on a device.
     */
    restart: jest.fn(() =>
      Promise.reject(
        Object.assign(new Error('in-process firmware restart is not implemented'), {
          code: 'ERR_EMU_RESTART_UNSUPPORTED',
        }),
      ),
    ),
    onStream: jest.fn(subscribe(okEmuListeners.stream)),
    onLed: jest.fn(subscribe(okEmuListeners.led)),
    onRestartRequested: jest.fn(subscribe(okEmuListeners.restart)),
  },
}));
