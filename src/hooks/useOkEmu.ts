import {useCallback, useEffect, useRef, useState} from 'react';
import {bytes as okbytes, device as device_, protocol} from 'node-onlykey-lib';
import OkEmu, {DIR, IFACE, PRESS_TICKS, type Iface} from '../transport/OkEmu';
import {getOnlyKey} from '../onlykey';
import {buildInfo} from '../buildInfo';

/*
 * EXPLICITLY 'embedded'. This hook IS the soft key - it boots the firmware
 * in this process and presses its pads - so leaning on the default would be
 * relying on a default to say something this file means outright.
 */
import type {LogLevel} from './useLog';

/*
 * No protocol lives in this file any more.
 *
 * It used to carry its own okmsg framing (HEADER, REPORT_SIZE, MSG,
 * buildMessage, setTimePayload) and import a PIN state machine from
 * ../transport/provision. All of it was a third copy - the app had one, the
 * e2e suite had another, and the library has the real one - and the app's copy
 * was the worst of the three: buildMessage did
 * `payload.slice(0, REPORT_SIZE - 5)`, silently truncating an over-long
 * payload, where okmsg.build() refuses it and says how long it was.
 *
 * What is left here is React: state, logging, and the shape the screen binds
 * to.
 */

type Options = {
  log: (level: LogLevel, text: string) => void;
  /** Boot the firmware as soon as the screen mounts. */
  autoStart?: boolean;
};

/**
 * What the DEVICE is doing, as opposed to what the firmware PROCESS is doing.
 *
 * Two different questions, and the screen needs both: the firmware can be
 * running perfectly while the device is locked and refuses everything, which is
 * exactly the state that used to produce "nothing works and nothing says why".
 */
export type DeviceState = 'unknown' | 'uninitialized' | 'locked' | 'unlocked' | 'bootloader';

export type EmuState =
  | 'unavailable'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'halted'
  | 'error';

/**
 * How long after an UNLOCKED announcement an INITIALIZED is treated as the
 * report that raced it rather than as a genuine re-lock.
 *
 * The broadcast runs at 1 Hz and the racing report lands in milliseconds, so
 * anything in this window is the race and anything past it is real.
 */
const UNLOCK_GRACE_MS = 1500;

const IFACE_NAME: Record<number, string> = {
  [IFACE.KEYBOARD]: 'kbd',
  [IFACE.FIDO]: 'fido',
  [IFACE.VENDOR]: 'vendor',
  [IFACE.SEREMU]: 'debug',
};

export type EmuSession = ReturnType<typeof useOkEmu>;

/**
 * "It cannot start" and "it will never start again" are different states, and
 * they want different words and different buttons.
 *
 * nativeStart refuses once a firmware thread has been created in this process:
 * the thread only exits through the AIRCR trap and cannot be replaced, because
 * the firmware is linked statically into the same .so as the JNI and there is
 * no way to reset its globals short of a new process. So a Start button left
 * enabled here fails identically every time.
 */
function terminalState(message: string): EmuState {
  return /cannot be restarted|already been created|only exits/i.test(message)
    ? 'halted'
    : 'error';
}

function describeStart(message: string): string {
  return terminalState(message) === 'halted'
    ? 'the firmware thread is gone and cannot be replaced - restart the app'
    : `start: ${message}`;
}

export function useOkEmu({log, autoStart = false}: Options) {
  const [state, setState] = useState<EmuState>('stopped');
  const [storageDir, setStorageDir] = useState('');
  const [led, setLed] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<DeviceState>('unknown');

  /*
   * When the device last announced UNLOCKED.
   *
   * Only used to ignore an INITIALIZED that raced it. A ref rather than state
   * because changing it must not re-render, and because the stream handler
   * needs the newest value rather than the one captured when it was created.
   */
  const unlockedAt = useRef(0);
  const [version, setVersion] = useState('');

  /*
   * What the device said it is, and what that means it can do.
   *
   * This used to be a version string and nothing else, produced here by a regex
   * - the only firmware-version parse in the whole project, in a React hook,
   * for display. The parse now lives in the library so it can be branched on;
   * what is kept here is the RESULT, so a screen can say "OnlyKey DUO,
   * production build" instead of showing a string and hoping.
   */
  const [identity, setIdentity] = useState<ReturnType<
    typeof device_.version.parseStatus
  > | null>(null);
  const [capabilities, setCapabilities] = useState<ReturnType<
    typeof device_.version.capabilities
  > | null>(null);
  const started = useRef(false);

  useEffect(() => {
    const offStream = OkEmu.on('stream', event => {
      // The debug interface carries the firmware's own printf output, which is
      // text; everything else is binary reports.
      if (event.iface === IFACE.SEREMU) {
        const text = okbytes.toPrintable(event.bytes).trim();
        if (text) {
          log('info', `[fw] ${text}`);
        }
        return;
      }
      /*
       * The device says what it is, once a second, without being asked.
       *
       * A locked device broadcasts INITIALIZED on the vendor interface every
       * second (the taskInitialized SoftTimer), an unprovisioned one broadcasts
       * UNINITIALIZED, and unlocking announces UNLOCKED once and then STOPS the
       * timer. So lock state needs no polling - it is already on the wire, and
       * reading it here is the whole difference between a screen that knows and
       * a screen that shows a log and hopes.
       */
      if (event.iface === IFACE.VENDOR && event.dir === DIR.OUT) {
        const parsed = protocol.okmsg.parseState(okbytes.toPrintable(event.bytes));
        if (parsed.state === 'unlocked') {
          unlockedAt.current = Date.now();
          setDevice('unlocked');
          const info = device_.version.parseStatus(String(parsed.raw));
          setIdentity(info);
          setCapabilities(device_.version.capabilities(info));
          setVersion(info.version ?? '');
        } else if (parsed.state === 'uninitialized') {
          setDevice('uninitialized');
        } else if (parsed.state === 'locked') {
          /*
           * INITIALIZED means provisioned AND locked, and a report already in
           * flight can land just after the one-off UNLOCKED announcement -
           * which would put the screen back behind a PIN prompt for no reason.
           *
           * This used to be handled by making 'unlocked' ABSORBING: once seen,
           * INITIALIZED was ignored forever. That removed the race and with it
           * the app's ability to notice the device locking AT ALL - the idle
           * timeout, a hold on button 3, and entering config mode all lock the
           * key, and the screen went on saying `unlocked` over every one of
           * them. See FINDING-relock-was-invisible-to-the-app.md.
           *
           * Time tells the two apart. The broadcast runs once a second and the
           * in-flight report lands within milliseconds of the UNLOCKED it
           * raced; a genuine re-lock is seconds later at the earliest. So a
           * short grace window after unlocking suppresses the race and nothing
           * else.
           */
          const sinceUnlock = Date.now() - unlockedAt.current;
          if (sinceUnlock > UNLOCK_GRACE_MS) {
            setDevice('locked');
          }
        }
      }

      const arrow = event.dir === DIR.OUT ? 'rx' : 'tx';
      log(
        arrow,
        `${IFACE_NAME[event.iface] ?? event.iface} ${okbytes
          .formatHex(event.bytes)
          .slice(0, 71)}`,
      );
    });

    const offLed = OkEmu.on('led', pixels => setLed(pixels));

    /*
   * CPU_RESTART() ENDS THE FIRMWARE, and there is no coming back in this
   * process. okemu_firmware_run() longjmps out of the AIRCR trap, runs
   * okemu_hal_shutdown() and RETURNS - the thread exits - and nativeStart
   * refuses to spawn a second one (that guard exists because two threads
   * sharing one input queue is worse than none).
   *
   * The firmware reaches it by design and by GESTURE: holding button 3 for
   * about two seconds is "lock the device", which on hardware is a reboot and
   * here is the end of the soft key (OnlyKey.ino:906-913). Integrity failures
   * and wipes take the same road.
   *
   * This used to log 'info' and leave the state at 'running', so a dead
   * device read as a healthy one and every later call simply timed out.
   */
    const offRestart = OkEmu.on('restartRequested', () => {
      setState('halted');

      /*
       * And the DEVICE is no longer unlocked, which is a separate fact from the
       * firmware being halted and has to be said separately.
       *
       * CPU_RESTART() is what the idle lockout, the lock gesture and a failed
       * integrity check all end in - the key rebooting, which on hardware means
       * it comes back LOCKED. Leaving `device` at 'unlocked' left the app
       * sitting on an unlocked-looking session over a firmware that no longer
       * exists: the door stayed open, and whatever was on screen - a slot's
       * password, a derived secret, an opened vault note - stayed with it.
       *
       * 'unknown' rather than 'locked' because that is the truth. The firmware
       * is gone and nothing has told us what it will say when it comes back;
       * what IS certain is that it is not unlocked.
       */
      setDevice('unknown');

      log(
        'error',
        'firmware called CPU_RESTART() - the thread has exited and cannot be ' +
          'restarted in this process. Restart the app; flash and EEPROM persist.',
      );
      console.log('[softkey] CPU_RESTART() - firmware thread gone, restart the app');
    });

    if (!OkEmu.isAvailable()) {
      setState('unavailable');
      log('error', 'libokemu.so is not available for this ABI');
    } else if (OkEmu.isRunning()) {
      setState('running');
    }

    return () => {
      offStream();
      offLed();
      offRestart();
    };
  }, [log]);

  const start = useCallback(async () => {
    setBusy(true);
    setState('starting');
    try {
      const result = await OkEmu.start();
      setStorageDir(result.storageDir);
      if (result.started) {
        setState('running');
        log('info', `firmware started, storage=${result.storageDir}`);
      } else if (result.message === 'already running') {
        setState('running');
      } else {
        /*
         * The refusal ARRIVES AS A RESOLVED RESULT, not a rejection.
         * nativeStart returns its reason as a string and the module reports it
         * with started=false, so checking only the catch below missed it
         * entirely and a permanently dead firmware showed as a generic error
         * with a Start button that would fail identically forever.
         */
        setState(terminalState(result.message));
        log('error', describeStart(result.message));
      }
    } catch (error) {
      setState(terminalState(String(error)));
      log('error', describeStart(String(error)));
    } finally {
      setBusy(false);
    }
  }, [log]);

  const stop = useCallback(async () => {
    try {
      await OkEmu.stop();
      setState('stopped');
      log('info', 'firmware stopped');
    } catch (error) {
      log('error', `stop: ${String(error)}`);
    }
  }, [log]);

  /**
   * There is no in-process restart, and there cannot be.
   *
   * The firmware thread only exits through the AIRCR trap, so
   * NativeOkEmuModule rejects this unconditionally. It is kept because the
   * screen offers the button and the honest answer is the rejection, not a
   * silent no-op that looks like it worked.
   */
  const restart = useCallback(async () => {
    setBusy(true);
    try {
      const result = await OkEmu.restart();
      setState(result.started ? 'running' : 'error');
      log('info', result.started ? 'firmware restarted' : `restart: ${result.message}`);
    } catch (error) {
      log('error', `restart: ${String(error)} - restart the app instead; flash.bin persists`);
    } finally {
      setBusy(false);
    }
  }, [log]);

  /**
   * OKCONNECT is the meaningful health check, not "did it boot".
   *
   * It performs the NaCl key exchange, which reaches certified_hw in the
   * emulated flash - the one thing Android's mmap_min_addr floor can quietly
   * break. A firmware that boots and answers nothing here has the mapping
   * problem; a firmware that answers has not.
   *
   * Now goes through the library, so the key derivation is the one pinned
   * against the published NaCl vectors rather than a second implementation
   * that happens to live in this app.
   */
  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const {device} = await getOnlyKey('embedded');
      const result = await device.connect();
      log('info', `OKCONNECT -> "${String(result.status ?? '').trim()}"`);
      return result;
    } catch (error) {
      /*
       * Mirrored to the console for the same reason the success path is: this
       * runs at launch, before anyone has necessarily looked at the screen, and
       * an in-app log line is invisible to logcat. Without it a failure here
       * reads only as "no reply", which cannot distinguish a device that stayed
       * silent from an exception thrown before anything was ever written.
       */
      log('error', `OKCONNECT: ${String(error)}`);
      console.log(`[softkey] OKCONNECT failed: ${String(error)}`);
      if (error instanceof Error && error.stack) {
        console.log(`[softkey] ${error.stack.replace(/\s*\n\s*/g, ' | ').slice(0, 400)}`);
      }
      return null;
    } finally {
      setBusy(false);
    }
  }, [log]);

  /**
   * Set a PIN.
   *
   * The six-step bracket, the one-line digit burst and the per-digit
   * acknowledgement counting all live in the library now. This reports its
   * progress: the library emits one event per transition, which is the only
   * way to tell a device waiting for a button press from a wedged one.
   */
  const provision = useCallback(
    async (pin: string) => {
      setBusy(true);
      let offProgress: (() => void) | undefined;
      try {
        log('info', `provisioning with a ${pin.length}-digit PIN`);
        const {device} = await getOnlyKey('embedded');

        offProgress = device.on('progress', (e: {step: string}) =>
          log('info', `  ${e.step}`),
        );
        await device.setPin(pin);

        /*
         * No restart here. `initialized` is only recomputed from flash in
         * setup(), so the PIN is not in effect until the firmware boots
         * again - but the firmware thread only exits through the AIRCR trap,
         * so an in-process restart would start a second one alongside it.
         * Restart the app instead; flash.bin is file-backed and survives.
         */
        log('info', 'PIN committed - restart the app to load it');
        console.log('[softkey] PIN COMMITTED - restart the app to verify it persisted');
        return true;
      } catch (error) {
        log('error', `provision: ${String(error)}`);
        console.log(`[softkey] provision failed: ${String(error)}`);
        return false;
      } finally {
        offProgress?.();
        setBusy(false);
      }
    },
    [log],
  );

  /**
   * Press a button, the way a finger does.
   *
   * This is the device's ENTIRE input surface: six buttons. A PIN is a
   * sequence of them, and user presence for a FIDO2 ceremony is three of them
   * chosen by the request (protocol.challenge.challengeDigits).
   *
   * Taps only, deliberately. Duration is measured in MAIN-LOOP ITERATIONS, not
   * milliseconds (touch_sense_loop() counts passes), so the millisecond
   * boundaries differ between this build and hardware and nothing here has
   * measured them. That would be a nicety, except that the long-press bands
   * are where the destructive gestures live: >=72 iterations on button 1 runs
   * backup(), on button 3 locks and calls CPU_RESTART(), on button 6 enters
   * config mode. A control that might land in one of those by accident is not
   * one to ship on a guess.
   *
   * Presence does not need it either - the challenge is checked before any
   * duration band is consulted (OnlyKey.ino:807).
   */
  const press = useCallback(
    async (button: number) => {
      try {
        await OkEmu.holdTicks(button, PRESS_TICKS.TAP);
        log('info', `button ${button} (${PRESS_TICKS.TAP} ticks)`);
      } catch (error) {
        log('error', `button ${button}: ${String(error)}`);
      }
    },
    [log],
  );

  /*
   * A held press, with the count the firmware is actually seeing.
   *
   * Armed at one tick BELOW the gesture band rather than held open, so the
   * ceiling is enforced by the emulator instead of by the user letting go in
   * time. Holding past the end of the counter does nothing at all; there is
   * no path from this control to backup() or CPU_RESTART().
   *
   * The counter is what the LED is on hardware: the only way to tell which
   * band a press is in while it is still happening.
   */
  const [pressTicks, setPressTicks] = useState<{button: number; ticks: number} | null>(
    null,
  );
  const holdPoll = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (holdPoll.current) {
      clearInterval(holdPoll.current);
      holdPoll.current = null;
    }
  }, []);

  const beginHold = useCallback(
    async (button: number) => {
      try {
        const armed = PRESS_TICKS.GESTURE - 1;
        await OkEmu.setButtonTicks(button, armed);
        setPressTicks({button, ticks: 0});
        stopPolling();
        holdPoll.current = setInterval(async () => {
          try {
            const left = await OkEmu.buttonTicksLeft(button);
            setPressTicks({button, ticks: armed - left});
            if (left <= 0) stopPolling();
          } catch {
            stopPolling();
          }
        }, 60);
      } catch (error) {
        log('error', `button ${button}: ${String(error)}`);
      }
    },
    [log, stopPolling],
  );

  const endHold = useCallback(
    async (button: number) => {
      stopPolling();
      try {
        /* Cancels the counted hold as well as releasing the pad. */
        const armed = PRESS_TICKS.GESTURE - 1;
        const left = await OkEmu.buttonTicksLeft(button);
        await OkEmu.setButton(button, false);
        const held = armed - left;
        const band =
          held <= 20 ? 'tap' : held < PRESS_TICKS.GESTURE ? 'hold' : 'gesture';
        log('info', `button ${button} held ${held} ticks (${band})`);
      } catch (error) {
        log('error', `button ${button}: ${String(error)}`);
      }
      setPressTicks(null);
    },
    [log, stopPolling],
  );

  useEffect(() => stopPolling, [stopPolling]);

  const send = useCallback(
    async (iface: Iface, msg: number) => {
      try {
        await OkEmu.write(iface, protocol.okmsg.build({msg}));
      } catch (error) {
        log('error', `write: ${String(error)}`);
      }
    },
    [log],
  );

  /*
   * Boot once on mount, then prove the device is actually usable.
   *
   * A soft key that needs a button press before it exists is not much of a
   * key, and "the firmware started" is not the same claim as "the firmware
   * works" - Android's mmap_min_addr floor produces exactly the difference.
   * The OKCONNECT that follows is the real readiness signal.
   *
   * Mirrored to console.log so it reaches logcat: this runs at launch, before
   * anyone has necessarily looked at the screen.
   */
  useEffect(() => {
    if (!autoStart || started.current) {
      return;
    }
    if (!OkEmu.isAvailable() || OkEmu.isRunning()) {
      return;
    }
    started.current = true;

    (async () => {
      await start();
      if (!OkEmu.isRunning()) {
        console.log('[softkey] firmware did not start');
        return;
      }
      // setup() runs on its own thread; let it reach the main loop.
      await new Promise<void>(resolve => {
        setTimeout(resolve, 1500);
      });
      const result = await connect();
      console.log(
        result
          ? `[softkey] OKCONNECT ok: "${String(result.status ?? '').trim()}"`
          : '[softkey] OKCONNECT got no reply - the flash mapping is suspect',
      );
    })();
  }, [autoStart, start, connect]);

  /*
   * SETTLING IS NOT READ FROM THE LED ANY MORE, and the reason is worth
   * keeping: THE LED IS AN OUTPUT FOR A PERSON, NOT A STATE REPORT.
   *
   * This used to watch for yellow and tell the user "the key drops every
   * press until the LED clears". The firmware does set yellow while it is
   * dropping presses (OnlyKey.ino:522-525, when pending_operation is
   * CTAP2_ERR_DATA_READY or DATA_WIPE). It also sets exactly the same yellow
   * for at least five other things:
   *
   *   OnlyKey.ino:639     EVERY ordinary button press
   *   okcore.cpp:7180     typing a slot at the keyboard
   *   okcore.cpp:6318     starting a backup
   *   OnlyKey.ino:759     a PIN digit appended in config mode
   *   OnlyKey.ino:771,787 the same for the second and SD profiles
   *
   * So yellow does not imply dropping, and the banner appeared during
   * perfectly normal use - telling someone their presses were being thrown
   * away while the key was doing exactly what they asked. A colour is a
   * summary the firmware paints for a human; inferring a state machine back
   * out of it is reading the summary as the source.
   *
   * The honest signal is the one the hard key already used: the app knows
   * when IT relayed a ceremony, and the firmware's window is a fixed twenty
   * seconds from the end of one. useKey owns that timer and now applies it to
   * both backends. `led` is still reported, and This Key still shows it -
   * showing the colour is fine, deciding from it is not.
   */
  const settling = null as string | null;

  return {
    state,
    device,
    version,
    identity,
    capabilities,
    storageDir,
    led,
    settling,
    busy,
    start,
    stop,
    restart,
    connect,
    provision,
    press,
    beginHold,
    endHold,
    pressTicks,
    send,

    /**
     * Always. The soft key has no buttons but the ones the app draws, so a
     * keypad is the only way in. The hard key's answer is three-valued and
     * probed; the two handles carry the same field so a screen asks one
     * question of either. See useHardKey.canPress.
     */
    canPress: true as boolean | null,

    /**
     * WHICH MODEL this key is, from the BUILD: stage.js staged the firmware
     * as a DUO or a Classic, and buildInfo carries that. A DUO types its PIN
     * and has 24 slots in four profiles; the screens branch on this.
     */
    model: (buildInfo.model === 'duo' ? 'duo' : 'classic') as 'duo' | 'classic',

    /**
     * A hold of an exact length, for the library's slot and backup reads.
     *
     * On the HANDLE rather than reached for as OkEmu.holdTicks, because the
     * slot editor and the backup screen did exactly that and pressed the
     * emulator with a hard key selected - the same blend the BLE bridge had.
     * Both handles carry this, so a screen presses whichever key it is on.
     */
    holdTicks: (button: number, ticks: number, opts?: {allowGesture?: boolean}) =>
      OkEmu.holdTicks(button, ticks, opts),
  };
}
