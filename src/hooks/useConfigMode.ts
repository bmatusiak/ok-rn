import {useCallback, useEffect, useRef, useState} from 'react';
import {useActiveKey} from './KeyContext';

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

/**
 * Takes the HANDLE of the key it is on, for its hold.
 *
 * It took nothing for a while - the device state it once watched is the
 * library's business now - and reached for OkEmu.holdTicks directly, so with
 * a hard key selected the config-mode gesture went to the SOFT key: the same
 * blend the slot editor, the backup screen and the BLE bridge had. The
 * gesture band is reached on a hard key through its console (6#80), which is
 * what its handle's holdTicks sends; the screen passes the handle it is on.
 */
type Holder = {
  holdTicks: (button: number, ticks: number, opts?: {allowGesture?: boolean}) => Promise<void>;
};

export function useConfigMode(emu: Holder): ConfigMode {
  /* The ACTIVE key. This runs for whichever one is selected. */
  const getKey = useActiveKey();

  const [entered, setEntered] = useState(false);
  const [ready, setReady] = useState(false);
  const [entering, setEntering] = useState(false);
  const [error, setError] = useState<string | null>(null);


  const enter = useCallback(async () => {
    setEntering(true);
    setError(null);
    try {
      const {device} = await getKey();

      /*
       * THE SEQUENCE IS THE LIBRARY'S; the pressing is ours.
       *
       * The gesture, the retry, and the lock-as-proof all live in
       * device.enterConfigMode() - they are properties of the firmware, and a
       * second host would otherwise work them out again. What stays here is
       * holdTicks, because pressing a button is platform-specific, and the
       * React state the screen renders.
       *
       * One attempt from here, not three. This is a person tapping a button
       * who can see what happened and try again; the suites pass a higher
       * count because nobody is watching them.
       */
      await device.enterConfigMode({
        hold: (button: number, ticks: number) =>
          emu.holdTicks(button, ticks, {allowGesture: true}),
        attempts: 1,
        lockMs: LOCK_TIMEOUT_MS,
      });
      setEntered(true);
    } catch (e) {
      setError(
        'The key did not enter config mode. It ignores button presses for ' +
          'up to 20 seconds after a security-key ceremony, and while its LED ' +
          'is fading. Wait a moment and try again.',
      );
    } finally {
      setEntering(false);
    }
  }, [emu, getKey]);

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
        const {device} = await getKey();
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
  }, [getKey, entered, ready]);

  return {entered, ready, entering, error, enter};
}
