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
 * The hold that reaches config mode, FROM THE DEVICE.
 *
 * A classic wants button 6 held past 72 main-loop iterations; a DUO wants
 * button 1 held past 180 (OnlyKey.ino:914). The numbers used to be a constant
 * here, which was right while every device was a classic and wrong the moment
 * one was not: holding the classic gesture at a DUO presses a button that does
 * something else, and then waits for a lock that never comes.
 *
 * The margin over the floor is small and deliberate. Past the same band a hold
 * stops being config mode and becomes another gesture, so overshooting is not
 * the safe direction. This is the app's one sanctioned use of the gesture band,
 * which is why `allowGesture` is passed here and nowhere else.
 */
const TICK_MARGIN = 8;
const FALLBACK_GESTURE = {button: 6, ticks: 72};

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
      const {device} = await getOnlyKey();
      const g =
        (device.capabilities && device.capabilities.configModeGesture) ||
        FALLBACK_GESTURE;
      await OkEmu.holdTicks(g.button, g.ticks + TICK_MARGIN, {allowGesture: true});

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
