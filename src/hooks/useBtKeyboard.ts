import AsyncStorage from '@react-native-async-storage/async-storage';
import {bytes as okbytes} from 'node-onlykey-lib';
import {useCallback, useEffect, useRef, useState} from 'react';
import NativeBtKeyboard from '../../specs/NativeBtKeyboard';
import type {BtHost, BtKeyboardStatusEvent} from '../../specs/NativeBtKeyboard';
import OkEmu, {IFACE} from '../transport/OkEmu';
import {reportsFor} from '../btTestText';
import UsbPipe from '../transport/UsbPipe';
import {useBackend} from './KeyContext';

/*
 * The soft key typing at a real computer.
 *
 * Everything a slot holds leaves the key as keystrokes - that is the whole
 * output channel, and on hardware it goes out over USB into whatever has focus.
 * The firmware here emits exactly the same reports on IFACE.KEYBOARD; until now
 * they only ever went to the decoder, which is how the app shows a password.
 * This puts them on a wire again.
 *
 * The forwarding is deliberately DUMB. It takes the eight bytes the firmware
 * produced and hands them to the radio unchanged - no text, no layout, no
 * retyping. The firmware already resolved the slot, applied the configured
 * keyboard layout and decided which usages to press; anything this layer added
 * would be a second implementation of that, free to disagree with the first.
 */

/** Reports are 8 bytes: [modifiers, reserved, usage x 6]. */
const REPORT_BYTES = 8;

/**
 * All keys up. Sent whenever forwarding stops, for any reason.
 *
 * A HID report is an ABSOLUTE state, not an event: "the H key is down now".
 * The release is a second report saying nothing is down. So if the stream ends
 * between those two - the key unplugged mid-word, the host dropped, the app
 * withdrew - the last thing the host heard was a key going DOWN, and it holds
 * it there and auto-repeats forever.
 *
 * Measured: a hard key was unplugged part-way through typing a backup and the
 * host kept repeating a character until the machine was restarted
 * (FINDING-a-stuck-key-outlives-the-keyboard.md).
 *
 * Cheap insurance - eight zero bytes - so it goes on every teardown path
 * rather than only the ones that seemed likely.
 */
const RELEASE_ALL = '0000000000000000';

/**
 * The host this phone types to, remembered across launches.
 *
 * Bonding is not choosing. A phone is paired with a car, a headset and three
 * computers, and exactly one of them is the thing you want a password typed
 * into - so which one has to be said once, deliberately, and then trusted.
 * Without it the only honest thing the app can do is wait for a host to
 * connect on its own, which is what made this so tedious: publish, then go
 * poke the computer, every time.
 */
const HOST_KEY = 'ok-rn/bt-keyboard/host';

/** Was useBtAuto's auto-keyboard preference; it is the same question. */
const FORWARD_KEY = 'ok-rn/bt/auto-keyboard';

/** How often to ask the profile who is connected, while published. */
const HOST_POLL_MS = 3000;

export type BtKeyboard = {
  supported: boolean | null;
  /** Whether the radio is on right now. Null until asked. */
  radioOn: boolean | null;
  /** 'unregistered' | 'registering' | 'registered' | 'connecting' | 'connected' | ... */
  state: string;
  message: string;
  /** The connected host's name, or ''. */
  host: string;
  /** What a host sees this phone called - the adapter name, not "OnlyKey". */
  localName: string;
  hosts: BtHost[];
  /** Reports forwarded since the last connect - the only proof it is working. */
  sent: number;
  busy: boolean;
  error: string | null;

  publish: () => Promise<void>;
  withdraw: () => Promise<void>;
  refreshHosts: () => Promise<void>;
  connect: (address: string) => Promise<void>;
  /** Whether the key's keystrokes cross the link - the keyboard's IO switch. */
  forwarding: boolean;
  setForwarding: (next: boolean) => void;
  /** The host address chosen to type to, or null if none has been chosen. */
  chosenHost: string | null;
  /** Choose the host to type to; null forgets the choice. */
  chooseHost: (address: string | null) => Promise<void>;
  /**
   * Types a literal string at the host, bypassing the key entirely.
   *
   * A LINK TEST, not a typing path - see src/btTestText.ts. It answers "is
   * anything crossing this link" without pressing a slot and firing real
   * credentials at whatever window has focus.
   *
   * Resolves with how many characters it could not encode.
   */
  sendText: (text: string) => Promise<{sent: number; skipped: string[]}>;
  /**
   * Stop relaying while the app is deliberately making the key type.
   *
   * A BACKUP IS TYPED. `captureBackup` holds button 1 into the gesture band and
   * the key emits its whole encrypted backup as keystrokes, which the library
   * reads off the same IFACE.KEYBOARD stream this bridge forwards. With a host
   * connected, that went to the host too - measured twice, landing in a
   * terminal on the paired computer
   * (FINDING-the-bridge-relayed-a-backup.md).
   *
   * The bridge cannot tell a backup from a password by looking at reports, and
   * should not try: it is deliberately dumb. What it CAN be told is "the app is
   * about to make the key talk, and none of it is for you".
   */
  suspend: (during: () => Promise<any>) => Promise<any>;
};

export function useBtKeyboard(): BtKeyboard {
  /*
   * ONE SOURCE, the active key. This forwarded the soft key's reports only,
   * which with a hard key selected meant the Bluetooth host got the wrong
   * key's typing - or, had both been forwarded, both keys' typing at once,
   * doubled. The two pipes emit the same stream shape; the backend picks
   * which one feeds the host, and a switch re-subscribes.
   */
  const backend = useBackend();
  const [supported, setSupported] = useState<boolean | null>(null);
  /*
   * The RADIO, which is not the same as support and changes under you.
   *
   * `supported` is asked once per mount and describes the phone. This one is
   * re-read on every status event, because somebody can turn Bluetooth off
   * while the tab is open and the screen has to follow.
   */
  const [radioOn, setRadioOn] = useState<boolean | null>(null);

  /*
   * A STALE REFUSAL OUTLIVES THE REASON FOR IT.
   *
   * The errors this hook sets are about a moment - a publish that was
   * refused, a profile that could not be reached - and every one of them was
   * sticky. So turning Bluetooth off and back on left the Keyboard panel
   * still reading "This phone does not offer the Bluetooth HID Device
   * profile" in red, under a radio that was now on and perfectly capable.
   *
   * Reported 2026-09-19. The radio coming back invalidates anything said
   * while it was down, so the slate is wiped and whatever is tried next
   * gets to speak for itself.
   */
  useEffect(() => {
    if (radioOn === true) setError(null);
  }, [radioOn]);
  const [state, setState] = useState('unregistered');

  /* Asked at most once per mount; a refusal must not become a prompt loop. */
  const askedPermission = useRef(false);
  const [message, setMessage] = useState('');
  const [host, setHost] = useState('');
  const [hosts, setHosts] = useState<BtHost[]>([]);
  const [localName, setLocalName] = useState('');
  const [sent, setSent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Read from inside the stream subscription, which is attached once and must
   * not be torn down and rebuilt every time one of these changes - a report
   * that arrives during the gap is a character the host never sees.
   */
  const connectedRef = useRef(false);

  /** True while something has deliberately made the key type - see `suspend`. */
  const suspendedRef = useRef(false);

  /*
   * THE KEYBOARD'S IO SWITCH, remembered across launches.
   *
   * PRESENCE AND CONSENT ARE DIFFERENT QUESTIONS. The HID profile is
   * published for as long as Bluetooth is on, because a host reads a device's
   * service list exactly once - when it pairs - and a keyboard that is only
   * published after a target has been chosen can never be in that list for a
   * computer being paired for the first time. So publishing is no longer the
   * switch. THIS is: whether the key's keystrokes cross the link.
   *
   * Read through a ref by the forwarder, which is attached once for the life
   * of the hook and must not be rebuilt every time this changes - a report
   * that arrives during the gap is a character the host never sees.
   */
  const [forwarding, setForwardingState] = useState(false);
  const forwardingRef = useRef(false);
  forwardingRef.current = forwarding;

  useEffect(() => {
    AsyncStorage.getItem(FORWARD_KEY)
      .then(value => setForwardingState(value === '1'))
      .catch(() => {});
  }, []);

  const setForwarding = useCallback((next: boolean) => {
    setForwardingState(next);
    void AsyncStorage.setItem(FORWARD_KEY, next ? '1' : '0');
    /* Nothing held across the change, either way. */
    NativeBtKeyboard.sendReport(RELEASE_ALL).catch(() => {});
  }, []);

  /** The chosen host's address, or '' until storage has been read. */
  const [chosenHost, setChosenHost] = useState<string | null>(null);

  /*
   * Read from inside refreshHosts, which must keep a stable identity - it is
   * the body of a poll that is torn down and rebuilt whenever its deps change,
   * and rebuilding it every time a choice is made would restart the interval.
   */
  const chosenHostRef = useRef<string | null>(null);
  chosenHostRef.current = chosenHost;

  /*
   * Read from inside the auto-connect timer for the same reason as the two
   * above: it must not tear the interval down and rebuild it every time a
   * connect attempt flips `busy`.
   */
  const busyRef = useRef(false);
  busyRef.current = busy;

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(HOST_KEY)
      .then(stored => {
        if (!cancelled && stored) setChosenHost(stored);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    NativeBtKeyboard.localName()
      .then(name => {
        if (!cancelled) setLocalName(name);
      })
      .catch(() => {});
    NativeBtKeyboard.isSupported()
      .then(ok => {
        if (!cancelled) setSupported(ok);
      })
      .catch(() => {
        if (!cancelled) setSupported(false);
      });
    NativeBtKeyboard.isRadioOn()
      .then(on => {
        if (!cancelled) setRadioOn(on);
      })
      .catch(() => {
        if (!cancelled) setRadioOn(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const sub = NativeBtKeyboard.onStatus((event: BtKeyboardStatusEvent) => {
      setState(event.state);
      setMessage(event.message);
      /*
       * Every status is also a chance to re-read the radio. The adapter
       * receiver emits on both edges, so this is what makes the screen follow
       * a switch flipped in Android settings rather than waiting for a remount.
       */
      NativeBtKeyboard.isRadioOn()
        .then(setRadioOn)
        .catch(() => setRadioOn(false));
      setHost(event.name || event.address);

      const connected = event.state === 'connected';
      connectedRef.current = connected;
      if (connected) setSent(0);
      /* The host went away mid-word: say everything is up, in case it comes
         back to a keyboard it still thinks is holding a key down. */
      if (!connected) NativeBtKeyboard.sendReport(RELEASE_ALL).catch(() => {});
    });
    return () => sub.remove();
  }, []);

  /* The forwarder. Attached once, for the life of the screen. */
  useEffect(() => {
    const pipe = backend === 'usb' ? UsbPipe : OkEmu;
    const off = pipe.on('stream', (e: {iface: number; dir: number; bytes: Uint8Array}) => {
      if (e.iface !== IFACE.KEYBOARD || e.dir !== 0) return;
      if (!forwardingRef.current) return;
      if (suspendedRef.current || !connectedRef.current) return;
      if (e.bytes.length !== REPORT_BYTES) return;

      /*
       * Not awaited. Reports are a stream of absolute keyboard states and they
       * have to keep their order and their pace; awaiting each one would make
       * every keystroke a round trip through the bridge, and a slow one would
       * hold up the ones behind it. A dropped report is a lost character, and
       * the count is what says whether that happened.
       */
      NativeBtKeyboard.sendReport(okbytes.toHex(e.bytes))
        .then(ok => {
          if (ok) setSent(n => n + 1);
        })
        .catch(() => {});
    });
    return () => {
      off();
      /*
       * Let go of whatever was held. This runs when the ACTIVE KEY CHANGES as
       * well as on unmount - and a key switch mid-keystroke is exactly the
       * case that strands a key down on the host.
       */
      NativeBtKeyboard.sendReport(RELEASE_ALL).catch(() => {});
    };
  }, [backend]);

  const refreshHosts = useCallback(async () => {
    try {
      const list = await NativeBtKeyboard.hosts();
      setHosts(list);

      /*
       * A TARGET THAT NO LONGER EXISTS IS NOT A TARGET.
       *
       * The choice is remembered in storage and was never reconciled against
       * what is actually bonded, so unpairing the computer left the app
       * pointing at an address that is gone. Nothing on screen was selected -
       * not the vanished host, which is no longer in the list, and not "None",
       * which is a distinct stored value - so the radio group showed no
       * selection at all, while the auto-connect timer went on dialling the
       * ghost every few seconds.
       *
       * Demoting to None here is safe because this list is
       * `adapter.bondedDevices` (NativeBtKeyboardModule.kt:340), not a scan and
       * not the profile's connectedDevices: absence means the BOND is gone,
       * which is exactly the thing that cannot come back on its own. An empty
       * list is therefore meaningful rather than suspicious - it is what
       * unpairing the only computer looks like - and every caller of this
       * function runs with the profile registered, which cannot be true with
       * the radio off. That is the difference from the promote-only rule
       * below, which guards a list that CAN be transiently empty.
       */
      const chosen = chosenHostRef.current;
      if (chosen && !list.some(h => h.address === chosen)) {
        setChosenHost(null);
        void AsyncStorage.removeItem(HOST_KEY);
      }

      /*
       * THIS POLL MAY PROMOTE, NEVER DEMOTE.
       *
       * It exists for one case: a connection made while the app was
       * re-registering, or before this screen mounted, arrives with no
       * onConnectionStateChanged at all. That happened - the profile listed a
       * connected host while the banner still read "connecting", which hid the
       * Typing section over a keyboard that was ready. So finding a live host
       * here is still worth acting on.
       *
       * What it must NOT do is clear `connectedRef` when the list looks empty,
       * which is what it used to do, every three seconds. The two sides do not
       * mean the same thing: this list is built from the profile's
       * `connectedDevices` (NativeBtKeyboardModule.kt:337-343), while the thing
       * that actually sends is `currentHost()` - the device the connection
       * callback handed us (:307). Measured: `connectedDevices` came back empty
       * while the callback's host was live and sending, so the ref went false,
       * the forwarder stopped, and NOTHING on screen changed - the banner still
       * said `connected` while the forwarder was dead, because only the ref was
       * touched. A keyboard that had quietly stopped being a keyboard.
       *
       * Disconnection has an authority already, and it is the callback:
       * onStatus moves the ref and the banner together, so the two cannot
       * disagree. See FINDING-the-keyboard-silently-disarmed-itself.md.
       */
      const live = list.find(h => h.connected);
      if (live) {
        connectedRef.current = true;
        setState('connected');
        setHost(live.name || live.address);
      }
    } catch (e) {
      const message = String((e as Error)?.message ?? e);

      /*
       * THE PERMISSION IS ASKED FOR HERE, AND THIS IS THE ONLY PLACE IT CAN BE.
       *
       * It used to be asked for only inside publish(), which produced a
       * deadlock a fresh install could not escape:
       *
       *   hosts() rejects without BLUETOOTH_CONNECT
       *     -> the host list is empty
       *       -> the publish switch is disabled, because it is disabled until a
       *          host is chosen
       *         -> publish() never runs
       *           -> the permission is never requested
       *
       * From the outside that reads as "my computer is paired but the app does
       * not show it, and the keyboard never connects" - which is exactly how it
       * was reported, and it sent us looking at the HID descriptor, the Bluetooth
       * profile and the pairing, none of which were involved. Measured on a
       * factory-reset phone 2026-09-17; every grant before that was inherited
       * from an older install, so nobody had ever seen a first run.
       *
       * Asked once per mount, on the screen that needs it, which is what an
       * Android app is supposed to do. A refusal is reported as something a
       * person can act on rather than as the raw rejection.
       */
      if (/not been granted|permission/i.test(message) && !askedPermission.current) {
        askedPermission.current = true;
        const granted = await NativeBtKeyboard.requestPermissions().catch(() => false);
        if (granted) {
          try {
            const list = await NativeBtKeyboard.hosts();
            setHosts(list);
            setError(null);
            return;
          } catch {
            /* Fall through to the message below. */
          }
        }
        setError(
          'Bluetooth permission is needed before this phone can be a keyboard, ' +
            'and before it can list the computers it is paired with.',
        );
        return;
      }
      setError(message);
    }
  }, []);

  /*
   * A host connects when it feels like it - on waking, on being unlocked, on
   * being carried back into range - and none of that is prompted from here. So
   * while the keyboard is published the profile is asked periodically rather
   * than waited on.
   */
  useEffect(() => {
    if (state === 'unregistered' || state === 'unsupported') return undefined;
    const timer = setInterval(() => {
      void refreshHosts();
    }, HOST_POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const publish = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const granted = await NativeBtKeyboard.requestPermissions();
      if (!granted) {
        setError('Bluetooth permission was declined, so the keyboard cannot be published.');
        return;
      }
      const ok = await NativeBtKeyboard.register();
      if (!ok) {
        setError('This phone does not offer the Bluetooth HID Device profile.');
        return;
      }
      await refreshHosts();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [refreshHosts]);

  const withdraw = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      /* Nothing held, before the profile goes away and cannot say so. */
      await NativeBtKeyboard.sendReport(RELEASE_ALL).catch(() => {});
      await NativeBtKeyboard.unregister();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, []);

  const connect = useCallback(async (address: string) => {
    setBusy(true);
    setError(null);
    try {
      await NativeBtKeyboard.connect(address);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Choose the host to type to, or clear the choice with null.
   *
   * Choosing connects straight away rather than waiting for the next poll,
   * because someone who just picked a computer means now.
   */
  const chooseHost = useCallback(
    async (address: string | null) => {
      setChosenHost(address);
      if (address === null) {
        await AsyncStorage.removeItem(HOST_KEY);
        /*
         * AND DROP THE LINK. Forgetting the preference used to be all this
         * did, so the panel said "nothing is targeted" while the HID
         * connection stayed up and the key went on typing at that computer.
         *
         * That is not a cosmetic disagreement. The same panel says
         * "Everything <key> types goes to NITRO16", so someone choosing None
         * to STOP typing at a machine was told it had worked when it had not -
         * and the next slot they pressed went there anyway.
         *
         * Release first, for the same reason withdraw() does: a modifier held
         * when the link goes is a modifier stuck down on the host.
         */
        await NativeBtKeyboard.sendReport(RELEASE_ALL).catch(() => {});
        await NativeBtKeyboard.disconnect().catch(() => {});
        return;
      }
      await AsyncStorage.setItem(HOST_KEY, address);
      if (!connectedRef.current) void connect(address);
    },
    [connect],
  );

  /*
   * AUTO-CONNECT, but only to the host that was chosen.
   *
   * A keyboard that dials whatever it finds is a keyboard that types a
   * password into the wrong computer, so this never guesses: no choice, no
   * attempt. With a choice it is safe to be persistent, which is the whole
   * point of asking for one.
   *
   * Piggy-backs on the host poll that already runs while published rather than
   * adding a second timer, and only fires while disconnected - `connect()` on a
   * live link is at best a no-op and at worst tears it down.
   */
  useEffect(() => {
    if (state === 'unregistered' || state === 'unsupported') return undefined;
    if (!chosenHost) return undefined;
    const timer = setInterval(() => {
      if (connectedRef.current || busyRef.current) return;
      void connect(chosenHost);
    }, HOST_POLL_MS);
    return () => clearInterval(timer);
  }, [state, chosenHost, connect]);

  /*
   * Deliberately NOT gated on `typing`. That flag governs whether the KEY's
   * keystrokes are forwarded, which is a standing state someone arms and
   * disarms; this is one explicit action with its own button, and requiring
   * both would mean arming the live path to test the dead one.
   *
   * Still gated on a connected host: sendReport against nothing throws per
   * report, and a hundred rejected promises is not a useful error message.
   */
  /*
   * A ref, not state, for the same reason the other two are: the subscription
   * is attached once and reads this live. Restoring in `finally` so a failed
   * capture cannot leave the bridge muted for the rest of the session.
   */
  const suspend = useCallback(async (during: () => Promise<any>): Promise<any> => {
    suspendedRef.current = true;
    try {
      return await during();
    } finally {
      /* Whatever the key was holding when it stopped, it is not held now. */
      NativeBtKeyboard.sendReport(RELEASE_ALL).catch(() => {});
      suspendedRef.current = false;
    }
  }, []);

  const sendText = useCallback(async (text: string) => {
    const {reports, skipped} = reportsFor(text);
    if (!connectedRef.current) {
      throw new Error('no host is connected');
    }
    let sentNow = 0;
    for (const report of reports) {
      /*
       * Awaited here, unlike the forwarder. Nothing is racing this - it is a
       * button, not a stream - and a test that reports "12 sent" should mean
       * the host acknowledged twelve.
       */
      const ok = await NativeBtKeyboard.sendReport(okbytes.toHex(report));
      if (ok) sentNow += 1;
    }
    setSent(n => n + sentNow);
    return {sent: sentNow, skipped};
  }, []);

  return {
    supported,
    radioOn,
    state,
    message,
    host,
    localName,
    hosts,
    sent,
    busy,
    error,
    publish,
    withdraw,
    refreshHosts,
    connect,
    forwarding,
    setForwarding,
    sendText,
    suspend,
    chosenHost,
    chooseHost,
  };
}
