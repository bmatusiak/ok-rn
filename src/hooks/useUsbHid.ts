import {bytes as okbytes} from 'node-onlykey-lib';
import {useCallback, useEffect, useState} from 'react';
import UsbHid, {
  ONLYKEY_PRODUCT_ID,
  ONLYKEY_VENDOR_ID,
  type ConnectionState,
  type Transport,
  type UsbDeviceInfo,
} from '../transport/UsbHid';
import {CTAPHID} from '../transport/framing';
import type {LogLevel} from './useLog';

type Options = {
  log: (level: LogLevel, text: string) => void;
};

export type UsbSession = ReturnType<typeof useUsbHid>;

export function useUsbHid({log}: Options) {
  const [state, setState] = useState<ConnectionState>('idle');
  const [transport, setTransportState] = useState<Transport>('auto');
  const [devices, setDevices] = useState<UsbDeviceInfo[]>([]);
  const [packetSize, setPacketSize] = useState(64);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const offStatus = UsbHid.on('status', event => {
      setState(event.state);
      const detail = event.message ? ' - ' + event.message : '';
      log(event.state === 'error' ? 'error' : 'info', '[' + event.transport + '] ' + event.state + detail);
    });

    const offPacket = UsbHid.on('packet', bytes => {
      log('rx', okbytes.formatHex(okbytes.toHex(bytes)));
    });

    const offMessage = UsbHid.on('message', frame => {
      log(
        'rx',
        'MSG cid=0x' + frame.channelId.toString(16) +
          ' cmd=0x' + frame.command.toString(16) +
          ' len=' + frame.data.length,
      );
    });

    setTransportState(UsbHid.getTransport());

    return () => {
      offStatus();
      offPacket();
      offMessage();
    };
  }, [log]);

  const setTransport = useCallback(
    (next: Transport) => {
      UsbHid.setTransport(next);
      setTransportState(next);
      log('info', 'transport -> ' + next);
    },
    [log],
  );

  const refreshDevices = useCallback(async () => {
    try {
      const found = await UsbHid.listDevices();
      setDevices(found);
      log('info', found.length ? 'found ' + found.length + ' USB device(s)' : 'no USB devices');
    } catch (error) {
      log('error', 'listDevices: ' + String(error));
    }
  }, [log]);

  const connect = useCallback(
    async (vendorId = ONLYKEY_VENDOR_ID, productId = ONLYKEY_PRODUCT_ID) => {
      setBusy(true);
      try {
        const granted = await UsbHid.requestPermission(vendorId, productId);
        if (!granted) {
          log('error', 'USB permission denied');
          return;
        }
        const result = await UsbHid.connect(vendorId, productId);
        setPacketSize(result.packetSize);
        log('info', 'connected via ' + result.transport + ', packetSize=' + result.packetSize);
      } catch (error) {
        log('error', 'connect: ' + String(error));
      } finally {
        setBusy(false);
      }
    },
    [log],
  );

  const disconnect = useCallback(async () => {
    try {
      await UsbHid.disconnect();
    } catch (error) {
      log('error', 'disconnect: ' + String(error));
    }
  }, [log]);

  /** CTAPHID_INIT with an 8-byte nonce - the standard "is anyone there?" probe. */
  const sendPing = useCallback(async () => {
    const nonce = new Uint8Array(8);
    for (let i = 0; i < nonce.length; i++) {
      nonce[i] = Math.floor(Math.random() * 256);
    }
    try {
      log('tx', 'CTAPHID_INIT nonce=' + okbytes.formatHex(okbytes.toHex(nonce)));
      await UsbHid.sendMessage({
        channelId: 0xffffffff,
        command: CTAPHID.INIT,
        data: nonce,
      });
    } catch (error) {
      log('error', 'sendMessage: ' + String(error));
    }
  }, [log]);

  const sendRaw = useCallback(
    async (hexInput: string) => {
      try {
        const clean = hexInput.replace(/[^0-9a-fA-F]/g, '');
        if (!clean.length || clean.length % 2 !== 0) {
          log('error', 'raw write needs an even number of hex digits');
          return;
        }
        const bytes = new Uint8Array(clean.length / 2);
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
        }
        // HID reports are fixed-width; short payloads are zero-padded.
        const padded = new Uint8Array(packetSize);
        padded.set(bytes.subarray(0, packetSize));
        log('tx', okbytes.formatHex(okbytes.toHex(padded)));
        await UsbHid.writeRaw(padded);
      } catch (error) {
        log('error', 'write: ' + String(error));
      }
    },
    [log, packetSize],
  );

  return {
    state,
    transport,
    devices,
    packetSize,
    busy,
    setTransport,
    refreshDevices,
    connect,
    disconnect,
    sendPing,
    sendRaw,
  };
}
