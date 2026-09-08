import {useCallback, useEffect, useRef, useState} from 'react';
import {bytes as okbytes, protocol} from 'node-onlykey-lib';
import OkEmu, {DIR, IFACE, type Iface} from '../transport/OkEmu';
import {getOnlyKey} from '../onlykey';
import {bytesToHex} from '../transport/hex';
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

export type EmuState = 'unavailable' | 'stopped' | 'starting' | 'running' | 'error';

const IFACE_NAME: Record<number, string> = {
  [IFACE.KEYBOARD]: 'kbd',
  [IFACE.FIDO]: 'fido',
  [IFACE.VENDOR]: 'vendor',
  [IFACE.SEREMU]: 'debug',
};

export function useOkEmu({log, autoStart = false}: Options) {
  const [state, setState] = useState<EmuState>('stopped');
  const [storageDir, setStorageDir] = useState('');
  const [led, setLed] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
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
      const arrow = event.dir === DIR.OUT ? 'rx' : 'tx';
      log(
        arrow,
        `${IFACE_NAME[event.iface] ?? event.iface} ${okbytes
          .formatHex(bytesToHex(event.bytes))
          .slice(0, 71)}`,
      );
    });

    const offLed = OkEmu.on('led', pixels => setLed(pixels));

    const offRestart = OkEmu.on('restartRequested', () => {
      log('info', 'firmware requested CPU_RESTART()');
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
        setState('error');
        log('error', `start: ${result.message}`);
      }
    } catch (error) {
      setState('error');
      log('error', `start: ${String(error)}`);
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
      const {device} = await getOnlyKey();
      const result = await device.connect();
      log('info', `OKCONNECT -> "${String(result.status ?? '').trim()}"`);
      return result;
    } catch (error) {
      log('error', `OKCONNECT: ${String(error)}`);
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
        const {device} = await getOnlyKey();

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

  return {state, storageDir, led, busy, start, stop, restart, connect, provision, send};
}
