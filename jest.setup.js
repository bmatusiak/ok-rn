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
