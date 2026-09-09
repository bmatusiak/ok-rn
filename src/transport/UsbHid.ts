import {bytes as okbytes} from 'node-onlykey-lib';
import NativeUsbHid from '../../specs/NativeUsbHid';
import type {
  ConnectResult,
  DataEvent,
  StatusEvent,
  Transport,
  UsbDeviceInfo,
} from '../../specs/NativeUsbHid';
import {encodeFrames, FrameAssembler, HID_REPORT_SIZE, type Frame} from './framing';

export type {ConnectResult, DataEvent, StatusEvent, Transport, UsbDeviceInfo};

/** OnlyKey USB ids. Override via connect() if you are targeting other hardware. */
export const ONLYKEY_VENDOR_ID = 0x1d50;
export const ONLYKEY_PRODUCT_ID = 0x60fc;

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export type UsbHidEvents = {
  status: (event: {state: ConnectionState; transport: string; message: string}) => void;
  /** Every raw report, before framing. Useful for a byte-level log view. */
  packet: (bytes: Uint8Array) => void;
  /** A reassembled CTAPHID message. */
  message: (frame: Frame) => void;
};

type Listener<K extends keyof UsbHidEvents> = UsbHidEvents[K];

/**
 * Thin, typed facade over the NativeUsbHid TurboModule.
 *
 * Owns the FrameAssembler so callers get whole messages, and normalises the
 * native `state` string into the ConnectionState union.
 */
class UsbHidClient {
  private readonly assembler = new FrameAssembler(HID_REPORT_SIZE);
  private readonly listeners = new Map<keyof UsbHidEvents, Set<Function>>();
  private packetSize = HID_REPORT_SIZE;
  private nativeSubs: Array<{remove: () => void}> = [];
  private started = false;

  /** Idempotent; safe to call from every mounting hook. */
  private ensureSubscribed(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    this.nativeSubs.push(
      NativeUsbHid.onStatus((event: StatusEvent) => {
        if (event.state === 'disconnected' || event.state === 'error') {
          this.assembler.reset();
        }
        this.emit('status', {
          state: event.state as ConnectionState,
          transport: event.transport,
          message: event.message,
        });
      }),
    );

    this.nativeSubs.push(
      NativeUsbHid.onData((event: DataEvent) => {
        const bytes = okbytes.fromHex(event.hex);
        this.emit('packet', bytes);
        const frame = this.assembler.push(bytes);
        if (frame) {
          this.emit('message', frame);
        }
      }),
    );
  }

  on<K extends keyof UsbHidEvents>(event: K, listener: Listener<K>): () => void {
    this.ensureSubscribed();
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }

  private emit<K extends keyof UsbHidEvents>(
    event: K,
    ...args: Parameters<Listener<K>>
  ): void {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    for (const fn of set) {
      (fn as (...a: unknown[]) => void)(...args);
    }
  }

  setTransport(transport: Transport): void {
    NativeUsbHid.setTransport(transport);
  }

  getTransport(): Transport {
    return NativeUsbHid.getTransport() as Transport;
  }

  configureTcp(host: string, port: number): void {
    NativeUsbHid.configureTcp(host, port);
  }

  listDevices(): Promise<UsbDeviceInfo[]> {
    return NativeUsbHid.listDevices();
  }

  requestPermission(
    vendorId: number = ONLYKEY_VENDOR_ID,
    productId: number = ONLYKEY_PRODUCT_ID,
  ): Promise<boolean> {
    return NativeUsbHid.requestPermission(vendorId, productId);
  }

  async connect(
    vendorId: number = ONLYKEY_VENDOR_ID,
    productId: number = ONLYKEY_PRODUCT_ID,
  ): Promise<ConnectResult> {
    this.ensureSubscribed();
    this.assembler.reset();
    const result = await NativeUsbHid.connect(vendorId, productId);
    this.packetSize = result.packetSize > 0 ? result.packetSize : HID_REPORT_SIZE;
    return result;
  }

  disconnect(): Promise<void> {
    this.assembler.reset();
    return NativeUsbHid.disconnect();
  }

  isConnected(): boolean {
    return NativeUsbHid.isConnected();
  }

  /** Write one raw, already-sized report. */
  writeRaw(bytes: Uint8Array): Promise<number> {
    return NativeUsbHid.write(okbytes.toHex(bytes));
  }

  /** Frame a message as CTAPHID INIT/CONT packets and write each one. */
  async sendMessage(frame: Frame): Promise<void> {
    const packets = encodeFrames(frame, this.packetSize);
    for (const packet of packets) {
      await NativeUsbHid.write(okbytes.toHex(packet));
    }
  }

  getPacketSize(): number {
    return this.packetSize;
  }

  /** Tear down native subscriptions. Only for tests / full app teardown. */
  destroy(): void {
    for (const sub of this.nativeSubs) {
      sub.remove();
    }
    this.nativeSubs = [];
    this.listeners.clear();
    this.started = false;
  }
}

export const UsbHid = new UsbHidClient();
export default UsbHid;
