import {useCallback, useEffect, useState} from 'react';
import FidoGatt, {
  type CtapRequestEvent,
  type GattState,
} from '../transport/FidoGatt';
import OkEmu from '../transport/OkEmu';
import {startFidoBridge} from '../fidoBridge';
import type {LogLevel} from './useLog';

type Options = {
  log: (level: LogLevel, text: string) => void;
};

export function useFidoGatt({log}: Options) {
  const [state, setState] = useState<GattState>('idle');
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
      log,
      onPending: setPending,
      onPresence: setPresenceNeeded,
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
    };
  }, [log]);

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
      await OkEmu.pressButton(1, 150);
      log('tx', 'button pressed');
    } catch (error) {
      log('error', 'confirm: ' + String(error));
    }
  }, [log]);

  return {state, mtu, supported, pending, presenceNeeded, start, stop, confirm};
}
