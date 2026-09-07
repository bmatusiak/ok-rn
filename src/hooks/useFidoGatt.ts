import {useCallback, useEffect, useState} from 'react';
import FidoGatt, {
  CTAP2_STATUS,
  type CtapRequestEvent,
  type GattState,
} from '../transport/FidoGatt';
import type {LogLevel} from './useLog';

type Options = {
  log: (level: LogLevel, text: string) => void;
};

export function useFidoGatt({log}: Options) {
  const [state, setState] = useState<GattState>('idle');
  const [mtu, setMtu] = useState(0);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [pending, setPending] = useState<CtapRequestEvent | null>(null);

  useEffect(() => {
    const offStatus = FidoGatt.on('status', event => {
      setState(event.state);
      setMtu(event.mtu);
      const detail = event.message ? ' - ' + event.message : '';
      log(event.state === 'error' ? 'error' : 'info', '[ble] ' + event.state + detail);
    });

    const offRequest = FidoGatt.on('request', event => {
      setPending(event);
      const name = event.commandName || '0x' + event.command.toString(16);
      const rp = event.rpId ? ' rp=' + event.rpId : '';
      log('rx', 'CTAP ' + name + rp + ' (' + event.hex.length / 2 + ' bytes)');
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
      offRequest();
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

  const approve = useCallback(async () => {
    if (!pending) {
      return;
    }
    try {
      // The CTAP2 response body is not built yet - see specs/NativeFidoGatt.ts.
      // Approving currently acks with status OK and an empty CBOR map (0xa0).
      await FidoGatt.respondToRequest(pending.requestId, '00a0');
      log('tx', 'approved ' + (pending.commandName || pending.requestId));
    } catch (error) {
      log('error', 'respond: ' + String(error));
    } finally {
      setPending(null);
    }
  }, [log, pending]);

  const deny = useCallback(async () => {
    if (!pending) {
      return;
    }
    try {
      await FidoGatt.rejectRequest(pending.requestId, CTAP2_STATUS.OPERATION_DENIED);
      log('tx', 'denied ' + (pending.commandName || pending.requestId));
    } catch (error) {
      log('error', 'reject: ' + String(error));
    } finally {
      setPending(null);
    }
  }, [log, pending]);

  return {state, mtu, supported, pending, start, stop, approve, deny};
}
