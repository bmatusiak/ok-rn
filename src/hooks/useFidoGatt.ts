import AsyncStorage from '@react-native-async-storage/async-storage';
import {useCallback, useEffect, useRef, useState} from 'react';
import FidoGatt, {
  type CtapRequestEvent,
  type GattState,
} from '../transport/FidoGatt';
import OkEmu from '../transport/OkEmu';
import {startFidoBridge} from '../fidoBridge';
/* The vendor service, plugged in. Delete this import, the call below and
 * src/vendorBridge.ts to remove the feature; nothing else refers to it. */
import {startVendorBridge} from '../vendorBridge';
import type {OnlyKeyApp} from '../onlykey';
import type {LogLevel} from './useLog';

/*
 * The "WebAuthn" switch - the FIDO door's gate.
 *
 * The key name is historical and KEPT: this was the single "Authenticator"
 * switch, and before that useBtAuto's auto-authenticator preference. Renaming
 * the key would turn the switch off for everybody who had it on.
 */
const RELAY_KEY = 'ok-rn/bt/auto-authenticator';

/*
 * The "API" switch - the vendor door's gate, new.
 *
 * Off is the safe default for a fresh install. But until now the one
 * Authenticator switch opened BOTH doors, so somebody with it on has been
 * using the vendor service (onlykey-js --ble) all along. When no API value
 * has ever been stored, it starts from the saved WebAuthn value - and is
 * written straight back, so from then on the two are independent and
 * changing one never moves the other.
 */
const API_KEY = 'ok-rn/bt/auto-api';

type Options = {
  log: (level: LogLevel, text: string) => void;
  /** The ACTIVE key, resolved per call - see the note in useFidoGatt. */
  getKey: () => Promise<OnlyKeyApp>;
  /** Which backend that is, for the one decision that differs between them. */
  getBackend: () => string;
  /** Whether the active key is unlocked; see the gate in fidoBridge. */
  isUnlocked?: () => boolean;
};

export type FidoSession = ReturnType<typeof useFidoGatt>;

/**
 * The BLE authenticator session. Call this ONCE, at app scope - it owns the
 * GATT server's lifetime and the bridge that answers requests.
 */
export function useFidoGatt({log, getKey, getBackend, isUnlocked}: Options) {
  /*
   * THE KEY GETTER IS PASSED IN, and it has to be.
   *
   * This used to call useActiveKey(), with a comment saying "the ACTIVE key
   * answers the browser". It did not. This hook is created in App BEFORE
   * KeyBackendProvider wraps the tree - it must be, because useKey() needs
   * fido.pending and the provider is fed from useKey's own backend - so the
   * context read returned the DEFAULT, 'embedded', for the life of the app.
   *
   * The effect was invisible until someone tried it: every Bluetooth WebAuthn
   * ceremony was relayed to the SOFT key no matter which key was selected.
   * With the soft key locked or in config mode it answered nothing, the
   * browser sat on "talking to key" until it gave up, and the app cheerfully
   * showed "Forwarding to the firmware" the whole time. Found by the user on
   * a Pixel; it was never a Pixel problem.
   * See FINDING-the-ble-bridge-relayed-to-the-wrong-key.md.
   */

  /*
   * Seeded from the native side rather than assumed idle. The GATT server
   * outlives any particular mount, so starting at 'idle' would show a stopped
   * authenticator that was in fact advertising - and offer a Start button for
   * something already running.
   */
  const [state, setState] = useState<GattState>(() => {
    try {
      return FidoGatt.getState();
    } catch {
      return 'idle';
    }
  });
  /*
   * THE TWO DOORS' GATES, remembered across launches. "Each door has a gate,
   * and a device must be targeted."
   *
   * Separate from `state`, which is presence. Both GATT services are offered
   * for as long as Bluetooth is on - tearing one down is what taught Windows
   * to stop trusting the node - so these are the controls that mean "let a
   * request through", one per door: `webauthn` for the FIDO service (a
   * browser), `api` for the vendor service (onlykey-js --ble, python-onlykey).
   * They used to be one switch, `relaying`, which opened both at once.
   *
   * Neither means anything without a target: see `target` below.
   */
  const [webauthn, setWebAuthnState] = useState(false);
  const webauthnRef = useRef(false);
  webauthnRef.current = webauthn;
  const [api, setApiState] = useState(false);
  const apiRef = useRef(false);
  apiRef.current = api;
  /*
   * False until storage has been read - the same rule as useBtAuto's `ready`.
   * Pushing the in-memory defaults first would SHUT both doors on every JS
   * reload for the moment it takes to read them back, and a request arriving
   * in that moment would be refused for no reason the owner could see.
   */
  const [gatesRead, setGatesRead] = useState(false);

  useEffect(() => {
    Promise.all([AsyncStorage.getItem(RELAY_KEY), AsyncStorage.getItem(API_KEY)])
      .then(([savedWebAuthn, savedApi]) => {
        setWebAuthnState(savedWebAuthn === '1');
        if (savedApi === null) {
          /* Never stored: inherit the old one-switch answer - see API_KEY. */
          const inherited = savedWebAuthn === '1';
          setApiState(inherited);
          void AsyncStorage.setItem(API_KEY, inherited ? '1' : '0');
        } else {
          setApiState(savedApi === '1');
        }
        setGatesRead(true);
      })
      .catch(() => setGatesRead(true));
  }, []);

  const setWebAuthn = useCallback((next: boolean) => {
    setWebAuthnState(next);
    void AsyncStorage.setItem(RELAY_KEY, next ? '1' : '0');
  }, []);

  const setApi = useCallback((next: boolean) => {
    setApiState(next);
    void AsyncStorage.setItem(API_KEY, next ? '1' : '0');
  }, []);

  /*
   * THE TARGET: the one computer approved for IO, in both directions.
   *
   * Owned by the keyboard (useBtKeyboard's chosenHost - the Bluetooth tab's
   * target picker) and handed IN, because this hook is built above
   * BtKeyboardProvider and cannot read its context; App.tsx's IoPolicySync
   * sits inside the provider and calls setTarget. Null is None: nothing in,
   * nothing out - and it is also what holds until storage has been read, so
   * the gate starts shut rather than open.
   */
  const [target, setTargetState] = useState<string | null>(null);
  const targetRef = useRef<string | null>(null);
  targetRef.current = target;
  const setTarget = useCallback((next: string | null) => {
    setTargetState(next);
  }, []);
  const getTarget = useCallback(() => targetRef.current, []);

  /*
   * Told to the radio on every change, and once on mount. The native gate is
   * the one that counts - it is the only place that knows which central sent
   * a write - and it lives in the process, so a JS reload finds it as it was
   * left and this simply says it again.
   */
  useEffect(() => {
    if (!gatesRead) return;
    try {
      FidoGatt.setIoPolicy(target, webauthn, api);
    } catch (error) {
      log('error', 'setIoPolicy: ' + String(error));
    }
  }, [gatesRead, target, webauthn, api, log]);

  const [mtu, setMtu] = useState(0);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [pending, setPending] = useState<CtapRequestEvent | null>(null);
  const [presenceNeeded, setPresenceNeeded] = useState(false);

  useEffect(() => {
    const offStatus = FidoGatt.on('status', event => {
      setState(event.state);
      setMtu(event.mtu);
      const detail = event.message ? ' - ' + event.message : '';
      log(event.state === 'error' ? 'error' : 'info', '[ble] ' + event.state + detail);
    });

    /*
     * The bridge answers requests; nothing here does.
     *
     * This used to only log the request and wait for someone to tap Approve,
     * which replied with a hard-coded '00a0' - status OK and an empty CBOR map
     * - to every command including getInfo. A browser reading that learns the
     * authenticator supports nothing and gives up, so the flow appeared to
     * work while being incapable of registering a credential.
     */
    const offBridge = startFidoBridge({
      getKey,
      log,
      onPending: setPending,
      onPresence: setPresenceNeeded,
      isWebAuthn: () => webauthnRef.current,
      getTarget,
      isUnlocked,
    });

    /*
     * The VENDOR interface, on its own GATT service.
     *
     * ITS OWN SWITCH. It used to share the relay switch with FIDO, on the
     * theory that it was the same consent - "does the phone answer a host at
     * all". It is not: letting a browser make a WebAuthn assertion is a much
     * smaller thing than letting a computer read labels, set slots and load
     * keys, so the owner gave each door its own gate. The same target
     * applies to both. It does NOT share the unlocked check - a locked key is
     * silent over FIDO because the firmware drops the packet, but plenty of
     * vendor commands are exactly what a host sends to a locked key, OKSETPIN
     * among them.
     */
    const offVendor = startVendorBridge({
      getKey,
      log,
      isApi: () => apiRef.current,
      getTarget,
    });

    FidoGatt.isSupported()
      .then(value => {
        setSupported(value);
        if (!value) {
          log('error', 'BLE peripheral mode or hardware keystore unavailable on this device');
        }
      })
      .catch(error => log('error', 'isSupported: ' + String(error)));

    return () => {
      offStatus();
      offBridge();
      offVendor();
    };
  }, [getKey, getTarget, log]);

  const start = useCallback(async () => {
    try {
      const granted = await FidoGatt.requestPermissions();
      if (!granted) {
        log('error', 'Bluetooth permissions denied');
        return;
      }
      FidoGatt.configure();
      await FidoGatt.startAdvertising();
      log('info', 'advertising FIDO service 0xFFFD');
    } catch (error) {
      log('error', 'startAdvertising: ' + String(error));
    }
  }, [log]);

  const stop = useCallback(async () => {
    try {
      await FidoGatt.stopAdvertising();
    } catch (error) {
      log('error', 'stopAdvertising: ' + String(error));
    }
  }, [log]);

  /**
   * Confirm the ceremony - which means pressing a button on the device.
   *
   * User presence is not an app-level decision here. The firmware blocks in
   * ctap_user_presence_test() until touch_sense_loop() reports a press
   * (device.cpp:345-395), and it will not produce a credential without one, so
   * "approve" and "press a button" are the same act. Any button will do: for a
   * pending OKWEBAUTHN the challenge completes on any press
   * (OnlyKey.ino:821), unlike the three-digit challenge that guards signing.
   *
   * There is deliberately no Deny. Letting the ceremony time out IS the
   * refusal, and it is the refusal the host understands; a bridge that
   * synthesised its own denial would be answering for a device that had not
   * been asked.
   */
  const confirm = useCallback(async () => {
    try {
      /*
       * THE ACTIVE KEY'S BUTTON, not the soft key's. This pressed the
       * emulator directly, which with a hard key selected pressed a device
       * the ceremony was not waiting on - the bridge relays the hard key's
       * CTAP traffic (getKey is the active one) while the confirm went to
       * the other. Two devices, never blended.
       *
       * The soft key keeps the native press: it works on a production build
       * of the emulator too, where the console does not read.
       */
      /*
       * A HARD KEY IS PRESSED BY A FINGER. THE APP DOES NOT REACH FOR IT.
       *
       * This used to probe with consoleAnswers() and press through the console
       * when it answered. The probe is not free: it WRITES a byte to SEREMU,
       * the debug interface, which production firmware is compiled without -
       * and AdvancedScreen.tsx:173-197 records what that costs, measured:
       * "the USB pipe did not survive it. The key vanished and the app fell
       * back to its locked screen."
       *
       * That guard existed at the other probe sites and not at this one, so
       * confirming a security-key ceremony on a production key wrote into a
       * bricked-up interface every time.
       *
       * The console is a BACK DOOR - over it, unauthenticated, you can wipe
       * the key, restart it, or type its PIN. A shipped key not having it is
       * the security property, not a gap to route around, and the app has no
       * business knocking on a user path. The rule it now follows: the debug
       * interface belongs to the Testing tab and the e2e suites, nowhere else.
       *
       * Nothing is lost on a production key, which never took this press. A
       * DEVELOPER key loses app-driven confirm here and keeps it in Testing.
       */
      if (getBackend() === 'usb') {
        log('info', 'press the button on the key - the app does not press a hard key');
        return;
      } else {
        /* Handed over rather than sensed - a browser is waiting. */
        await OkEmu.pressQueue('1');
      }
      log('tx', 'button pressed');
    } catch (error) {
      log('error', 'confirm: ' + String(error));
    }
    /* No getKey: confirming no longer reaches the hard key at all. */
  }, [getBackend, log]);

  return {
    state,
    mtu,
    supported,
    pending,
    presenceNeeded,
    start,
    stop,
    confirm,
    webauthn,
    setWebAuthn,
    api,
    setApi,
    target,
    setTarget,
  };
}
