import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';
import type {CodegenTypes} from 'react-native';

/**
 * Transport selection.
 *   'auto' - TCP mock when running a debug build on an emulator, USB otherwise
 *   'usb'  - force android.hardware.usb (UsbManager) host mode over OTG
 *   'tcp'  - force the Node.js hardware emulator in tools/hardware-emulator.js
 */
export type Transport = 'auto' | 'usb' | 'tcp';

export type UsbDeviceInfo = {
  deviceName: string;
  vendorId: number;
  productId: number;
  productName: string;
  manufacturerName: string;
  interfaceCount: number;
  hasPermission: boolean;
  /** Widest IN endpoint across all interfaces; 64 means a raw-HID interface exists. */
  maxReportSize: number;
};

export type StatusEvent = {
  /** 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error' */
  state: string;
  /** which transport produced this event: 'usb' | 'tcp' */
  transport: string;
  message: string;
};

export type DataEvent = {
  /**
   * Which OnlyKey interface this report came from.
   *
   * 0 keyboard, 1 security key, 2 vendor, 3 debug console - the library’s
   * IFACE values, which are the firmware’s own interface numbers. A tagged
   * single stream rather than an event per interface, because the library
   * already filters on this field in every reader it has.
   */
  iface: number;
  /** Lowercase hex, no separators. One raw HID report / TCP chunk. */
  hex: string;
  /** Byte length of `hex` decoded; == hex.length / 2. */
  length: number;
};

/**
 * One interface the transport actually opened.
 *
 * `identifiedBy` is the field that matters. Anything other than `usagePage`
 * is a GUESS, and three of this device’s interfaces are identical in every
 * attribute except that - so a guess routes the vendor protocol to the
 * security-key interface, where every request times out and the error blames
 * the device. A host should refuse a session built on one.
 */
export type UsbInterfaceInfo = {
  iface: number;
  /** The device’s own bInterfaceNumber, which need not equal `iface`. */
  interfaceNumber: number;
  usagePage: number;
  usage: number;
  packetSizeIn: number;
  /** 0 when device-to-host only, as the keyboard is. */
  packetSizeOut: number;
  identifiedBy: string;
};

export type ConnectResult = {
  transport: string;
  vendorId: number;
  productId: number;
  /** Endpoint max packet size; the report buffer size to expect on reads. */
  packetSize: number;
  /**
   * What was opened, and how each interface was identified.
   *
   * Empty from the TCP mock, which carries one synthetic interface. A real
   * key reports three on a production build and four on a developer one -
   * the debug console is compiled out of a release.
   */
  interfaces: UsbInterfaceInfo[];
};

export interface Spec extends TurboModule {
  /** Override transport selection. Takes effect on the next connect(). */
  setTransport(transport: string): void;
  getTransport(): string;

  /** Point the TCP transport at the mock server. Emulator hosts use 10.0.2.2. */
  configureTcp(host: string, port: number): void;

  /** USB transport only; returns [] on the TCP transport. */
  listDevices(): Promise<UsbDeviceInfo[]>;

  /**
   * Fire the Android USB permission dialog. Resolves true once the user
   * grants, false if they deny. No-op (resolves true) on the TCP transport.
   */
  requestPermission(vendorId: number, productId: number): Promise<boolean>;

  /** Pass -1 for either id to take the first device matching the other. */
  connect(vendorId: number, productId: number): Promise<ConnectResult>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  /** Write one raw report. `hex` must be an even-length hex string. */
  /**
   * Write one report to one interface.
   *
   * Rejects rather than silently going nowhere when the interface is not
   * carried, has no outbound endpoint (the keyboard), or the report is wider
   * than that endpoint - the debug console is 32 bytes out where everything
   * else is 64, and its writes are not padded.
   */
  write(iface: number, hex: string): Promise<number>;

  readonly onStatus: CodegenTypes.EventEmitter<StatusEvent>;
  readonly onData: CodegenTypes.EventEmitter<DataEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeUsbHid');
