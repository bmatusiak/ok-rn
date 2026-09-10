import {useCallback, useEffect, useRef, useState} from 'react';
import {bytes as okbytes, device as device_, protocol, transport as oktransport} from 'node-onlykey-lib';

import UsbPipe from '../transport/UsbPipe';
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
        } else if (parsed.state === 'locked') {
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
        setCapabilities(null);
        setVersion('');
      }
    });

    setState(UsbPipe.isRunning() ? 'running' : 'stopped');

    return () => {
      offStream();
      offStatus();
    };
  }, [log]);

  const start = useCallback(async () => {
    setBusy(true);
    try {
      const result = await UsbPipe.start();
      setState('running');
      log('info', `[usb] opened ${result.interfaces?.length ?? 0} interfaces`);
      return result;
    } catch (error) {
      setState('error');
      log('error', `[usb] ${String(error)}`);
      return null;
    } finally {
      setBusy(false);
    }
  }, [log]);

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
    async (iface: number, msg: string) => {
      await UsbPipe.write(iface, protocol.okmsg.build({msg}));
    },
    [],
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
      const {device: dev} = await getOnlyKey('usb');
      /* One digit is one tap. The firmware replays it a press per iteration. */
      await dev.press(String(button));
    },
    [],
  );

  const canPress = Boolean(capabilities && capabilities.consolePress);

  return {
    state,
    device,
    version,
    identity,
    capabilities,
    busy,

    /* Absent on a hard key. See the header - each is a fact, not a gap. */
    storageDir: '',
    led: [] as number[],
    restart: null,

    start,
    stop,
    connect,
    send,

    /** Null unless the firmware's console can press. A hard key has buttons. */
    press: canPress ? press : null,
    canPress,
  };
}

const UNLOCK_GRACE_MS = 1500;

const IFACE_NAME: Record<number, string> = {
  [IFACE.KEYBOARD]: 'kbd',
  [IFACE.FIDO]: 'fido',
  [IFACE.VENDOR]: 'vendor',
  [IFACE.SEREMU]: 'debug',
};

export type HardKeySession = ReturnType<typeof useHardKey>;
