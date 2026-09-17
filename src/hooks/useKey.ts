import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {useOkEmu} from './useOkEmu';
import {useHardKey} from './useHardKey';
import UsbPipe, {VENDOR_ID, PRODUCT_ID} from '../transport/UsbPipe';
import {resetOnlyKey} from '../onlykey';
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
  fidoPending = null,
}: {
  softLog: (level: LogLevel, text: string) => void;
  hardLog: (level: LogLevel, text: string) => void;
  /** The FIDO ceremony in progress, if any - its end starts the settling timer. */
  fidoPending?: unknown;
}) {
  const soft = useOkEmu({log: softLog, autoStart: true});
  const hard = useHardKey({log: hardLog});

  /*
   * SETTLING AFTER A CEREMONY, for BOTH keys now.
   *
   * The firmware drops every press for up to twenty seconds after a FIDO2
   * ceremony, finished or not (FINDING-presses-discarded-after-a-fido-ceremony:
   * pending_operation is re-armed five seconds in and only fadeoffafter20sec
   * clears it).
   *
   * This used to apply to the hard key alone, because the soft key was
   * reading the window off its LED - and that was wrong, because the firmware
   * paints the same yellow for an ordinary press, for typing a slot and for
   * starting a backup (see useOkEmu, where the inference used to live). The
   * one thing this hook can actually see is the ceremony it relayed ending,
   * and that is the same fact for either backend.
   */
  const CEREMONY_SETTLE_MS = 20000;
  const [ceremonyEndedAt, setCeremonyEndedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const hadPending = useRef(false);
  useEffect(() => {
    const has = fidoPending !== null && fidoPending !== undefined;
    if (hadPending.current && !has) setCeremonyEndedAt(Date.now());
    hadPending.current = has;
  }, [fidoPending]);
  const settleUntil = ceremonyEndedAt === null ? 0 : ceremonyEndedAt + CEREMONY_SETTLE_MS;
  useEffect(() => {
    if (settleUntil <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [settleUntil]);
  const ceremonySettling = settleUntil > now
    ? `The key is settling after a security-key ceremony and drops every press for up to 20 seconds (${Math.ceil((settleUntil - now) / 1000)} s to go).`
    : null;

  /*
   * A PLUGGED-IN HARD KEY WINS BY DEFAULT.
   *
   * This defaulted to 'manual', which meant attaching a key changed nothing:
   * the app stayed on the soft key and the login screen kept offering its
   * keypad while the real key sat on the bus doing nothing. Someone who plugs
   * a key into a phone has said which key they mean.
   *
   * Only the DEFAULT moves - a stored setting still wins, so anyone who chose
   * 'manual' keeps it.
   */
  const [mode, setModeState] = useState<KeyMode>('auto');
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

    /*
     * A KEY THAT LEAVES THE BUS TAKES ITS SESSION WITH IT.
     *
     * The library session holds what is true of ONE physical key while it
     * stays plugged in: the transit key from OKCONNECT, the detected model,
     * and whether this session put the key into config mode. None of that
     * survives an unplug - a replugged key has rebooted, so it is out of
     * config mode, and it may not even be the same key.
     *
     * Nothing used to drop it. resetOnlyKey existed and only the e2e suites
     * called it, so a replug kept a session describing a device that had
     * physically gone away.
     *
     * Torn down on the DISAPPEARANCE rather than rebuilt on the arrival:
     * getOnlyKey builds one on demand, so the next thing that wants the key
     * gets a fresh session without anything having to predict when that is.
     */
    const look = async () => {
      try {
        const devices = await UsbPipe.listDevices();
        const found = devices.some(
          d => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID,
        );
        if (!alive) return;
        setAttached(was => {
          if (was === true && !found) void resetOnlyKey('usb');
          return found;
        });
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

  /*
   * A HARD-KEY OVERRIDE DOES NOT SURVIVE THE HARD KEY LEAVING.
   *
   * `backend` below still lets an override beat everything, and that is right
   * while both keys exist. It stops being right the moment the key is pulled:
   * the override then names something that is not on the bus, so the app sits
   * on a dead handle - "Enter your PIN on the key's own buttons", no keypad,
   * no LED - for a key that is in your pocket. Measured on the login screen:
   * pulling the key left the PIN screen on the hard-key branch with no way
   * back, because the Hard key / Soft Key row only draws when one is attached.
   *
   * Only the 'usb' direction clears. An override to the SOFT key is never
   * stranded - the soft key is always running - so someone who deliberately
   * chose it keeps it when they unplug.
   *
   * `attached === false` rather than falsy: null means USB has not answered
   * yet, which happens on every launch, and clearing on that would throw the
   * choice away before it was ever tested.
   *
   * setOverride, not setOverrideState: the stored value has to go too, or the
   * next launch reads it back and lands on the same dead handle with no key
   * ever having been plugged in.
   */
  useEffect(() => {
    if (attached === false && override === 'usb') void setOverride(null);
  }, [attached, override, setOverride]);

  /**
   * Which key wins.
   *
   * An override beats everything EXCEPT a hard key that has gone away - see
   * the effect above, which clears that case before this runs. Short of that,
   * if someone has forced a key, showing them the other one would be answering
   * a different question than they asked.
   */
  const backend: Backend = useMemo(() => {
    if (override) return override;
    if (mode === 'auto' && attached === true) return 'usb';
    return 'embedded';
  }, [override, mode, attached]);

  /**
   * SELECTING THE HARD KEY OPENS IT. Nothing else was doing that.
   *
   * The soft key auto-starts, the hard key never did, and this hook only
   * chose a handle - so picking Hard Key handed a screen a closed pipe
   * reporting `stopped`, which looks exactly like a key that is not working.
   *
   * And switching AWAY releases it. While the app holds the interfaces the
   * key cannot type into any other app on the phone, because claiming the
   * keyboard detaches it from the kernel. Keeping that after the user has
   * moved on would be rude as well as surprising.
   */
  const {start, connect: connectHard, state: hardState, busy: hardBusy} = hard;

  /*
   * What the backend WAS, so leaving the hard key is an event and not a
   * standing condition. Closing the pipe whenever it was open while the
   * soft key was selected fought every other owner: the e2e suites open the
   * pipe themselves, and the moment one did, the hard key's state became
   * 'running', this effect re-ran, and the pipe was shut under the suite -
   * "No open transport", three tests in a row. The app releases what IT
   * opened, when the person moves away from it; it does not police the bus.
   */
  const previousBackend = useRef<Backend>(backend);

  useEffect(() => {
    const left = previousBackend.current === 'usb' && backend !== 'usb';
    previousBackend.current = backend;

    if (backend !== 'usb') {
      if (left && UsbPipe.isRunning()) void UsbPipe.stop();
      return;
    }
    /*
     * OPEN, THEN ASK. connect() is what runs the console probe, and the
     * probe is what decides whether a screen draws a keypad for this key -
     * so a hard key that was opened but never connected left every lock
     * screen at "asking…" forever. The soft key connects itself on start;
     * this is the same courtesy.
     *
     * RE-OPENED WHEN IT STOPS, not only when it is selected. The e2e suite
     * hands the key back to the phone when it finishes, and a key that is
     * still the selected one then sat at "stopped" with a lock screen under
     * it until the app was relaunched - measured, on the This Key tab. Only
     * from 'stopped': an 'error' (unplugged, refused) is not retried in a
     * loop, and 'starting' is already on its way.
     */
    if (hardState === 'stopped' && !hardBusy && !UsbPipe.isRunning()) {
      void start().then(() => connectHard());
    }

    /*
     * No cleanup that closes: the branch above already handles leaving, and
     * closing here too would shut the pipe on any re-render that retriggered
     * this.
     *
     * DEPEND ON `hard.start`, NOT ON `hard`. useHardKey returns a fresh object
     * literal every render, so listing the whole handle re-runs this on EVERY
     * render - which stops and starts the USB pipe in a loop and locks the app
     * up hard enough that the screen stops painting. Measured, by doing it.
     * `start` is a useCallback and stable.
     */
  }, [backend, start, connectHard, hardState, hardBusy]);

  /**
   * AN ERRORED PIPE IS RETRIED, WITH BACKOFF.
   *
   * The effect above deliberately retries only from 'stopped', on the grounds
   * that retrying an error in a loop is worse than not retrying. That was half
   * right: not retrying AT ALL means one failed open strands the app until it
   * is relaunched, with a key sitting plugged in and the bus reporting it.
   *
   * Measured 2026-09-17, Android 17, key behind a powered hub: a replug killed
   * the pipe, the re-open errored once, and nothing ever tried again. Android
   * had the device enumerated at /dev/bus/usb/001/003 with matching vid/pid and
   * permission already granted - a manual Connect opened all four interfaces
   * first time. Nothing was wrong except that no one asked twice.
   *
   * So: ask again, but slower each time - 2s, 4s, 8s, up to 30s - and only
   * while a matching key is actually on the bus, so an unplugged key costs
   * nothing. The counter resets once the pipe runs, so a key that fails, is
   * fixed and comes back does not inherit the old delay.
   */
  const errorRetries = useRef(0);
  useEffect(() => {
    if (backend !== 'usb' || hardState === 'running') {
      errorRetries.current = 0;
      return;
    }
    /* Only an error is retried here; 'stopped' belongs to the effect above. */
    if (hardState !== 'error' || attached !== true || hardBusy) {
      return;
    }

    const wait = Math.min(30000, 2000 * 2 ** errorRetries.current);
    const timer = setTimeout(() => {
      errorRetries.current += 1;
      if (!UsbPipe.isRunning()) {
        void start().then(() => connectHard());
      }
    }, wait);
    return () => clearTimeout(timer);
  }, [backend, hardState, hardBusy, attached, start, connectHard]);

  const chosen = backend === 'usb' ? hard : soft;
  /*
   * The soft key's LED is exact - yellow for the whole window - so the timer
   * would only overstate it there; the timer is for the hard key, which shows
   * nothing.
   */
  /*
   * Applied to whichever key is active, not just the USB one: the window is a
   * property of the FIRMWARE, and both backends run the same firmware.
   */
  const active = {...chosen, settling: chosen.settling ?? ceremonySettling};

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
