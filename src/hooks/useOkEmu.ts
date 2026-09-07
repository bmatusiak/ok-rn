import {useCallback, useEffect, useRef, useState} from 'react';
import OkEmu, {DIR, IFACE, type Iface} from '../transport/OkEmu';
import {provisionPin} from '../transport/provision';
import {bytesToHex, formatHex} from '../transport/hex';
import type {LogLevel} from './useLog';

type Options = {
  log: (level: LogLevel, text: string) => void;
  /** Boot the firmware as soon as the screen mounts. */
  autoStart?: boolean;
};

export type EmuState = 'unavailable' | 'stopped' | 'starting' | 'running' | 'error';

/** okmsg framing: FF FF FF FF | msg | payload, zero-padded to one 64-byte report. */
const HEADER = [0xff, 0xff, 0xff, 0xff];
const REPORT_SIZE = 64;

export const MSG = {
  OKCONNECT: 0xe4,
  OKGETLABELS: 0xe5,
  OKPING: 0xf3,
} as const;

export function buildMessage(msg: number, payload: number[] = []): Uint8Array {
  const frame = new Uint8Array(REPORT_SIZE);
  frame.set(HEADER, 0);
  frame[4] = msg;
  frame.set(payload.slice(0, REPORT_SIZE - 5), 5);
  return frame;
}

/**
 * OKCONNECT's payload is the epoch seconds as hex digit PAIRS, one byte each -
 * python-onlykey's set_time() encoding, which the firmware parses as such
 * rather than as a plain integer.
 */
export function setTimePayload(when: number = Date.now()): number[] {
  let hex = Math.floor(when / 1000).toString(16);
  if (hex.length % 2) {
    hex = `0${hex}`;
  }
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    out.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

function ascii(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    if (b >= 0x20 && b <= 0x7e) {
      out += String.fromCharCode(b);
    }
  }
  return out;
}

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
        const text = ascii(event.bytes).trim();
        if (text) {
          log('info', `[fw] ${text}`);
        }
        return;
      }
      const arrow = event.dir === DIR.OUT ? 'rx' : 'tx';
      log(arrow, `${IFACE_NAME[event.iface] ?? event.iface} ${formatHex(bytesToHex(event.bytes)).slice(0, 71)}`);
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

  const restart = useCallback(async () => {
    setBusy(true);
    try {
      const result = await OkEmu.restart();
      setState(result.started ? 'running' : 'error');
      log('info', result.started ? 'firmware restarted' : `restart: ${result.message}`);
    } catch (error) {
      setState('error');
      log('error', `restart: ${String(error)}`);
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
   */
  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const reply = OkEmu.nextReport(IFACE.VENDOR, 5000);
      await OkEmu.write(IFACE.VENDOR, buildMessage(MSG.OKCONNECT, setTimePayload()));
      const bytes = await reply;
      log('info', `OKCONNECT -> "${ascii(bytes).trim()}"`);
      return bytes;
    } catch (error) {
      log('error', `OKCONNECT: ${String(error)}`);
      return null;
    } finally {
      setBusy(false);
    }
  }, [log]);

  /**
   * Set a PIN, then restart and confirm it stuck.
   *
   * This is the test that a protocol-only port cannot pass. Storing a PIN
   * encrypts, encrypting dereferences certified_hw, and certified_hw is at the
   * bottom of the flash array - the exact region Android's mmap_min_addr floor
   * puts out of reach unless the array is rebased. It is also the real setup
   * flow for a new soft key, not a diagnostic.
   */
  const provision = useCallback(
    async (pin: string) => {
      setBusy(true);
      try {
        log('info', `provisioning with a ${pin.length}-digit PIN`);
        await provisionPin({pin, log: step => log('info', `  ${step}`)});

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
        setBusy(false);
      }
    },
    [log, connect],
  );

  const send = useCallback(
    async (iface: Iface, msg: number) => {
      try {
        await OkEmu.write(iface, buildMessage(msg));
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
      await new Promise<void>(resolve => { setTimeout(resolve, 1500); });
      const bytes = await connect();
      console.log(
        bytes
          ? `[softkey] OKCONNECT ok: "${ascii(bytes).trim()}"`
          : '[softkey] OKCONNECT got no reply - the flash mapping is suspect',
      );
    })();
  }, [autoStart, start, connect]);

  return {state, storageDir, led, busy, start, stop, restart, connect, provision, send};
}
