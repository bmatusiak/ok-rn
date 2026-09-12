/**
 * The middle of the security key: BLE on one side, the firmware on the other.
 *
 *   browser --CTAP over BLE--> [Kotlin reassembles] --> here
 *          <--------------------[Kotlin fragments] <--- here
 *                                                        |
 *                                          CTAPHID over IFACE.FIDO
 *                                                        v
 *                                        the OnlyKey firmware, in this process
 *
 * This file is deliberately thin, and that is the result rather than the
 * ambition. The phone is NOT the authenticator - the firmware is, and it is a
 * real FIDO2 one (libraries/fido2/ctap.cpp dispatches the whole CTAP2 set). So
 * there is no CBOR to build here, no attestation to sign, no credential store
 * to keep. BLE and HID differ only in how they chop a message into fragments,
 * and both of those are already written: Kotlin does the BLE end, CtapHid does
 * the HID end, and the CTAP2 message in between is byte-identical.
 *
 * The translation itself lives in node-onlykey-lib (protocol/bridge.js) so it
 * is not Android-shaped. What is here is the wiring: which events, which
 * transport, and what to say when the device cannot answer.
 */
import {bytes as okbytes, protocol} from 'node-onlykey-lib';
import FidoGatt, {type CtapRequestEvent} from './transport/FidoGatt';
import type {OnlyKeyApp} from './onlykey';
import OkEmu from './transport/OkEmu';
import type {LogLevel} from './hooks/useLog';

/**
 * CTAP BLE command bytes (CTAP 2.1, section 11.2.9), WITHOUT the fragment flag.
 *
 * On the wire an initialisation fragment carries CMD | 0x80, so MSG appears as
 * 0x83 - and that is what this constant used to be. But the Kotlin assembler
 * strips the flag before handing the message up (CtapBleFramer.kt:98,
 * `command = head and 0x7f`), so what actually arrives here is 0x03.
 *
 * The mismatch discarded every request one line before it reached the
 * firmware: a real getInfo came in as 83 00 01 04, reassembled correctly, and
 * was then dropped as "not a CTAP2 message" while the host retried and gave
 * up. Comparisons below mask the flag off both sides so neither convention can
 * break it again.
 */
const CMD_MSG = protocol.ctaphid.CTAPHID.MSG;
const CMD_MASK = 0x7f;

/**
 * CTAP2_ERR_OPERATION_DENIED, for a request that cannot even be attempted.
 *
 * A locked device is the case that matters. okcore.cpp:639,651 gate FIDO
 * dispatch on `unlocked == true` and drop the packet SILENTLY otherwise - no
 * error frame - so forwarding to a locked device produces a timeout that is
 * indistinguishable from a dead one. Better to answer immediately and say so.
 */
const CTAP2_ERR_OPERATION_DENIED = protocol.ctaphid.CTAP2_STATUS.OPERATION_DENIED;

type Options = {
  log: (level: LogLevel, text: string) => void;
  /** The request in flight, or null when there is none. For the UI. */
  onPending?: (event: CtapRequestEvent | null) => void;
  /** The firmware is waiting for a button. Also for the UI. */
  onPresence?: (needed: boolean) => void;

  /**
   * The key to bridge TO, supplied rather than imported.
   *
   * This is not a component, so it cannot read which key is active - and it
   * used to call getOnlyKey() with no argument, which meant a browser asking
   * for a security key was always answered by the SOFT one even with a hard
   * key selected. Passing it in makes that a decision at the call site
   * rather than a default nobody sees.
   */
  getKey: () => Promise<OnlyKeyApp>;
};

/**
 * Connect the GATT server to the firmware. Returns an unsubscribe function.
 */
export function startFidoBridge({log, onPending, onPresence, getKey}: Options): () => void {
  let bridge: ReturnType<typeof protocol.bridge.createCtapBridge> | null = null;
  /* Which transport the cached bridge was built on - see ensureBridge. */
  let boundTo: unknown = null;

  /*
   * Built on first use, not here.
   *
   * getKey() boots the firmware and composes the Rectify app, which is not
   * something to do while a screen is mounting - and a bridge is useless until
   * a central actually connects, which may never happen.
   *
   * REBUILT WHEN THE KEY CHANGES. The cache used to be `if (bridge) return
   * bridge`, which bound the relay to whichever key was active when the FIRST
   * request arrived and kept it there. Switching keys afterwards moved
   * everything else in the app and left the browser talking to the old one.
   *
   * Compared by the transport OBJECT rather than a backend name: getKey()
   * returns one app per backend and caches it, so identity is exactly the
   * question being asked - is this the same device session as last time.
   */
  async function ensureBridge() {
    const {transport} = await getKey();
    if (bridge && boundTo === transport) {
      return bridge;
    }
    if (bridge) log('info', '[bridge] the active key changed; rebinding');
    boundTo = transport;
    bridge = protocol.bridge.createCtapBridge(transport, {
      log: (level: string, message: string) =>
        log(level === 'error' ? 'error' : 'info', `[bridge] ${message}`),
      timeoutMs: 10000,
      // The firmware waits up to nineteen seconds for a finger (ctap.h:173),
      // so anything shorter here would abandon ceremonies that were going to
      // succeed.
      presenceTimeoutMs: 25000,
    });
    return bridge;
  }

  async function onRequest(event: CtapRequestEvent) {
    const label = event.commandName || `0x${event.command.toString(16)}`;
    log('rx', `CTAP ${label} (${event.hex.length / 2} bytes)`);

    /*
     * Only MSG carries a CTAP2 command. PING is answered by the transport, and
     * CANCEL has no response at all - passing either to the firmware as though
     * it were CBOR would have it decode a command byte out of ping data.
     */
    if ((event.command & CMD_MASK) !== CMD_MSG) {
      log('info', `ignoring CTAP BLE command ${label} - not a CTAP2 message`);
      return;
    }

    onPending?.(event);
    try {
      if (!OkEmu.isRunning()) {
        log('error', 'a request arrived with no firmware running');
        await FidoGatt.respondToRequest(
          event.requestId,
          CTAP2_ERR_OPERATION_DENIED.toString(16).padStart(2, '0'),
        );
        return;
      }

      const active = await ensureBridge();
      const response = await active.handle(okbytes.fromHex(event.hex), {
        /*
         * Relayed, not swallowed. The firmware sends one keepalive when its
         * status changes and then goes quiet while it waits for a button; a
         * host hearing nothing for nineteen seconds gives up on a ceremony the
         * user is midway through confirming.
         */
        onKeepAlive: (status: number) => {
          // 0x02 is UP_NEEDED - the only status that means a human is wanted.
          if (status === 0x02) {
            onPresence?.(true);
          }
          return FidoGatt.sendKeepAlive(event.requestId, status);
        },
      });

      await FidoGatt.respondToRequest(event.requestId, okbytes.toHex(response));
      log('tx', `${label} -> status 0x${response[0].toString(16)} (${response.length} bytes)`);
    } catch (error) {
      /*
       * The bridge itself always returns a response, so reaching here means
       * the BLE side failed - the central went away mid-answer, usually. There
       * is nothing left to answer to; log it rather than retry into a link
       * that is gone.
       */
      log('error', `bridge: ${String(error)}`);
    } finally {
      onPending?.(null);
      onPresence?.(false);
    }
  }

  const off = FidoGatt.on('request', event => {
    // Fire and forget: the handler awaits the device, and blocking the event
    // emitter would stall the GATT callback thread it was dispatched from.
    void onRequest(event);
  });

  return () => {
    off();
    bridge = null;
  };
}
