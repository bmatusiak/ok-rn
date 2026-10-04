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

/** A firmware plugin's event (plugins/key_chain: a derived public key, src/keyChainRecorder.ts). */
export type PluginEvent = {
  name: string;
  hex: string;
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
   *
   * `storageSlot` picks WHICH DEVICE this is. flash.bin and eeprom.bin are the
   * device's entire persistent state, and a firmware version reading a
   * different version's flash is not a measurement of either - so a pinned
   * build (OKEMU_VERSION) gets its own subdirectory and finds what it left
   * there. Empty string means the directory the app has always used, which is
   * what an ordinary build passes, so nothing already on a phone moves.
   *
   * Rejected rather than sanitised if it is not a plain name: it becomes a path
   * under the app's own files, and quietly reinterpreting it would put a
   * device's state somewhere its owner did not ask for.
   */
  start(storageSlot: string): Promise<StartResult>;
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

  /**
   * Hold a button for `ticks` firmware main-loop iterations, then release it.
   *
   * The firmware bands a press by ITERATIONS, not by time: <= 20 types the
   * slot, 21..89 types its b profile, and >= 72 stops being a slot read at all
   * and becomes a gesture - backup, lock-and-restart, config mode. A hold
   * timed in milliseconds is therefore a race against how fast this handset
   * runs the loop, with an irreversible action on the losing side. Counting in
   * the emulator makes the band a property of the call.
   *
   * Releases itself; there is no matching "up" call.
   */
  setButtonTicks(button: number, ticks: number): Promise<void>;

  /**
   * Queue presses to be HANDED to the firmware instead of sensed.
   *
   * The other way to press is setButtonTicks, which emulates a finger: the pad
   * reads high for N rounds and touch_sense_loop() counts them. A round only
   * happens when SoftTimer runs checkKey(), and `#define TIME_POLL 50` - so a
   * ten-tick tap plus the four idle rounds the firmware needs to see the
   * release is fourteen scheduler periods. Measured at 757-855ms for ONE
   * press, which made a seven-digit PIN a five-second act.
   *
   * This writes the duration into the loop instead. `key_press` IS what
   * touch_sense_loop returns and payload() bands on, so the press means
   * exactly what its tick count says - there is simply nothing to sense.
   *
   * Nothing here is the firmware's DEBUG console. That parser lives behind
   * `#ifdef DEBUG`, exists only in the development tree, and reads a Serial
   * channel a production build does not compile. See android/okemu/src/
   * okemu_press.h.
   *
   * @param buttons one digit per press, '1'-'6'; a whole PIN in one call.
   * @param ticks the duration every one of them gets.
   * @returns how many were accepted - short means the queue was full.
   */
  pressQueue(buttons: string, ticks: number): Promise<number>;

  /** Queued but not yet taken by the loop. 0 means the firmware has them. */
  pressPending(): Promise<number>;

  /**
   * What the firmware waits for, packed (okemu_jni.cpp nativeConfirmState):
   * CRYPTO_AUTH, opcode, slot, input mode, isfade. -1 when not running.
   */
  confirmState(): Promise<number>;

  /** Iterations still owed on a counted hold; 0 when idle or stopped. */
  buttonTicksLeft(button: number): Promise<number>;

  /**
   * Sense rounds the firmware has completed since boot.
   *
   * A RELEASE IS NOT A GAP IN TIME. touch_sense_loop() ends a press only after
   * three rounds in which no pad read as touched (okcore.cpp:2723), and while
   * any pad is held it keeps adding to the SAME press - so two counted holds
   * with no idle round between them arrive as one hold of the combined length.
   * This is how a caller waits for that, in the firmware's own unit rather
   * than by guessing what a round costs on this handset.
   */
  rounds(): Promise<number>;

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

  /**
   * The app asks for the person's attention (an Edge approval sheet waiting for
   * a Yes): PressAlert sounds and posts its notification as it does for a press,
   * until untilMs (ms since epoch) or a call with untilMs 0. A press the
   * firmware waits for takes precedence.
   */
  setAttention(text: string, untilMs: number): void;
  /*
   * THE SPLASH PLAYS ONCE PER PROCESS (Brad, 2026-10-04). A JS reload (Metro's
   * hot reload) starts App again in the SAME process: the soft key cannot
   * restart there ("its firmware thread cannot be replaced"), so a replayed
   * splash waited for it forever and covered whatever came next - an error
   * screen included. The flag lives in native memory, which a reload keeps.
   */
  /** Mark: the splash has played and closed in this process. */
  markSplashDone(): void;
  /** Has the splash already played in this process? */
  splashDoneThisProcess(): boolean;

  readonly onStream: CodegenTypes.EventEmitter<StreamEvent>;
  readonly onLed: CodegenTypes.EventEmitter<LedEvent>;
  readonly onPluginEvent: CodegenTypes.EventEmitter<PluginEvent>;
  readonly onRestartRequested: CodegenTypes.EventEmitter<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeOkEmu');
