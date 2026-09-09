import {bytes as okbytes, transport} from 'node-onlykey-lib';
import NativeOkEmu from '../../specs/NativeOkEmu';
import type {LedEvent, StartResult, StreamEvent} from '../../specs/NativeOkEmu';

/**
 * Idle sense rounds that must pass before the firmware calls a press finished.
 *
 * `key_off > 2` in okcore.cpp:2723 - three rounds with no pad held - plus one
 * for the round the hold retired in, which still read as held.
 */
const RELEASE_ROUNDS = 4;

export type {LedEvent, StartResult, StreamEvent};

/*
 * Interface numbers and directions come from the library, which is where the
 * firmware's usb_desc.h is transcribed. They were declared here as well, with
 * the same values, and a second copy of a wire constant is a copy that can
 * drift. Re-exported rather than re-imported at each of the twenty-five call
 * sites, so nothing else has to move.
 */
export const IFACE = transport.IFACE;
export const DIR = transport.DIR;

export type Iface = (typeof IFACE)[keyof typeof IFACE];

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
/**
 * Press lengths in FIRMWARE MAIN-LOOP ITERATIONS, which is the only unit the
 * firmware bands on (OnlyKey.ino:873-942):
 *
 *     <= 20      types the slot
 *     21 .. 89   types the slot's b profile
 *     >= 72      stops being a slot read: button 1 backs up, 2 dumps labels,
 *                3 locks and restarts, 6 enters config mode
 *     >= 90      rejected outright
 *
 * The gesture branches return before the band dispatch, so 21..71 is the whole
 * safe window for a b-profile read. TAP and HOLD sit in the middle of their
 * bands rather than at an edge, since the only cost of being wrong upward is
 * an irreversible action.
 */
export const PRESS_TICKS = {
  /** Types slot N. */
  TAP: 10,
  /** Types slot N+6, the b profile. Comfortably short of a gesture. */
  HOLD: 40,
  /** The first tick at which a press stops being a slot read. */
  GESTURE: 72,
} as const;


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
        const bytes = okbytes.fromHex(event.hex);
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
    return NativeOkEmu.writeHid(iface, okbytes.toHex(bytes));
  }

  /** Yubikey OTP / HMAC-SHA1, which rides keyboard control transfers. */
  /** Hold or release a touch button. Timing is the caller's. */
  setButton(button: number, down: boolean): Promise<void> {
    this.ensureSubscribed();
    return NativeOkEmu.setButton(button, down);
  }

  /**
   * A plain tap: the shortest press that means "slot N".
   *
   * This took a millisecond duration until the bands were measured. The unit
   * was always wrong - the firmware counts MAIN-LOOP ITERATIONS and never
   * consults a clock - so every caller was converting at a rate nobody had
   * measured, on a device whose loop speed differs from the next one, with
   * backup() and CPU_RESTART() on the far side of the boundary they were
   * aiming below. See FINDING-holds-were-timed-against-a-counted-band.md.
   *
   * Kept as a name because "tap" is what almost every caller means; the
   * duration is no longer theirs to pick. Use holdTicks() for anything else.
   */
  pressButton(button: number): Promise<void> {
    return this.holdTicks(button, PRESS_TICKS.TAP);
  }

  /**
   * Hold a button for a count of firmware main-loop iterations.
   *
   * Returns as soon as the hold is armed. `holdTicks` waits for it to finish.
   *
   * Anything in the gesture range is refused unless the caller passes
   * `allowGesture`, because there is no such thing as accidentally wanting it:
   * at 72 iterations button 1 takes a backup, button 3 locks the key and
   * restarts it, and button 6 enters config mode. A slot read never needs to
   * go past 71, so the default makes that range unreachable rather than
   * merely unlikely.
   */
  setButtonTicks(
    button: number,
    ticks: number,
    {allowGesture = false}: {allowGesture?: boolean} = {},
  ): Promise<void> {
    if (!allowGesture && ticks >= PRESS_TICKS.GESTURE) {
      return Promise.reject(
        new Error(
          `${ticks} ticks is in the gesture band (>= ${PRESS_TICKS.GESTURE}): ` +
            'button 1 backs up, 3 restarts, 6 enters config mode. ' +
            'Pass {allowGesture: true} if that is what you mean.',
        ),
      );
    }
    this.ensureSubscribed();
    return NativeOkEmu.setButtonTicks(button, ticks);
  }

  /** Iterations still owed on a counted hold; 0 when idle or stopped. */
  buttonTicksLeft(button: number): Promise<number> {
    return NativeOkEmu.buttonTicksLeft(button);
  }

  /** Sense rounds the firmware has completed since boot. */
  rounds(): Promise<number> {
    return NativeOkEmu.rounds();
  }

  /**
   * Wait until the firmware has SEEN the release, not merely until we stopped
   * asserting it (FINDING-counted-presses-merge-without-an-idle-gap.md).
   *
   * touch_sense_loop() adds to the same press for as long as ANY pad reads as
   * touched, and only hands it to payload() once three rounds have gone by with
   * none of them touched (okcore.cpp:2723, `key_off > 2`). So a second hold
   * armed before those rounds have happened does not become a second press: it
   * extends the first, keeps its own button as the selection, and the duration
   * payload() eventually sees is the SUM. Seven ten-tick taps arrive as one
   * seventy-tick hold; eight clear 72, which on button 1 is backup() and on
   * button 3 is lock and CPU_RESTART().
   *
   * Four rather than three: the round in which the counter retired still
   * reported the pad as held (`okemu_touch_for_pin` reports before it ages),
   * so the idle ones only start after it.
   */
  private async settleRelease(timeoutMs: number): Promise<void> {
    const start = await this.rounds();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await this.rounds()) - start >= RELEASE_ROUNDS) return;

      /*
       * A stall here is not a failure, and must not be reported as one.
       *
       * The rounds stop advancing whenever the firmware is doing what the press
       * ASKED FOR: backup() types the whole key at the keyboard, a slot types a
       * password, and neither returns to touch_sense_loop() in the meantime. So
       * the longest presses in the app are exactly the ones whose settle cannot
       * complete - the first version of this threw "the main loop is not
       * running" at the end of a perfectly good backup gesture.
       *
       * Nothing is lost by returning. The settle exists to stop a FOLLOWING
       * press merging into this one, and while the loop is not sampling it
       * cannot: okemu_touch_for_pin already reports the pad as released - the
       * counter hit zero and cleared it - and the next press's ticks cannot age
       * until the loop comes back either. A loop that is genuinely wedged is
       * caught by the tick timeout on the next hold, which is a liveness check;
       * this is not.
       */
      if (Date.now() > deadline) return;
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
  }


  /**
   * A complete counted press: arm it, then wait for the firmware to consume it.
   *
   * Polls rather than taking a callback because the tick only advances when
   * the firmware runs a loop iteration, and how long that takes is exactly the
   * thing we are refusing to predict. The timeout is a stall detector, not a
   * duration: reaching it means the main loop is not running, which is worth
   * an error rather than a silent return.
   */
  async holdTicks(
    button: number,
    ticks: number,
    opts: {allowGesture?: boolean; timeoutMs?: number} = {},
  ): Promise<void> {
    const {timeoutMs = 10000} = opts;
    await this.setButtonTicks(button, ticks, opts);

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const left = await this.buttonTicksLeft(button);
      if (left <= 0) {
        /* The hold is over; the PRESS is not, until the release is observed. */
        await this.settleRelease(Math.max(0, deadline - Date.now()));
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `button ${button} still owes ${left} of ${ticks} ticks after ` +
            `${timeoutMs}ms - the firmware main loop is not running`,
        );
      }
      /* A tick is tens of milliseconds, so polling faster than this only
       * contends on the HAL mutex with the firmware thread that is trying to
       * advance it. */
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
  }

  kbdSetReport(bytes: Uint8Array): Promise<void> {
    return NativeOkEmu.kbdSetReport(okbytes.toHex(bytes));
  }

  async kbdGetReport(): Promise<Uint8Array> {
    return okbytes.fromHex(await NativeOkEmu.kbdGetReport());
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
