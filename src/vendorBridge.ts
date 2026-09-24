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
import {bytes as okbytes, protocol, transport as oktransport} from 'node-onlykey-lib';
import NativeFidoGatt from '../specs/NativeFidoGatt';
import FidoGatt, {type CtapRequestEvent} from './transport/FidoGatt';
import type {OnlyKeyApp} from './onlykey';
import type {LogLevel} from './hooks/useLog';

const IFACE_VENDOR = oktransport.IFACE.VENDOR;

/*
 * THE ONE MESSAGE THIS BRIDGE WILL NOT CARRY: OKFWUPDATE.
 *
 * Everything else crosses unexamined, and that is still the design - this is a
 * transport for OPERATING a key, and a transport that second-guesses what it
 * carries is one whose behaviour stops matching a cable. This is the single
 * exception, and it is named rather than generalised into a denylist that
 * would have to stay right about every message the firmware ever adds.
 *
 * Why this one. OKFWUPDATE is the in-firmware update path, and on a physical
 * developer key it "locks the bootloader and permanently converts a developer
 * key into a production key" (onlykey-testing/TODO.md:408, the maintainer's
 * understanding, deliberately never tested). onlykey-testing gates it behind
 * `requires: ['emulated']` so its own hardware adapter can never send it.
 *
 * And this bridge CAN reach a physical key: it relays to whichever key is
 * active in the app (App.tsx passes getActiveKey), and a plugged-in hard key
 * takes priority. So without this a paired computer could send 0xf4 to real
 * hardware over the radio, unattended - the least supervised route there is to
 * an irreversible change.
 *
 * Refused for BOTH keys, not just the hard one, because the bench owner's rule
 * is that "hard key and soft key must work the same" - a feature that behaves
 * differently on the stand-in would stop proving anything about the real one.
 * And refused at all because firmware update is not ok-rn's job on this path:
 * "firmware update for production and development is completely different.
 * ok-rn should not handle doing the developer keys". A developer key is
 * reflashed through its HalfKay bootloader on a build host; a production key
 * takes a signed image through its own flow.
 */
const OK_HEADER: readonly number[] = protocol.okmsg.HEADER;
const OKFWUPDATE: number = protocol.MSG.OKFWUPDATE;

function isFirmwareUpdate(data: Uint8Array): boolean {
  if (data.length <= OK_HEADER.length) return false;
  for (let i = 0; i < OK_HEADER.length; i++) {
    if (data[i] !== OK_HEADER[i]) return false;
  }
  return data[OK_HEADER.length] === OKFWUPDATE;
}

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
      const data = okbytes.fromHex(event.hex);

      /*
       * Before ensureSubscribed(), so a refused write never so much as boots
       * the key. Silence rather than a reply, for the same reason as any other
       * write this bridge cannot act on: the vendor protocol has no error
       * report, so the host's own timeout is the faithful answer and the log is
       * where the refusal becomes visible.
       */
      if (isFirmwareUpdate(data)) {
        log('error', '[vendor] OKFWUPDATE refused - firmware update is not carried over Bluetooth');
        return;
      }

      const transport = await ensureSubscribed();
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
