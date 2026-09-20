import {bytes as okbytes, protocol, transport as oktransport} from 'node-onlykey-lib';
import {secretBytes} from '../redact';
import {useCallback, useEffect, useRef, useState} from 'react';

import UsbPipe, {VENDOR_ID, PRODUCT_ID} from '../transport/UsbPipe';
import type {UsbDeviceInfo, UsbInterfaceInfo} from '../transport/UsbPipe';
import type {StatusEvent} from '../../specs/NativeUsbHid';
import type {LogLevel} from './useLog';

const {CTAPHID, BROADCAST_CID, cidNumber, Assembler, frame: encodeFrames} = protocol.ctaphid;
const {IFACE, DIR, usb} = oktransport;

/**
 * The byte-level USB panel's session - ON THE SHARED PIPE.
 *
 * This used to sit on its own transport (`UsbHid.ts`), which held a second
 * subscription to the native module and did its own CTAPHID reassembly. Two
 * owners of one native connection is how the panel and the hard key could
 * each believe the other's state: the panel's Connect rebuilt the transport
 * the library was talking through, and the library's disconnect left the
 * panel showing "connected". Now there is one pipe, `UsbPipe`, and this is a
 * window onto it: every report it carries, on every interface, in both
 * directions, plus a raw write and one framed request for poking the device
 * by hand.
 *
 * ## What went with the old transport
 *
 * - The transport selector (auto / usb / tcp). The TCP mock is not needed
 *   until iOS work starts, and the shared pipe opens USB; a selector that
 *   the pipe overrides on every start would be a control that does nothing.
 * - The duplicate CTAPHID assembler that subscribed PER MESSAGE and dropped
 *   a reply that arrived after a keepalive burst. One assembler lives here
 *   for the life of the panel, fed from the stream, and a request waits on
 *   what it reassembles rather than on its own short-lived listener.
 *
 * ## What is new
 *
 * An INTERFACE for the raw write. The old panel wrote everything to the
 * security-key interface; the device has four, three of them identical on
 * the wire except for their usage page, and the vendor and debug ones are
 * what a person poking a key by hand actually wants (FINDING #40). The
 * choice is drawn from what the pipe found, so an interface a production key
 * does not carry is not offered.
 */
type Options = {
  log: (level: LogLevel, text: string) => void;
};

export type UsbSession = ReturnType<typeof useUsbHid>;

export type ConnectionState = StatusEvent['state'] | 'idle';

/** Names for the raw-write selector; the library's own, so they cannot drift. */
export const IFACE_NAMES = [IFACE.KEYBOARD, IFACE.FIDO, IFACE.VENDOR, IFACE.SEREMU]
  .map(i => ({iface: i, name: String(usb.describe(i)?.name ?? i)}));

export function useUsbHid({log}: Options) {
  const [state, setState] = useState<ConnectionState>(
    UsbPipe.isRunning() ? 'connected' : 'idle',
  );
  const [devices, setDevices] = useState<UsbDeviceInfo[]>([]);
  const [interfaces, setInterfaces] = useState<UsbInterfaceInfo[]>(UsbPipe.interfaces());
  const [busy, setBusy] = useState(false);
  const [iface, setIface] = useState<number>(IFACE.VENDOR);

  /* One assembler for the security-key interface, for as long as the panel lives. */
  const assembler = useRef(new Assembler());
  const pendingInit = useRef<{nonce: Uint8Array; resolve: (ok: boolean) => void} | null>(null);

  useEffect(() => {
    const offStatus = UsbPipe.on('status', event => {
      setState(event.state);
      setInterfaces(UsbPipe.interfaces());
      const detail = event.message ? ' - ' + event.message : '';
      log(event.state === 'error' ? 'error' : 'info', '[' + event.transport + '] ' + event.state + detail);
    });

    const offStream = UsbPipe.on('stream', event => {
      const name = usb.describe(event.iface)?.name ?? String(event.iface);
      /* Device to host is OUT in this library. See UsbPipe's header. */
      const inbound = event.dir === DIR.OUT;
      /*
       * THE WIDEST LEAK OF THE THREE, and the only one with no truncation at
       * all: every report, every interface, both directions, in full. Slot
       * writes travel here, so stored passwords and TOTP seeds passed through
       * it as hex whenever somebody edited a slot - and a DUO types its PIN
       * into the vendor message body, so that went through too.
       */
      log(
        inbound ? 'rx' : 'tx',
        `${name} ${secretBytes(okbytes.formatHex(okbytes.toHex(event.bytes)))}`,
      );

      if (!inbound || event.iface !== IFACE.FIDO) return;
      const frame = assembler.current.push(event.bytes);
      if (!frame) return;
      log('rx', 'MSG cid=0x' + cidNumber(frame.cid).toString(16)
        + ' cmd=0x' + frame.cmd.toString(16) + ' len=' + frame.payload.length);

      const waiting = pendingInit.current;
      if (waiting && frame.cmd === CTAPHID.INIT) {
        pendingInit.current = null;
        const echoed = frame.payload.subarray(0, 8);
        waiting.resolve(okbytes.toHex(echoed) === okbytes.toHex(waiting.nonce));
      }
    });

    return () => {
      offStatus();
      offStream();
    };
  }, [log]);

  const refreshDevices = useCallback(async () => {
    try {
      const found = await UsbPipe.listDevices();
      setDevices(found);
      log('info', found.length ? 'found ' + found.length + ' USB device(s)' : 'no USB devices');
    } catch (error) {
      log('error', 'listDevices: ' + String(error));
    }
  }, [log]);

  /**
   * Open the pipe - or find it already open. UsbPipe.start() is idempotent,
   * so this cannot rebuild a connection the hard key is using; it reports
   * what is there.
   */
  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const result = await UsbPipe.start();
      setInterfaces(result.interfaces ?? []);
      setState('connected');
      log('info', `connected via ${result.transport}, ${result.interfaces?.length ?? 0} interfaces,`
        + ` vid=0x${VENDOR_ID.toString(16)} pid=0x${PRODUCT_ID.toString(16)}`);
    } catch (error) {
      log('error', 'connect: ' + String(error));
    } finally {
      setBusy(false);
    }
  }, [log]);

  const disconnect = useCallback(async () => {
    try {
      await UsbPipe.stop();
      setState('disconnected');
      setInterfaces([]);
    } catch (error) {
      log('error', 'disconnect: ' + String(error));
    }
  }, [log]);

  /**
   * One CTAPHID_INIT on the broadcast channel, checked against our nonce.
   *
   * The reply is matched by the standing assembler above, not by a listener
   * attached for this call: the old per-message subscription was attached
   * after the write had started and missed a reply that landed behind a
   * keepalive burst, which read as a device that did not answer.
   */
  const sendPing = useCallback(async () => {
    const nonce = new Uint8Array(8);
    for (let i = 0; i < nonce.length; i++) nonce[i] = Math.floor(Math.random() * 256);

    const answered = new Promise<boolean>(resolve => {
      pendingInit.current = {nonce, resolve};
      setTimeout(() => {
        if (pendingInit.current && pendingInit.current.nonce === nonce) {
          pendingInit.current = null;
          resolve(false);
        }
      }, 3000);
    });

    try {
      log('tx', 'CTAPHID_INIT nonce=' + okbytes.formatHex(nonce));
      const packets = encodeFrames(BROADCAST_CID, CTAPHID.INIT, nonce, UsbPipe.getPacketSize());
      for (const packet of packets) await UsbPipe.write(IFACE.FIDO, packet);
      log(await answered ? 'info' : 'error',
        await answered
          ? 'INIT reply echoes our nonce; channel is ours'
          : 'no INIT reply carrying our nonce within 3s');
    } catch (error) {
      pendingInit.current = null;
      log('error', 'sendMessage: ' + String(error));
    }
  }, [log]);

  /**
   * Raw bytes to the CHOSEN interface, padded to that interface's report.
   *
   * Reports are fixed-width and the widths differ: 64 on the RawHID
   * interfaces, 32 out on the debug console, nothing out on the keyboard.
   * Padding to the wrong width is a write the device half-reads.
   */
  const sendRaw = useCallback(
    async (hexInput: string) => {
      try {
        const clean = hexInput.replace(/[^0-9a-fA-F]/g, '');
        if (!clean.length || clean.length % 2 !== 0) {
          log('error', 'raw write needs an even number of hex digits');
          return;
        }
        const info = UsbPipe.interfaces().find(i => i.iface === iface);
        const width = info?.packetSizeOut || UsbPipe.getPacketSize();
        if (info && info.packetSizeOut === 0) {
          log('error', `${usb.describe(iface)?.name ?? iface} has no host-to-device endpoint`);
          return;
        }
        const bytes = okbytes.fromHex(clean);
        const padded = new Uint8Array(width);
        padded.set(bytes.subarray(0, width));
        await UsbPipe.write(iface, padded);
      } catch (error) {
        log('error', 'write: ' + String(error));
      }
    },
    [iface, log],
  );

  return {
    state,
    devices,
    interfaces,
    packetSize: UsbPipe.getPacketSize(),
    busy,
    iface,
    setIface,
    refreshDevices,
    connect,
    disconnect,
    sendPing,
    sendRaw,
  };
}
