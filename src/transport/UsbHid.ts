import NativeUsbHid from '../../specs/NativeUsbHid';
import type {
  ConnectResult,
  DataEvent,
  StatusEvent,
  Transport,
  UsbDeviceInfo,
} from '../../specs/NativeUsbHid';
import {bytes as okbytes, protocol, transport as oktransport} from 'node-onlykey-lib';

/*
 * The interface numbers are the LIBRARY’S, which are the firmware’s own.
 * Taken from there rather than written out here, so this file cannot drift
 * from the transport that routes on them.
 */
const {IFACE} = oktransport;

const {Assembler, frame: encodeFrames, cidNumber, PACKET_SIZE} = protocol.ctaphid;

/**
 * A whole CTAPHID message, as the library's assembler hands it over.
 *
 * `src/transport/framing.ts` used to define this alongside a second copy of
 * the framing itself. Both are gone; the shape is the library's, so a message
 * crosses this boundary without being renamed on the way.
 */
export type Frame = {cid: Uint8Array; cmd: number; payload: Uint8Array};

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
 * Owns the assembler so callers get whole messages, and normalises the native
 * `state` string into the ConnectionState union.
 */
class UsbHidClient {
  /*
   * REBUILT on connect, not built once.
   *
   * A USB endpoint reports its own packet size, and this used to send at that
   * size while reassembling at 64 - so against any endpoint that is not 64 the
   * two ends disagreed about where a payload starts. See
   * FINDING-the-usb-assembler-ignored-the-endpoints-packet-size.md.
   */
  private assembler = new Assembler({packetSize: PACKET_SIZE});
  private readonly listeners = new Map<keyof UsbHidEvents, Set<Function>>();
  private packetSize: number = PACKET_SIZE;
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
    this.packetSize = result.packetSize > 0 ? result.packetSize : PACKET_SIZE;
    this.assembler = new Assembler({packetSize: this.packetSize});
    return result;
  }

  disconnect(): Promise<void> {
    this.assembler.reset();
    return NativeUsbHid.disconnect();
  }

  isConnected(): boolean {
    return NativeUsbHid.isConnected();
  }

  /**
   * Write one raw, already-sized report to one interface.
   *
   * Defaults to the security-key interface, which is what every existing
   * caller meant when there was only one to write to. The parameter is what
   * lets the byte-level panel reach the vendor and debug interfaces, which
   * is how the verification ladder is driven by hand.
   */
  writeRaw(bytes: Uint8Array, iface: number = IFACE.FIDO): Promise<number> {
    return NativeUsbHid.write(iface, okbytes.toHex(bytes));
  }

  /** Frame a message as CTAPHID INIT/CONT packets and write each one. */
  async sendMessage(frame: {cid: Uint8Array | number; cmd: number; payload: Uint8Array}): Promise<void> {
    const packets = encodeFrames(frame.cid, frame.cmd, frame.payload, this.packetSize);
    for (const packet of packets) {
      await NativeUsbHid.write(IFACE.FIDO, okbytes.toHex(packet));
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
