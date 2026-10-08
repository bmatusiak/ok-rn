/**
 * TurboModuleRegistry.getEnforcing throws when the native module is absent,
 * which it always is under Jest. EVERY spec in `specs/` is mocked here so
 * component tests can import the app without a native runtime.
 *
 * "Every" is load-bearing. This file once said "both specs" and mocked two of
 * them; three more specs were added later and none was mocked, so the App smoke
 * test - the only test that renders the whole app - died at the first import of
 * an unmocked one and stayed dead. Adding a spec means adding it here.
 * See FINDING-the-app-smoke-test-died-when-specs-outgrew-their-mocks.md.
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
      Promise.resolve({
        transport: 'tcp',
        vendorId: 0,
        productId: 0,
        packetSize: 64,
        // The tcp mock carries one synthetic interface; a real key reports
        // three or four depending on its build.
        interfaces: [],
      }),
    ),
    disconnect: jest.fn(() => Promise.resolve()),
    isConnected: jest.fn(() => false),
    // write(iface, hex) - the interface number comes first.
    write: jest.fn((_iface, _hex) => Promise.resolve(64)),
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
    sendKeepAlive: jest.fn(() => Promise.resolve()),
    sendVendorReport: jest.fn(() => Promise.resolve()),
    sendVendorFrame: jest.fn(() => Promise.resolve()),
    disconnectCentral: jest.fn(() => Promise.resolve(false)),
    fidoHandle: jest.fn(() => -1),
    fidoKnownHandle: jest.fn(() => -1),
    setIoPolicy: jest.fn(),
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
    /* nothing waits: the firmware's confirmation state reads 0 (okemu_jni.cpp nativeConfirmState) */
    confirmState: jest.fn(() => Promise.resolve(0)),
    /* the app's own "answer me" for PressAlert (the Edge approval sheet) */
    setAttention: jest.fn(),
    hushPress: jest.fn(),
    markSplashDone: jest.fn(),
    splashDoneThisProcess: jest.fn(() => false),
    debuggingOn: jest.fn(() => false),
    /* the folder of the slot it was given, as the native module answers (src/net.ts reads the net from it) */
    start: jest.fn(slot =>
      Promise.resolve({started: true, message: '', storageDir: slot ? '/mock/okemu/' + slot : '/mock/okemu'}),
    ),
    deleteSlot: jest.fn(() => Promise.resolve()),
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
    onPluginEvent: jest.fn(() => ({remove: () => {}})),
    onRestartRequested: jest.fn(subscribe(okEmuListeners.restart)),
  },
}));

jest.mock('./specs/NativeSecrets', () => ({
  __esModule: true,
  default: {
    copySensitive: jest.fn(() => Promise.resolve(true)),
    clearClipboard: jest.fn(() => Promise.resolve(true)),
    setScreenshotsBlocked: jest.fn(() => Promise.resolve()),
    screenshotsBlocked: jest.fn(() => Promise.resolve(false)),
    /*
     * 'no-hardware' rather than 'available', so a component test never renders
     * a path that would prompt on a real phone.
     */
    biometricStatus: jest.fn(() => Promise.resolve('no-hardware')),
    biometricHas: jest.fn(() => Promise.resolve(false)),
    biometricStore: jest.fn(() => Promise.resolve(true)),
    biometricLoad: jest.fn(() => Promise.reject(new Error('nothing is stored'))),
    biometricForget: jest.fn(() => Promise.resolve(true)),
    /* a box that only reverses the hex: enough to prove nothing reaches storage in the clear */
    boxSeal: jest.fn((alias, hex) => Promise.resolve('b0' + hex.split('').reverse().join(''))),
    boxOpen: jest.fn((alias, hex) => hex.startsWith('b0')
      ? Promise.resolve(hex.slice(2).split('').reverse().join(''))
      : Promise.reject(new Error('boxOpen failed'))),
    boxForget: jest.fn(() => Promise.resolve(true)),
  },
}));

jest.mock('./specs/NativeShare', () => ({
  __esModule: true,
  default: {
    shareFile: jest.fn(() => Promise.resolve(true)),
    clearShared: jest.fn(() => Promise.resolve(0)),
    pickTextFile: jest.fn(() =>
      Promise.resolve({picked: false, name: '', content: ''}),
    ),
  },
}));

jest.mock('./specs/NativeKdf', () => ({
  __esModule: true,
  default: {pbkdf2Sha256: jest.fn(() => Promise.reject(new Error('no native PBKDF2 in jest')))},
}));

jest.mock('./specs/NativeOkSsl', () => ({
  __esModule: true,
  default: {
    version: jest.fn(() => Promise.reject(new Error('no OpenSSL in jest'))),
    randStatus: jest.fn(() => Promise.reject(new Error('no OpenSSL in jest'))),
    randomBytes: jest.fn(() => Promise.reject(new Error('no OpenSSL in jest'))),
  },
}));

jest.mock('./specs/NativeRsaGen', () => ({
  __esModule: true,
  default: {generatePrimes: jest.fn(() => Promise.reject(new Error('no RSA generator in jest')))},
}));

jest.mock('./specs/NativeEdgeAlert', () => ({
  __esModule: true,
  default: {post: jest.fn(), takeOpenedSeq: jest.fn(() => -1), beat: jest.fn(), setWatching: jest.fn(), takeHoldRequest: jest.fn(() => false), onHoldRequested: jest.fn(() => ({remove: jest.fn()})), onWatchTick: jest.fn(() => ({remove: jest.fn()}))},
}));

jest.mock('./specs/NativeCredProvider', () => ({
  __esModule: true,
  default: {
    providerStatus: jest.fn(() =>
      Promise.resolve({supported: false, enabled: false, settingsAvailable: false}),
    ),
    openProviderSettings: jest.fn(() => Promise.resolve(false)),
    getPendingRequest: jest.fn(() =>
      Promise.resolve({action: 'NONE', callerPackage: '', requestJson: '', clientDataHashB64: ''}),
    ),
    respond: jest.fn(() => Promise.resolve(true)),
    fail: jest.fn(() => Promise.resolve(true)),
  },
}));

jest.mock('./specs/NativeBtKeyboard', () => ({
  __esModule: true,
  default: {
    isSupported: jest.fn(() => Promise.resolve(true)),
    requestPermissions: jest.fn(() => Promise.resolve(true)),
    register: jest.fn(() => Promise.resolve(true)),
    unregister: jest.fn(() => Promise.resolve()),
    requestDiscoverable: jest.fn(() => Promise.resolve(true)),
    localName: jest.fn(() => Promise.resolve('test')),
    hosts: jest.fn(() => Promise.resolve([])),
    connect: jest.fn(() => Promise.resolve(true)),
    disconnect: jest.fn(() => Promise.resolve()),
    sendReport: jest.fn(() => Promise.resolve(true)),
    onStatus: jest.fn(() => noopSubscription),
  },
}));

/*
 * AsyncStorage, which the host plugin is given as its persistent store.
 *
 * The package ships ESM that Jest does not transform, so importing it from
 * src/onlykey.ts took down every suite that reaches the app - onlykey.test.ts
 * and the App smoke test both stopped RUNNING rather than failing, which reads
 * as a smaller problem in the summary line than it is.
 *
 * The package ships its own in-memory mock for exactly this, and using theirs
 * rather than a hand-written one means it keeps up with their API.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest'),
);
