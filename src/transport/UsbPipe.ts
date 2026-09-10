import NativeUsbHid from '../../specs/NativeUsbHid';
import type {
  ConnectResult,
  DataEvent,
  StatusEvent,
  UsbDeviceInfo,
  UsbInterfaceInfo,
} from '../../specs/NativeUsbHid';
import {bytes as okbytes, transport as oktransport} from 'node-onlykey-lib';

const {IFACE, DIR} = oktransport;

/**
 * A real OnlyKey over USB OTG, shaped exactly like the soft key's pipe.
 *
 * `OkEmu` and this are the two byte pipes the library's transport plugins
 * consume, and they present the SAME five methods for the same reason the
 * library exists at all: everything above them - the session, the device
 * plugin, the crypto plugin, every screen - is then written once and works
 * against either key.
 *
 *     start()                 open the device
 *     stop()                  release it
 *     isRunning()             boolean
 *     write(iface, bytes)     host -> device
 *     on('stream', listener)  every report, BOTH directions
 *
 * ## Why it reports both directions when USB only shows one
 *
 * A USB transport physically sees inbound reports only; our own writes never
 * come back. The emulator's pipe sees both, because it sits inside the process
 * where the firmware runs.
 *
 * Rather than make the library plugin cope with a pipe that is half silent,
 * this ECHOES each successful write as host-bound traffic. That keeps one
 * plugin serving both pipes, keeps the byte-level log symmetric, and keeps the
 * `write` event alive for anything watching the bus.
 *
 * The echo is emitted AFTER the native promise resolves. A write that failed -
 * an interface this device does not carry, a report too wide for its endpoint -
 * must not appear in a trace as though it went out.
 *
 * ## DIR IS NOT THE USB CONVENTION
 *
 * In this library `DIR.OUT` means DEVICE TO HOST and `DIR.IN` means host to
 * device. That reads backwards if you come from USB, where the direction is
 * named from the host's point of view. It matches the emulator's HAL, which is
 * where the numbering came from, and changing it here would mean two conventions
 * in one codebase.
 */

type StreamEvent = {iface: number; dir: number; bytes: Uint8Array};
type StreamListener = (event: StreamEvent) => void;
type StatusListener = (event: StatusEvent) => void;

/** OnlyKey USB ids, from the library so this file cannot drift from it. */
export const {VENDOR_ID, PRODUCT_ID} = oktransport.usb;

class UsbPipeClient {
  private streamListeners = new Set<StreamListener>();
  private statusListeners = new Set<StatusListener>();
  private nativeSubs: Array<{remove: () => void}> = [];
  private subscribed = false;

  /** What the device turned out to carry. Empty until start() succeeds. */
  private openInterfaces: UsbInterfaceInfo[] = [];

  /** Report width of the RawHID interfaces; what the debug panel displays. */
  private packet = 64;

  private ensureSubscribed(): void {
    if (this.subscribed) {
      return;
    }
    this.subscribed = true;

    this.nativeSubs.push(
      NativeUsbHid.onData((event: DataEvent) => {
        this.emitStream({
          iface: event.iface,
          /* Inbound. Device to host, which this library calls OUT. */
          dir: DIR.OUT,
          bytes: okbytes.fromHex(event.hex),
        });
      }),
    );

    this.nativeSubs.push(
      NativeUsbHid.onStatus((event: StatusEvent) => {
        /*
         * A device that went away has no interfaces, and leaving the old list
         * in place would let a caller believe it still had a vendor endpoint.
         */
        if (event.state === 'disconnected' || event.state === 'error') {
          this.openInterfaces = [];
        }
        for (const listener of this.statusListeners) listener(event);
      }),
    );
  }

  private emitStream(event: StreamEvent): void {
    for (const listener of this.streamListeners) listener(event);
  }

  /* ---- the pipe contract --------------------------------------------- */

  /**
   * Open the key.
   *
   * Permission is requested first because the claim cannot happen without it.
   * Android remembers the grant per device, so this is a prompt once and
   * silence afterwards - and plugging the key in raises it anyway, since the
   * manifest carries a USB-attached filter for these ids.
   */
  async start(): Promise<ConnectResult> {
    this.ensureSubscribed();
    NativeUsbHid.setTransport('usb');

    const granted = await NativeUsbHid.requestPermission(VENDOR_ID, PRODUCT_ID);
    if (!granted) {
      throw new Error(
        'USB permission was refused, so the key cannot be opened. Android asks ' +
          'when it is plugged in; accept it and try again.',
      );
    }

    const result = await NativeUsbHid.connect(VENDOR_ID, PRODUCT_ID);
    this.openInterfaces = result.interfaces ?? [];
    this.packet = result.packetSize > 0 ? result.packetSize : 64;
    return result;
  }

  async stop(): Promise<void> {
    this.openInterfaces = [];
    await NativeUsbHid.disconnect();
  }

  isRunning(): boolean {
    return NativeUsbHid.isConnected();
  }

  /**
   * Host to device, on one interface.
   *
   * NO REPORT ID, on either side. A desktop client speaking through hidapi or
   * chrome.hid prepends a zero byte, because those APIs use it to select a
   * report. Android's bulkTransfer writes to the endpoint directly with no HID
   * layer in between, so a leading byte here would shift every field along and
   * the firmware would read our message id as its header - a message that is
   * half received rather than an error.
   *
   * Padding is the native side's business too: it knows each endpoint's width,
   * and the debug console's is 32 where everything else is 64.
   */
  async write(iface: number, bytes: Uint8Array): Promise<number> {
    const written = await NativeUsbHid.write(iface, okbytes.toHex(bytes));

    /* Echoed only now it is known to have gone out. See the class header. */
    this.emitStream({iface, dir: DIR.IN, bytes});
    return written;
  }

  on(event: 'stream', listener: StreamListener): () => void;
  on(event: 'status', listener: StatusListener): () => void;
  on(event: 'stream' | 'status', listener: any): () => void {
    this.ensureSubscribed();
    const set = event === 'stream' ? this.streamListeners : this.statusListeners;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /* ---- beyond the contract, for the byte-level panel ------------------ */

  /**
   * What was opened, and how each interface was identified.
   *
   * `identifiedBy` is the field worth reading: anything but `usagePage` means
   * the transport guessed, and three of this device's interfaces are identical
   * in every other respect.
   */
  interfaces(): UsbInterfaceInfo[] {
    return this.openInterfaces;
  }

  /** True when the device carries an interface, so a caller can hide a control. */
  carries(iface: number): boolean {
    return this.openInterfaces.some(i => i.iface === iface);
  }

  getPacketSize(): number {
    return this.packet;
  }

  listDevices(): Promise<UsbDeviceInfo[]> {
    return NativeUsbHid.listDevices();
  }

  /** Tear down native subscriptions. Only for tests and full app teardown. */
  destroy(): void {
    for (const sub of this.nativeSubs) sub.remove();
    this.nativeSubs = [];
    this.streamListeners.clear();
    this.statusListeners.clear();
    this.subscribed = false;
  }
}

export const UsbPipe = new UsbPipeClient();
export default UsbPipe;
export {IFACE, DIR};
export type {ConnectResult, UsbDeviceInfo, UsbInterfaceInfo};
