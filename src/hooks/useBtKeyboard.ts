import {bytes as okbytes} from 'node-onlykey-lib';
import {useCallback, useEffect, useRef, useState} from 'react';
import NativeBtKeyboard from '../../specs/NativeBtKeyboard';
import type {BtHost, BtKeyboardStatusEvent} from '../../specs/NativeBtKeyboard';
import OkEmu, {IFACE} from '../transport/OkEmu';

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
 * How long to stay visible while a host is being paired.
 *
 * The platform's own ceiling, and pairing is a one-off - a keyboard that
 * announces itself to the room indefinitely is not what a security key should
 * do.
 */
const DISCOVERABLE_SECONDS = 300;

/** How often to ask the profile who is connected, while published. */
const HOST_POLL_MS = 3000;

export type BtKeyboard = {
  supported: boolean | null;
  /** 'unregistered' | 'registering' | 'registered' | 'connecting' | 'connected' | ... */
  state: string;
  message: string;
  /** The connected host's name, or ''. */
  host: string;
  /** What a host sees this phone called - the adapter name, not "OnlyKey". */
  localName: string;
  hosts: BtHost[];
  /** Whether firmware keystrokes are being forwarded to the host. */
  typing: boolean;
  /** Reports forwarded since the last connect - the only proof it is working. */
  sent: number;
  busy: boolean;
  error: string | null;

  publish: () => Promise<void>;
  withdraw: () => Promise<void>;
  refreshHosts: () => Promise<void>;
  connect: (address: string) => Promise<void>;
  makeDiscoverable: () => Promise<void>;
  setTyping: (on: boolean) => void;
};

export function useBtKeyboard(): BtKeyboard {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [state, setState] = useState('unregistered');
  const [message, setMessage] = useState('');
  const [host, setHost] = useState('');
  const [hosts, setHosts] = useState<BtHost[]>([]);
  const [localName, setLocalName] = useState('');
  const [typing, setTypingState] = useState(false);
  const [sent, setSent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Read from inside the stream subscription, which is attached once and must
   * not be torn down and rebuilt every time one of these changes - a report
   * that arrives during the gap is a character the host never sees.
   */
  const typingRef = useRef(false);
  const connectedRef = useRef(false);

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
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const sub = NativeBtKeyboard.onStatus((event: BtKeyboardStatusEvent) => {
      setState(event.state);
      setMessage(event.message);
      setHost(event.name || event.address);

      const connected = event.state === 'connected';
      connectedRef.current = connected;
      if (connected) setSent(0);
      /*
       * Forwarding stops when the host goes away, rather than being left armed
       * against nothing. Re-arming is the user's call: a keyboard that starts
       * typing the moment a laptop wakes up is not what anyone asked for.
       */
      if (!connected) {
        typingRef.current = false;
        setTypingState(false);
      }
    });
    return () => sub.remove();
  }, []);

  /* The forwarder. Attached once, for the life of the screen. */
  useEffect(() => {
    const off = OkEmu.on('stream', (e: {iface: number; dir: number; bytes: Uint8Array}) => {
      if (e.iface !== IFACE.KEYBOARD || e.dir !== 0) return;
      if (!typingRef.current || !connectedRef.current) return;
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
    return off;
  }, []);

  const refreshHosts = useCallback(async () => {
    try {
      const list = await NativeBtKeyboard.hosts();
      setHosts(list);

      /*
       * The list is the PROFILE's view, and it outranks ours.
       *
       * onConnectionStateChanged is a notification, and a connection made
       * while the app was re-registering - or before this screen mounted -
       * arrives without one. That happened: the profile listed a connected
       * host while the banner still read "connecting", which would have left
       * the Typing section hidden over a keyboard that was ready.
       */
      const live = list.find(h => h.connected);
      connectedRef.current = Boolean(live);
      if (live) {
        setState('connected');
        setHost(live.name || live.address);
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
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
      typingRef.current = false;
      setTypingState(false);
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

  const makeDiscoverable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const ok = await NativeBtKeyboard.requestDiscoverable(DISCOVERABLE_SECONDS);
      if (!ok) {
        setError('Staying hidden means no computer can find this keyboard to pair with.');
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, []);

  const setTyping = useCallback((on: boolean) => {
    typingRef.current = on && connectedRef.current;
    setTypingState(typingRef.current);
  }, []);

  return {
    supported,
    state,
    message,
    host,
    localName,
    hosts,
    typing,
    sent,
    busy,
    error,
    publish,
    withdraw,
    refreshHosts,
    connect,
    makeDiscoverable,
    setTyping,
  };
}
