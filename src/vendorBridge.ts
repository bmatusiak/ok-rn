/**
 * The VENDOR interface, relayed between the BLE vendor service and the key.
 *
 * ## What this is for
 *
 * The FIDO service carries CTAP, and the firmware serves exactly four OnlyKey
 * operations on that path - OKPING, OKCONNECT, OKSIGN, OKDECRYPT
 * (fido2/solo.cpp:74-81). Slots, labels, preferences, key loading, backup,
 * restore and config mode are all `recvmsg` on the VENDOR interface and cannot
 * be reached from FIDO at all. A host that wants to drive a key the way
 * `python-onlykey` drives a plugged-in one needs that interface over the radio.
 *
 * ## It is a PIPE, not a protocol
 *
 * Nothing here parses a report. A write from the host goes to IFACE.VENDOR
 * unexamined, and every vendor report the device produces is notified back
 * unexamined. That is deliberate: the vendor protocol is not request/response -
 * OKSETSLOT answers nothing, OKGETLABELS answers with a report per slot - so
 * there is no correlation to maintain and inventing one would drop every report
 * after the first of a multi-report answer.
 *
 * The host correlates, which is exactly what it does over USB: `pipeTransport`
 * subscribes before writing and filters with a predicate, and python's
 * `read_bytes()` polls until its own timeout and returns an empty list when
 * nothing came.
 *
 * ## Removable
 *
 * One file and one call in useFidoGatt. Delete both and nothing listens for
 * `iface: 'vendor'` events; the native side still raises them and a host gets
 * silence, which is the correct answer from a device that does not offer the
 * feature. `fidoBridge` never sees them either way - it ignores any interface
 * that is not its own.
 */
import {bytes as okbytes, transport as oktransport} from 'node-onlykey-lib';
import NativeFidoGatt from '../specs/NativeFidoGatt';
import FidoGatt, {type CtapRequestEvent} from './transport/FidoGatt';
import type {OnlyKeyApp} from './onlykey';
import type {LogLevel} from './hooks/useLog';

const IFACE_VENDOR = oktransport.IFACE.VENDOR;

type Options = {
  log: (level: LogLevel, text: string) => void;
  /** The key to relay to, supplied rather than imported - see fidoBridge. */
  getKey: () => Promise<OnlyKeyApp>;
  /** Whether requests should be served at all. Read through a function,
   *  because the bridge is attached once and the answer changes under it. */
  isRelaying?: () => boolean;
};

export function startVendorBridge({log, getKey, isRelaying}: Options): () => void {
  /* Which transport the report subscription is attached to, so a key change
   * moves it rather than leaving it listening to the previous device. */
  let boundTo: unknown = null;
  let offReport: (() => void) | null = null;

  /*
   * Sends are SERIALISED through this chain.
   *
   * The notify budget is per LINK - Android allows one outstanding
   * notification on a connection - and sendVendorReport rejects a second call
   * before the first has drained. A multi-report answer arrives as a burst of
   * 'report' events with nothing between them, so without a chain the first
   * would go out and the rest would reject.
   *
   * Ordering matters as much as delivery: the host reassembles a label list by
   * arrival, so reports must reach the wire in the order the device produced
   * them.
   */
  let sending: Promise<void> = Promise.resolve();

  function push(data: Uint8Array) {
    sending = sending
      .then(() => NativeFidoGatt.sendVendorReport(okbytes.toHex(data)))
      .catch((err: unknown) => {
        /*
         * Swallowed, and the chain continues. A failed notify is usually the
         * central having gone away mid-answer; letting it reject the chain
         * would leave every later report unsent with no way to recover short
         * of a reconnect.
         */
        log('info', `[vendor] report not delivered: ${String(err)}`);
      });
  }

  async function ensureSubscribed() {
    const {transport} = await getKey();
    if (boundTo === transport) return transport;
    if (offReport) {
      log('info', '[vendor] the active key changed; rebinding');
      offReport();
    }
    boundTo = transport;
    offReport = transport.on(
      'report',
      ({iface, data}: {iface: number; data: Uint8Array}) => {
        if (iface !== IFACE_VENDOR) return;
        if (isRelaying && !isRelaying()) return;
        push(data);
      },
    );
    return transport;
  }

  async function onRequest(event: CtapRequestEvent) {
    if (event.iface !== 'vendor') return;

    if (isRelaying && !isRelaying()) {
      log('info', '[vendor] relaying is off; the write was dropped');
      return;
    }

    try {
      const transport = await ensureSubscribed();
      const data = okbytes.fromHex(event.hex);
      log('rx', `[vendor] ${data.length} bytes -> the key`);
      await transport.write(IFACE_VENDOR, data);
    } catch (err) {
      /*
       * Nothing is sent back. There is no error report in the vendor protocol -
       * a real key that cannot act on a write simply does not answer - so the
       * faithful thing is silence and the host's own timeout. The log is where
       * this becomes visible.
       */
      log('error', `[vendor] write failed: ${String(err)}`);
    }
  }

  const off = FidoGatt.on('request', onRequest);

  return () => {
    off();
    if (offReport) offReport();
    offReport = null;
    boundTo = null;
  };
}
