import NativeOkEmu from '../../specs/NativeOkEmu';
import type {LedEvent, StartResult, StreamEvent} from '../../specs/NativeOkEmu';
import {bytesToHex, hexToBytes} from './hex';

export type {LedEvent, StartResult, StreamEvent};

/**
 * usb_desc.h interface numbers. The firmware routes its replies by these, so
 * they are protocol, not an implementation detail.
 */
export const IFACE = {
  KEYBOARD: 0,
  FIDO: 1,
  VENDOR: 2,
  /** Debug serial. Only present in DEBUG firmware builds - 4 interfaces, not 3. */
  SEREMU: 3,
} as const;

export type Iface = (typeof IFACE)[keyof typeof IFACE];

export const DIR = {
  /** device to host */
  OUT: 0,
  /** host to device */
  IN: 1,
} as const;

export type OkEmuEvents = {
  /** Every report on every interface, both directions - the full bus trace. */
  stream: (event: {iface: number; dir: number; bytes: Uint8Array}) => void;
  /** Reports the firmware sent us on a given interface. */
  report: (event: {iface: number; bytes: Uint8Array}) => void;
  /** NeoPixel state, one packed 0x00RRGGBB entry per pixel. */
  led: (pixels: number[]) => void;
  /** The firmware executed CPU_RESTART(). */
  restartRequested: () => void;
};

type Listener<K extends keyof OkEmuEvents> = OkEmuEvents[K];

/**
 * The soft key: the OnlyKey firmware running in-process.
 *
 * Byte-level only, on purpose. This is the same firmware a physical OnlyKey
 * runs, so the protocol layered on top is the same one the USB transport
 * speaks - it belongs above this, not inside it.
 */
class OkEmuClient {
  private readonly listeners = new Map<keyof OkEmuEvents, Set<Function>>();
  private nativeSubs: Array<{remove: () => void}> = [];
  private started = false;

  private ensureSubscribed(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    this.nativeSubs.push(
      NativeOkEmu.onStream((event: StreamEvent) => {
        const bytes = hexToBytes(event.hex);
        this.emit('stream', {iface: event.iface, dir: event.dir, bytes});
        if (event.dir === DIR.OUT) {
          this.emit('report', {iface: event.iface, bytes});
        }
      }),
    );

    this.nativeSubs.push(
      NativeOkEmu.onLed((event: LedEvent) => {
        this.emit('led', event.pixels);
      }),
    );

    this.nativeSubs.push(
      NativeOkEmu.onRestartRequested(() => {
        this.emit('restartRequested');
      }),
    );
  }

  on<K extends keyof OkEmuEvents>(event: K, listener: Listener<K>): () => void {
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

  private emit<K extends keyof OkEmuEvents>(
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

  /** False when libokemu.so was not built for this ABI. */
  isAvailable(): boolean {
    return NativeOkEmu.isAvailable();
  }

  isRunning(): boolean {
    return NativeOkEmu.isRunning();
  }

  async start(): Promise<StartResult> {
    this.ensureSubscribed();
    return NativeOkEmu.start();
  }

  stop(): Promise<void> {
    return NativeOkEmu.stop();
  }

  /** Stop and boot again against the same storage - the firmware's CPU_RESTART(). */
  /** Relaunch the app process. Never returns on success. */
  restartApp(): Promise<void> {
    return NativeOkEmu.restartApp();
  }

  restart(): Promise<StartResult> {
    this.ensureSubscribed();
    return NativeOkEmu.restart();
  }

  /** Erases flash and EEPROM. Irreversible. */
  factoryReset(): Promise<void> {
    return NativeOkEmu.factoryReset();
  }

  write(iface: Iface, bytes: Uint8Array): Promise<number> {
    return NativeOkEmu.writeHid(iface, bytesToHex(bytes));
  }

  /** Yubikey OTP / HMAC-SHA1, which rides keyboard control transfers. */
  /** Hold or release a touch button. Timing is the caller's. */
  setButton(button: number, down: boolean): Promise<void> {
    this.ensureSubscribed();
    return NativeOkEmu.setButton(button, down);
  }

  /**
   * A complete press: hold, wait, release.
   *
   * The DURATION is the meaning. The firmware bands on how long a button was
   * held - a tap under 20 ticks, a hold past 72, a long hold past 180, and 360
   * for factory default - so the same button says different things depending
   * only on this number. The default is a plain tap, which is what confirming a
   * FIDO2 ceremony wants.
   */
  async pressButton(button: number, holdMs = 120): Promise<void> {
    await this.setButton(button, true);
    await new Promise<void>(resolve => {
      setTimeout(resolve, holdMs);
    });
    await this.setButton(button, false);
  }

  kbdSetReport(bytes: Uint8Array): Promise<void> {
    return NativeOkEmu.kbdSetReport(bytesToHex(bytes));
  }

  async kbdGetReport(): Promise<Uint8Array> {
    return hexToBytes(await NativeOkEmu.kbdGetReport());
  }

  /**
   * Waits for the next report on `iface`.
   *
   * The subscription is attached before the caller's write goes out - callers
   * must set this up first and await it after, or a fast reply lands before
   * anyone is listening.
   */
  nextReport(iface: Iface, timeoutMs = 3000): Promise<Uint8Array> {
    this.ensureSubscribed();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`no report on interface ${iface} within ${timeoutMs}ms`));
      }, timeoutMs);

      const off = this.on('report', event => {
        if (event.iface !== iface) {
          return;
        }
        clearTimeout(timer);
        off();
        resolve(event.bytes);
      });
    });
  }

  destroy(): void {
    for (const sub of this.nativeSubs) {
      sub.remove();
    }
    this.nativeSubs = [];
    this.listeners.clear();
    this.started = false;
  }
}

export const OkEmu = new OkEmuClient();
export default OkEmu;
