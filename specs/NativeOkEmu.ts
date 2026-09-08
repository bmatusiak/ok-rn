import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';
import type {CodegenTypes} from 'react-native';

/**
 * The soft key: the real OnlyKey firmware, compiled for Android and running
 * in-process. See android/okemu.
 *
 * This is not a simulation of an OnlyKey - it is the same C that runs on the
 * hardware, with its peripherals stubbed and its flash and EEPROM backed by
 * files in the app sandbox. Behaviour, key derivation and the backup format
 * are therefore identical to a physical key by construction, which is what
 * makes restoring a hardware backup into the soft key meaningful.
 *
 * The firmware exposes the same four USB interfaces it does on the device.
 * Nothing here interprets them: this module moves bytes, and the protocol
 * lives in JS.
 */

/** usb_desc.h interface numbers, shared by the firmware and its descriptors. */
export type Iface = 0 | 1 | 2 | 3;

export type StreamEvent = {
  /** 0 keyboard, 1 FIDO, 2 vendor raw-HID, 3 debug serial (DEBUG builds only). */
  iface: number;
  /** 0 = device to host, 1 = host to device. */
  dir: number;
  /** Lowercase hex, no separators. */
  hex: string;
  length: number;
};

export type LedEvent = {
  /** One packed 0x00RRGGBB entry per NeoPixel. */
  pixels: number[];
};

export type StartResult = {
  started: boolean;
  /** Empty when started; otherwise why not. */
  message: string;
  /** Where flash.bin and eeprom.bin live. */
  storageDir: string;
};

export interface Spec extends TurboModule {
  /**
   * Whether libokemu.so could be loaded at all. False on an ABI we did not
   * build for, which is a different failure from the firmware not booting.
   */
  isAvailable(): boolean;

  /**
   * Boots the firmware. Idempotent: resolves with started=false and a reason
   * if it is already running.
   */
  start(): Promise<StartResult>;
  stop(): Promise<void>;
  isRunning(): boolean;

  /** Write one report to an interface. `hex` must be even-length. */
  writeHid(iface: number, hex: string): Promise<number>;

  /** Yubikey OTP / HMAC-SHA1, which rides keyboard control transfers. */
  /**
   * Hold (`down: true`) or release one of the six touch buttons.
   *
   * A press is a hold then a release, and the time between them is what the
   * firmware bands on - a tap, a hold, a long hold - so the caller owns the
   * timing. This is how a ceremony gets confirmed on a phone that has no
   * buttons; every FIDO2 signing operation waits on one.
   */
  setButton(button: number, down: boolean): Promise<void>;

  kbdSetReport(hex: string): Promise<void>;
  kbdGetReport(): Promise<string>;

  /**
   * Erases flash and EEPROM. Irreversible, and the caller is expected to have
   * already confirmed with the user.
   */
  factoryReset(): Promise<void>;

  /**
   * Relaunch the app process.
   *
   * The only way back from a firmware that has ended itself. Its thread exits
   * through the AIRCR trap and cannot be replaced in this process - the
   * firmware is linked statically into the same .so as this module, so there is
   * no way to reset its globals short of a new process, and resetting them by
   * hand would mean changing firmware that is meant to stay original.
   *
   * Never resolves on success, because the process is gone.
   */
  restartApp(): Promise<void>;

  /** Stop, then boot again against the same storage - the firmware's CPU_RESTART(). */
  restart(): Promise<StartResult>;

  readonly onStream: CodegenTypes.EventEmitter<StreamEvent>;
  readonly onLed: CodegenTypes.EventEmitter<LedEvent>;
  readonly onRestartRequested: CodegenTypes.EventEmitter<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeOkEmu');
