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
  /** Lowercase hex, no separators. One raw HID report / TCP chunk. */
  hex: string;
  /** Byte length of `hex` decoded; == hex.length / 2. */
  length: number;
};

export type ConnectResult = {
  transport: string;
  vendorId: number;
  productId: number;
  /** Endpoint max packet size; the report buffer size to expect on reads. */
  packetSize: number;
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
  write(hex: string): Promise<number>;

  readonly onStatus: CodegenTypes.EventEmitter<StatusEvent>;
  readonly onData: CodegenTypes.EventEmitter<DataEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeUsbHid');
