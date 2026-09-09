import {useCallback, useEffect, useRef, useState} from 'react';
import {getOnlyKey} from '../onlykey';
import OkEmu from '../transport/OkEmu';

/*
 * Getting the device into config mode, and knowing when it is there.
 *
 * Shared because more than one screen needs it: loading a key and setting a
 * backup passphrase are both OKSETPRIV, and OKSETPRIV is accepted only in
 * config mode or on a device's first use (okcore.cpp:452). Outside it the frame
 * is dropped with nothing said.
 *
 * Three firmware facts make this more than a button
 * (FINDING-loading-a-key-requires-config-mode.md,
 * FINDING-config-mode-unlock-is-silent.md):
 *
 *   entering config mode LOCKS the device      OnlyKey.ino:914-926
 *   unlocking in it is NEVER ANNOUNCED         OnlyKey.ino:707
 *   configmode is only cleared by a boot       okcore.cpp:161
 *
 * So this waits for the lock to prove the hold landed, then POLLS to discover
 * the unlock it will never be told about, and leaves the caller to say that a
 * restart is needed afterwards.
 */

/**
 * The hold that reaches config mode: 72..179 ticks on button 6.
 *
 * 80 sits inside it with room either side. This is the one sanctioned use of
 * the gesture band in the app, which is why `allowGesture` is passed here and
 * nowhere else.
 */
const CONFIG_TICKS = 80;

/** How long to wait for the device to lock before calling the hold a failure. */
const LOCK_TIMEOUT_MS = 8000;

/** How often to ask whether the PIN has been accepted. */
const PROBE_MS = 2500;

export type ConfigMode = {
  /** The hold landed and the device locked. */
  entered: boolean;
  /** And the PIN has since been accepted, which had to be discovered. */
  ready: boolean;
  entering: boolean;
  error: string | null;
  enter: () => Promise<void>;
};

export function useConfigMode(deviceState: string): ConfigMode {
  const [entered, setEntered] = useState(false);
  const [ready, setReady] = useState(false);
  const [entering, setEntering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locked = deviceState !== 'unlocked';

  /* The newest lock state, readable from inside an async callback. */
  const lockedRef = useRef(locked);
  useEffect(() => {
    lockedRef.current = locked;
  }, [locked]);

  const enter = useCallback(async () => {
    setEntering(true);
    setError(null);
    try {
      await OkEmu.holdTicks(6, CONFIG_TICKS, {allowGesture: true});

      /*
       * Wait for the lock rather than believing the press landed. holdTicks
       * resolving means the press was delivered and counted, not that payload()
       * acted on it - the firmware discards presses outright while
       * pending_operation is set, for up to twenty seconds after a security-key
       * ceremony, and skips the config-mode branch while a fade is running.
       */
      const deadline = Date.now() + LOCK_TIMEOUT_MS;
      while (Date.now() < deadline && !lockedRef.current) {
        await new Promise<void>(r => setTimeout(r, 250));
      }

      if (!lockedRef.current) {
        setError(
          'The key did not enter config mode. It ignores button presses for ' +
            'up to 20 seconds after a security-key ceremony, and while its LED ' +
            'is fading. Wait a moment and try again.',
        );
        return;
      }
      setEntered(true);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setEntering(false);
    }
  }, []);

  /*
   * Discover the unlock, because the device will not announce it.
   *
   * OKGETLABELS is on the config-mode allowlist (okcore.cpp:347) and answers
   * "Error device locked" unless unlocked, so a successful read is positive
   * proof. Polled rather than inferred from the INITIALIZED broadcast stopping,
   * because silence is also what a wedged device produces.
   */
  useEffect(() => {
    if (!entered || ready) return undefined;

    let stopped = false;
    const probe = async () => {
      try {
        const {device} = await getOnlyKey();
        await device.readLabels({timeoutMs: 2500});
        if (!stopped) setReady(true);
      } catch {
        /* Still locked, or busy. Ask again. */
      }
    };

    const timer = setInterval(probe, PROBE_MS);
    probe().catch(() => {});
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [entered, ready]);

  return {entered, ready, entering, error, enter};
}
