import {useCallback, useEffect, useRef, useState} from 'react';
import {bytes as okbytes, device as device_, protocol, transport as oktransport} from 'node-onlykey-lib';

import UsbPipe from '../transport/UsbPipe';
import {PRESS_TICKS} from '../transport/OkEmu';
import {getOnlyKey} from '../onlykey';
import type {LogLevel} from './useLog';
import type {DeviceState, KeyState} from './keySession';

const {IFACE, DIR} = oktransport;

/**
 * A physical OnlyKey over USB, presented exactly as the soft key is.
 *
 * The sibling of `useOkEmu`, and it returns the SAME SHAPE on purpose: eight
 * screens take this handle, and none of them should ask which kind of key it
 * has. That is what "one lib, any GUI" means once there are two devices.
 *
 * ## What is ABSENT here, and is absent rather than faked
 *
 * | soft key only | why |
 * |---|---|
 * | `led` | a hard key produces NO LED SIGNAL. The emulator reports its pixel state as data because the host is the hardware; on a real key that is light in a room, and it never reaches the wire |
 * | `storageDir` | the emulator's flash and EEPROM files. A real key's storage is inside it |
 * | `restart` | the soft key restarts as a process. A real one restarts by being unplugged |
 *
 * Each is null or empty rather than invented. A screen that shows the LED has
 * nothing to show here, and should say so rather than render a dead indicator
 * that looks like a key sitting in the dark.
 *
 * ## Buttons
 *
 * A hard key HAS BUTTONS - six of them, under the user's finger - so the app
 * does not draw a keypad for it. `press` is offered only when the firmware's
 * debug console can drive one, which is `capabilities().consolePress`: a debug
 * build newer than v3.0.2. On anything else it is null, and a caller shows
 * "press button 3 on the key" instead of a control that cannot work.
 */
export function useHardKey({log}: {log: (level: LogLevel, text: string) => void}) {
  const [state, setState] = useState<KeyState>('stopped');
  const [device, setDevice] = useState<DeviceState>('unknown');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState('');
  /*
   * The model a LOCKED key admits to. A DUO's once-a-second status while
   * locked is "INITIALIZED-D" (OnlyKey.ino sendInitialized, the desktop's
   * OnlyKeyComm.js:1022 reads the same), and the library's parseStatus
   * already turns it into MODEL.DUO; a Classic sends a bare "INITIALIZED".
   * Kept separately from `identity`, which is the fuller unlocked reply.
   */
  const [lockedModel, setLockedModel] = useState<'duo' | 'classic' | null>(null);
  const [identity, setIdentity] = useState<ReturnType<
    typeof device_.version.parseStatus
  > | null>(null);
  const [capabilities, setCapabilities] = useState<ReturnType<
    typeof device_.version.capabilities
  > | null>(null);

  /** See useOkEmu: the same 1 Hz broadcast races the one-off UNLOCKED. */
  const unlockedAt = useRef(0);

  useEffect(() => {
    const offStream = UsbPipe.on('stream', event => {
      if (event.iface === IFACE.SEREMU) {
        const text = okbytes.toPrintable(event.bytes).trim();
        if (text) {
          log('info', `[fw] ${text}`);
        }
        return;
      }

      /*
       * The device says what it is once a second without being asked, and it
       * says it on the vendor interface - the one that was never claimed before
       * this work. So lock state needs no polling here either.
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
        } else if (parsed.state === 'bootloader') {
          /* After the firmware-update kick; only sendFirmware makes sense now. */
          setDevice('bootloader');
          setIdentity(null);
        } else if (parsed.state === 'locked') {
          const info = device_.version.parseStatus(String(parsed.raw));
          setLockedModel(info.model === 'duo' ? 'duo' : 'classic');
          /*
           * The same grace window the soft key uses, and for the same reason: a
           * report already in flight can land just after the one-off UNLOCKED,
           * and treating it as a re-lock puts the screen back behind a PIN
           * prompt for no reason. See FINDING-relock-was-invisible-to-the-app.md
           * for why 'unlocked' must NOT be absorbing instead.
           */
          if (Date.now() - unlockedAt.current > UNLOCK_GRACE_MS) {
            setDevice('locked');
          }
        }
      }

      const arrow = event.dir === DIR.OUT ? 'rx' : 'tx';
      log(arrow, `${IFACE_NAME[event.iface] ?? event.iface} ${okbytes
        .formatHex(event.bytes)
        .slice(0, 71)}`);
    });

    const offStatus = UsbPipe.on('status', event => {
      log('info', `[usb] ${event.state}: ${event.message}`);
      /*
       * To logcat as well as the in-app log, like the soft key's [softkey]
       * lines: the in-app buffer cannot be read from a terminal, and a
       * key that went "stopped" with no line saying why was diagnosed by
       * guesswork once. tools/logwatch.js watches for these.
       */
      console.log(`[hardkey] usb ${event.state}: ${event.message}`);
      if (event.state === 'connected') {
        setState('running');
      } else if (event.state === 'connecting') {
        setState('starting');
      } else if (event.state === 'error') {
        setState('error');
      } else if (event.state === 'disconnected') {
        /*
         * UNPLUGGED, so nothing that was read is true any more. Leaving the
         * identity behind would let a screen go on describing a key that is in
         * someone's pocket.
         */
        setState('stopped');
        setDevice('unknown');
        setIdentity(null);
        setLockedModel(null);
        setCapabilities(null);
        setVersion('');
        setConsoleAnswers(null);
      }
    });

    setState(UsbPipe.isRunning() ? 'running' : 'stopped');

    return () => {
      offStream();
      offStatus();
    };
  }, [log]);

  /**
   * Open the key.
   *
   * Returns nothing, matching the soft key - what was opened is reported
   * through the status event and read back from the pipe, so a caller does
   * not have to hold a result to know. Keeping the two signatures identical
   * is what lets one handle serve both.
   */
  /**
   * Whether the firmware will take a press from software.
   *
   * ASKED, not inferred from a version, because the version is not there when
   * it matters. `capabilities().consolePress` needs a version string and a
   * LOCKED key does not send one - it answers `INITIALIZED` and nothing else.
   * So a screen consulting the capability before unlocking is always told no,
   * and unlocking is exactly what needs the answer. That deadlock is why this
   * is a probe rather than a lookup.
   *
   * `device.consoleAnswers()` writes one inert byte and watches for the
   * firmware's own line echo. It presses NOTHING, so it cannot spend a PIN
   * attempt on a locked key - which the obvious probe can, and which cost a
   * bench key once already.
   *
   * Null until it has been asked. A screen must not read "not yet" as "no".
   */
  const [consoleAnswers, setConsoleAnswers] = useState<boolean | null>(null);
  const canPress = consoleAnswers === true;

  /**
   * Say the key is unlocked on evidence other than the broadcast.
   *
   * ONLY THE CONFIG-MODE PROBE CALLS THIS. Entering config mode locks the key
   * and the unlock that follows is never announced - the status goes on saying
   * INITIALIZED - so `device` sticks at `locked` over a working key. Measured
   * on the bench, 2026-09-13:
   *
   *   14:15:28  [config] label probe: UNLOCKED     app showed "Locked"
   *   14:17:21  [config] label probe: locked       after a replug
   *
   * A slot-label read is the proof: the firmware answers it only when
   * `unlocked == true` and otherwise says "Error device locked"
   * (okcore.cpp:379-396), so labels coming back cannot be anything else.
   *
   * Only ever UPGRADES to unlocked. Claiming a lock from an absence of
   * evidence is the mistake this exists to avoid - silence is also what a
   * wedged key produces.
   */
  const markUnlocked = useCallback(() => {
    unlockedAt.current = Date.now();
    setDevice(prev => (prev === 'unlocked' ? prev : 'unlocked'));
  }, []);

  const start = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await UsbPipe.start();
      setState('running');
      log('info', `[usb] opened ${result.interfaces?.length ?? 0} interfaces`);
    } catch (error) {
      setState('error');
      log('error', `[usb] ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [log]);

  /**
   * Restart the key.
   *
   * The soft key cannot do this in place - its firmware thread only exits
   * through the reset trap - and that limitation has been on the not-now list
   * for a while. A HARD key can, when the console has the parser: `8` is
   * CPU_RESTART, and unplugging is the manual equivalent.
   *
   * Refuses by name otherwise, rather than appearing to work.
   */
  const restart = useCallback(async () => {
    if (!canPress) {
      throw new Error(unsupported('restart itself'));
    }
    const {device: dev} = await getOnlyKey('usb');
    /* The library names the command; this used to spell the digit itself. */
    await dev.restart();
    log('info', '[usb] restart requested; the key will re-enumerate');
  }, [canPress, log]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await UsbPipe.stop();
      setState('stopped');
      setDevice('unknown');
    } finally {
      setBusy(false);
    }
  }, []);

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const {device: dev} = await getOnlyKey('usb');
      const result = await dev.connect();
      log('info', `OKCONNECT -> "${String(result.status ?? '').trim()}"`);
      console.log(`[hardkey] OKCONNECT ok: ${JSON.stringify(String(result.status ?? '').trim())}`);

      /*
       * Asked once the device is answering, and BEFORE anything needs it.
       * Unlocking is the first thing that will, and it cannot wait for a
       * version that only arrives after unlocking.
       */
      const answers = await dev.consoleAnswers();
      setConsoleAnswers(answers);
      log('info', `console ${answers ? 'answers' : 'is write-only'}`);
      console.log(`[hardkey] console ${answers ? 'answers' : 'is write-only'}`);

      return result;
    } catch (error) {
      log('error', `OKCONNECT: ${String(error)}`);
      console.log(`[hardkey] OKCONNECT failed: ${String(error)}`);
      return null;
    } finally {
      setBusy(false);
    }
  }, [log]);

  const send = useCallback(
    async (iface: number, msg: number) => {
      try {
        await UsbPipe.write(iface, protocol.okmsg.build({msg}));
      } catch (error) {
        log('error', `write: ${String(error)}`);
      }
    },
    [log],
  );

  /**
   * Press a button, WHEN THE FIRMWARE LETS SOFTWARE DO THAT.
   *
   * Null unless `capabilities().consolePress`, which needs a debug build newer
   * than v3.0.2 - see
   * FINDING-the-debug-console-is-a-control-channel-on-new-firmware-only.md.
   * Everywhere else the answer is a finger, and a control that cannot work is
   * worse than no control.
   *
   * Returned as null rather than a function that rejects, so a screen can hide
   * the keypad by asking rather than by catching.
   */
  const press = useCallback(
    async (button: number) => {
      if (!canPress) {
        throw new Error(unsupported('press a button'));
      }
      const {device: dev} = await getOnlyKey('usb');
      /* One digit is one tap. The firmware replays one press per iteration. */
      await dev.press(String(button));
    },
    [canPress],
  );

  /**
   * A HELD press, by tick count.
   *
   * The console takes an explicit duration - `N#<ticks>` - which reaches any
   * press band, so a gesture is available here too when the firmware has the
   * parser. Begin and end are one call rather than two, because the firmware
   * queues the whole press and replays it; there is no held state to poll the
   * way the emulator has.
   */
  /**
   * A hold is MEASURED ON THE FINGER, then sent as one line.
   *
   * The soft key arms a counter on press-in and reads it while the finger
   * is down; the console takes the whole duration up front (`N#<ticks>`)
   * and replays it a press per loop iteration. The first version sent the
   * maximum on press-in and made endHold a no-op - so every tap on the
   * keypad was a 71-tick hold, which types the b slot, and the capture pane
   * read nothing from a tap because slot 1b was empty. Measured, on the
   * Bluetooth tab, against a slot the editor had just read fine.
   *
   * So press-in only notes the time, and press-out converts the elapsed
   * time to iterations at the firmware's ~36 ms each (press.js) and sends
   * that: a tap lands in the a band, a held finger in the b band, and the
   * clamp keeps it under the gesture floor exactly as the soft key's
   * counter does. The firmware never sees the clock; the caller converts.
   */
  const holdStartedAt = useRef<number | null>(null);

  /*
   * THE COUNTER THE SOFT KEY HAS, measured here on the finger. The emulator
   * reports its own tick counter while a button is down; a hard key cannot
   * report a press it has not been sent yet. But the number that will be
   * sent is known - elapsed time over the firmware's tick - so it is shown
   * as it climbs, and the two handles have the same shape: a screen reads
   * `pressTicks` and the band it will land in, from either key.
   */
  const [pressTicks, setPressTicks] = useState<{button: number; ticks: number} | null>(null);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);

  const ticksSoFar = (started: number) =>
    Math.max(PRESS_TICKS.TAP, Math.min(PRESS_TICKS.GESTURE - 1,
      Math.round((Date.now() - started) / MS_PER_TICK)));

  const beginHold = useCallback(
    async (button: number) => {
      if (!canPress) {
        throw new Error(unsupported(`hold button ${button}`));
      }
      const started = Date.now();
      holdStartedAt.current = started;
      setPressTicks({button, ticks: PRESS_TICKS.TAP});
      if (ticker.current) clearInterval(ticker.current);
      ticker.current = setInterval(() => {
        setPressTicks({button, ticks: ticksSoFar(started)});
      }, MS_PER_TICK * 2);
    },
    [canPress],
  );

  const endHold = useCallback(
    async (button: number) => {
      const started = holdStartedAt.current;
      holdStartedAt.current = null;
      if (ticker.current) {
        clearInterval(ticker.current);
        ticker.current = null;
      }
      setPressTicks(null);
      if (started === null || !canPress) return;
      const ticks = ticksSoFar(started);
      const {device: dev} = await getOnlyKey('usb');
      await dev.press(`${button}#${ticks}`);
    },
    [canPress],
  );

  /**
   * A hold of an exact length: `N#<ticks>` on the console.
   *
   * What readSlot() and captureBackup() need, and the same call the soft
   * key's handle offers, so a screen reading a slot presses whichever key it
   * is on. The console replays the whole press itself, so this resolves when
   * the line is written rather than when the hold ends - the library waits
   * on the typed reports, not on this.
   */
  const holdTicks = useCallback(
    async (button: number, ticks: number) => {
      if (!canPress) {
        throw new Error(unsupported(`hold button ${button}`));
      }
      const {device: dev} = await getOnlyKey('usb');
      await dev.press(`${button}#${ticks}`);
    },
    [canPress],
  );

  /**
   * Set a PIN.
   *
   * The library owns the bracket. It needs the debug console on any firmware
   * - the conversation is held entirely in the firmware's own printf output -
   * so this refuses by name rather than starting something that cannot
   * finish. See FINDING-provisioning-needs-a-debug-build.md.
   */
  const provision = useCallback(
    async (pin: string) => {
      if (!capabilities || capabilities.debugConsole !== true) {
        throw new Error(unsupported('set a PIN'));
      }
      const {device: dev} = await getOnlyKey('usb');
      return dev.setPin(pin);
    },
    [capabilities],
  );

  return {
    state,
    device,
    markUnlocked,
    version,
    identity,
    capabilities,
    /* No LED signal from a hard key (see the table above); useKey's timer stands in. */
    settling: null as string | null,
    busy,

    /* Absent on a hard key. See the header - each is a fact, not a gap. */
    storageDir: '',
    led: [] as number[],

    restart,

    start,
    stop,
    connect,
    send,

    /*
     * PRESENT BUT REFUSING, rather than null.
     *
     * Threading a nullable function through eight screens buys nothing: they
     * would all have to guard it, and one that forgot would crash rather than
     * explain. `canPress` is what a screen reads to decide whether to DRAW a
     * keypad - and for a hard key the answer is usually no, because it has six
     * buttons under a finger. Calling it anyway says why by name.
     */
    press,
    beginHold,
    endHold,
    holdTicks,
    provision,

    /** The hold in progress, counted on the finger. See beginHold. */
    pressTicks,

    /** Whether a keypad is worth drawing at all. */
    canPress,

    /**
     * WHICH MODEL. Unlocked, from the letter the firmware appends to its
     * version; locked, from the "-D" a DUO appends to INITIALIZED. This used
     * to read only the first and so drew a Classic keypad for every locked
     * hard key, DUO included, on the assumption that a locked key says
     * nothing about its model - wrong, the firmware's sendInitialized does.
     * Untested on a hard DUO (the bench has a Classic); the parse is the
     * library's, covered by its tests, and a bare INITIALIZED still reads
     * as Classic here exactly as before.
     */
    model: (identity?.model === 'duo' || (!identity && lockedModel === 'duo')
      ? 'duo' : 'classic') as 'duo' | 'classic',
  };
}

/**
 * Why a hard key will not do something in software.
 *
 * One message, because the reason is always the same one and a person should
 * not have to collect three phrasings of it.
 */
function unsupported(what: string): string {
  return (
    `this key cannot ${what} from software. The firmware's debug console ` +
    'grew that ability after v3.0.2 and it is compiled out of a production ' +
    'build - so on this one, a finger on the key is the only way.'
  );
}

const UNLOCK_GRACE_MS = 1500;

/** One firmware main-loop iteration, the unit a press is banded in. See press.js. */
const MS_PER_TICK = 36;

const IFACE_NAME: Record<number, string> = {
  [IFACE.KEYBOARD]: 'kbd',
  [IFACE.FIDO]: 'fido',
  [IFACE.VENDOR]: 'vendor',
  [IFACE.SEREMU]: 'debug',
};

export type HardKeySession = ReturnType<typeof useHardKey>;
