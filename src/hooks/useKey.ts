import {useCallback, useEffect, useMemo, useState} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {useOkEmu} from './useOkEmu';
import {useHardKey} from './useHardKey';
import UsbPipe, {VENDOR_ID, PRODUCT_ID} from '../transport/UsbPipe';
import type {LogLevel} from './useLog';
import type {Backend} from './keySession';
import {BACKEND_NAME} from './keySession';

/**
 * Which key the app is talking to, and how that is decided.
 *
 * TWO DEVICES, NEVER MERGED. The soft key and a hard key answer the same
 * protocol, so everything above the byte pipe is the same code - but they hold
 * different secrets, and no screen ever blends readings from both. This hook
 * picks one and hands it over; it does not combine them.
 *
 * ## Both hooks always run, and that is deliberate
 *
 * React does not allow a hook to be called conditionally, so `useOkEmu` and
 * `useHardKey` both run on every render and only the RESULT is chosen. That is
 * not waste: the soft key stays alive in the background, which is what makes
 * the two comparable - you can attach a real key, look at it, and go back
 * without the emulated one having been torn down and re-provisioned.
 *
 * ## The three modes
 *
 *   auto      attaching a hard key switches to it; unplugging returns to the
 *             soft one. Attach detection is already wired - the manifest
 *             carries a USB filter for these ids, which is why plugging one in
 *             raises the permission prompt.
 *   manual    the app stays where it is. Attaching only makes the other
 *             available.
 *   override  force one, whatever the mode and whatever is plugged in.
 *
 * The override is separate from the mode on purpose. "I am in auto but pinned
 * to the soft key for now" is a real thing to want during testing, and folding
 * it into the mode would make that state unreachable without changing a
 * preference you would then have to remember to change back.
 */
export type KeyMode = 'auto' | 'manual';

const MODE_KEY = 'ok-rn/key-source/mode';
const OVERRIDE_KEY = 'ok-rn/key-source/override';

/** How often to look for a hard key while in auto. */
const POLL_MS = 2000;

/**
 * ONE LOG PER KEY, not one between them.
 *
 * They were given the same buffer at first, and the result was a "Firmware"
 * log carrying whichever key happened to be active - so a line about a
 * device sat next to a line about a different device with nothing marking
 * the change. Two devices, two logs.
 */
export function useKey({
  softLog,
  hardLog,
}: {
  softLog: (level: LogLevel, text: string) => void;
  hardLog: (level: LogLevel, text: string) => void;
}) {
  const soft = useOkEmu({log: softLog, autoStart: true});
  const hard = useHardKey({log: hardLog});

  const [mode, setModeState] = useState<KeyMode>('manual');
  const [override, setOverrideState] = useState<Backend | null>(null);
  /**
   * Whether a hard key is on the bus. NULL until the first look.
   *
   * Three states, because "not yet checked" is not "not there" - and the one
   * that gets rendered is the difference between an honest label and a
   * confident lie.
   */
  const [attached, setAttached] = useState<boolean | null>(null);
  const [ready, setReady] = useState(false);

  /* The setting is remembered, so a phone does not forget between launches. */
  useEffect(() => {
    let alive = true;
    Promise.all([AsyncStorage.getItem(MODE_KEY), AsyncStorage.getItem(OVERRIDE_KEY)])
      .then(([storedMode, storedOverride]) => {
        if (!alive) return;
        if (storedMode === 'auto' || storedMode === 'manual') setModeState(storedMode);
        if (storedOverride === 'embedded' || storedOverride === 'usb') {
          setOverrideState(storedOverride);
        }
        setReady(true);
      })
      .catch(() => {
        /* No stored preference is not an error; the defaults stand. */
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Is a hard key there?
   *
   * POLLED rather than pushed, because the question is "is one present", not
   * "did one just arrive". A push-only answer misses the key that was already
   * attached when the app started - which is the common case, since plugging
   * one in is what launches the app.
   *
   * ALWAYS, not only while in auto. It was only in auto, to spare the
   * battery, and that produced a screen saying "no hard key attached" with a
   * key plainly plugged in - because nothing had looked. Reporting "we did
   * not check" as "there is nothing there" is the kind of confident wrong
   * answer this project keeps finding, and a two-second enumeration is a
   * cheaper price than an untrue label.
   */
  useEffect(() => {
    let alive = true;

    const look = async () => {
      try {
        const devices = await UsbPipe.listDevices();
        const found = devices.some(
          d => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID,
        );
        if (alive) setAttached(found);
      } catch {
        if (alive) setAttached(false);
      }
    };

    void look();
    const timer = setInterval(look, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const setMode = useCallback(async (next: KeyMode) => {
    setModeState(next);
    await AsyncStorage.setItem(MODE_KEY, next);
  }, []);

  const setOverride = useCallback(async (next: Backend | null) => {
    setOverrideState(next);
    if (next === null) {
      await AsyncStorage.removeItem(OVERRIDE_KEY);
    } else {
      await AsyncStorage.setItem(OVERRIDE_KEY, next);
    }
  }, []);

  /**
   * Which key wins.
   *
   * An override beats everything, including a key that is not plugged in - if
   * someone has forced the hard key, showing them the soft one instead would be
   * answering a different question than they asked.
   */
  const backend: Backend = useMemo(() => {
    if (override) return override;
    if (mode === 'auto' && attached === true) return 'usb';
    return 'embedded';
  }, [override, mode, attached]);

  const active = backend === 'usb' ? hard : soft;

  return {
    /** The key every screen should read. Never a blend of the two. */
    key: active,
    backend,
    name: BACKEND_NAME[backend],

    /** Both, for a screen whose whole job is to compare or to switch. */
    soft,
    hard,

    mode,
    setMode,
    override,
    setOverride,

    /** Whether a hard key is on the bus at all, regardless of what is active. */
    attached,

    /** False until the stored setting has been read, so nothing flickers. */
    ready,
  };
}

export type KeyControl = ReturnType<typeof useKey>;
