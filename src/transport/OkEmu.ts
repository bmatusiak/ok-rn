import {bytes as okbytes, device, transport} from 'node-onlykey-lib';
import NativeOkEmu from '../../specs/NativeOkEmu';
import type {LedEvent, StartResult, StreamEvent} from '../../specs/NativeOkEmu';
import {storageSlot} from '../buildInfo';


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
 * The press bands come from the LIBRARY, which is where the firmware's
 * OnlyKey.ino is transcribed.
 *
 * They were declared here, and restated in ten more files across screens,
 * hooks and suites. A press band is protocol - the same firmware runs on a
 * physical key over USB - so a second host would have transcribed them again,
 * and a transcription that drifts by one band is the difference between typing
 * a password and taking a backup.
 *
 * Re-exported rather than re-imported at each call site, so nothing else moves.
 */
export const PRESS_TICKS = device.press.PRESS_TICKS;
/** Which band a count falls in: 'tap', 'hold', 'gesture' or 'rejected'. */
export const bandFor: (ticks: number) => 'tap' | 'hold' | 'gesture' | 'rejected' =
  device.press.bandFor;
const RELEASE_ROUNDS = device.press.RELEASE_ROUNDS;


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

  /**
   * Boot the firmware against THIS BUILD'S storage slot.
   *
   * The slot is not a parameter here on purpose. It is a property of the
   * firmware that was staged, not of the caller, and every caller passing it
   * would be a dozen places that could pass a different one - a device booting
   * against the wrong flash, looking perfectly healthy. `storageSlot` is
   * derived once, beside the version it comes from.
   */
  async start(): Promise<StartResult> {
    this.ensureSubscribed();
    return NativeOkEmu.start(storageSlot);
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
    /*
     * THE SENSED PATH, and it is kept deliberately.
     *
     * TWO WAYS TO PRESS, and they differ in kind rather than degree:
     *
     *   pressQueue()  hands the press to the firmware. Use it for anything
     *                 that just needs the press to LAND - a PIN, a challenge,
     *                 user presence. ~96ms, one sense round.
     *   pressButton() / holdTicks()  emulate a finger on the pad. Use them
     *                 when the SENSING is the subject: 2-buttonProbe proving
     *                 every button arrives as itself, 7-pressBands proving the
     *                 band boundaries, and the held press behind KeyScreen's
     *                 Buttons panel whose counter you watch count down.
     *                 ~855ms, fifteen rounds - which is the cost of being a
     *                 faithful emulation.
     *
     * This is what 2-buttonProbe and 7-pressBands exercise - the only tests of
     * touch_sense_loop's own counting - and it is the honest emulation of a
     * finger. It is also slow for exactly that reason: ~757-855ms a press,
     * because every round waits for SoftTimer.
     *
     * Anything entering a PIN should use pressQueue() instead, which hands the
     * presses to the loop rather than sensing them and costs one round each.
     */
    return this.holdTicks(button, PRESS_TICKS.TAP);
  }

  /**
   * Press a run of buttons by HANDING them to the firmware, not sensing them.
   *
   * This is the fast path, and the difference is not small. setButtonTicks
   * emulates a finger: the pad reads high for N rounds and touch_sense_loop()
   * counts them, but a round only happens when SoftTimer runs checkKey() and
   * `#define TIME_POLL 50`. A ten-tick tap plus the four idle rounds the
   * firmware needs to see the release is fourteen scheduler periods - measured
   * at 757-855ms for ONE press, so a seven-digit PIN took five to six seconds.
   * Handing a press over costs one round, and the whole run crosses the bridge
   * in a single call.
   *
   * It is the same press either way. `key_press` IS what touch_sense_loop
   * returns and payload() bands on, so the tick count means exactly what the
   * band table says it means.
   *
   * NOT the firmware's debug console - see android/okemu/src/okemu_press.h.
   * That parser is behind `#ifdef DEBUG` and exists only in the development
   * tree; this is our own code, compiled unconditionally, and it works against
   * a firmware staged exactly as it ships.
   *
   * @param buttons one digit per press, '1'-'6'
   * @param ticks the duration each press gets, default a tap
   * @returns how many the firmware accepted
   */
  async pressQueue(
    buttons: string,
    ticks: number = PRESS_TICKS.TAP,
    {allowGesture = false}: {allowGesture?: boolean} = {},
  ): Promise<number> {
    /*
     * REFUSED BEFORE ANYTHING IS QUEUED, so a bad duration cannot land half a
     * run. Injection writes key_press directly, which reaches backup(), lock +
     * CPU_RESTART() and config mode exactly as a held finger does - the guard
     * matters more here, not less.
     */
    for (const digit of buttons) {
      const refusal = device.press.gestureRefusal(Number(digit), ticks, {allowGesture});
      if (refusal) throw new Error(refusal);
    }
    this.ensureSubscribed();
    const accepted = await NativeOkEmu.pressQueue(buttons, ticks);
    if (accepted !== buttons.length) {
      throw new Error(
        `queued ${accepted} of ${buttons.length} presses - the queue was full ` +
          'or a character was not a button 1-6',
      );
    }
    await this.pressesDrained();
    return accepted;
  }

  /** Queued but not yet taken by the firmware. */
  pressPending(): Promise<number> {
    return NativeOkEmu.pressPending();
  }

  /*
   * Wait until the firmware has TAKEN every queued press.
   *
   * Resolving when they were queued would let a caller send the next message
   * while digits were still waiting - which is the same mistake the sensed
   * path made, and the firmware's PIN buffer cannot be cleared except by
   * running it to its rollover.
   *
   * Polled at 10ms rather than the sensed path's 25ms because a press is taken
   * on the next sense round, not after fourteen of them; the wait here is
   * tens of milliseconds, so a coarse poll would dominate what it measures.
   */
  private async pressesDrained(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await this.pressPending()) === 0) return;
      if (Date.now() > deadline) {
        throw new Error('the firmware did not take the queued presses');
      }
      await new Promise<void>(resolve => setTimeout(() => resolve(), 10));
    }
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
    const refusal = device.press.gestureRefusal(button, ticks, {allowGesture});
    if (refusal) {
      return Promise.reject(new Error(refusal));
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
