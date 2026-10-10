import {noteRpId} from '../keyChainRecorder';
import {noteFidoAsk} from '../pressAsk';
import {protocol} from 'node-onlykey-lib';
import NativeFidoGatt from '../../specs/NativeFidoGatt';
import {ioPulse} from '../btActivity';
import {bytes as okbytes} from 'node-onlykey-lib';

/**
 * The relying-party id inside a CTAP2 request, or '' if it is not there.
 *
 * makeCredential (0x01) carries it as key 2, a map with a text "id";
 * getAssertion (0x02) carries it as key 1, a text string (CTAP 2.1 §6.1,
 * §6.2). Anything else - a PING, a getInfo, a payload that does not decode -
 * is '' rather than a throw, because this runs on every event and a bad
 * request must not take the listener down with it.
 */
/** a makeCredential's user (name, else display name), from the same CBOR; null when absent */
export function userFromPayload(hex: string): string | null {
  if (!hex) return null;
  try {
    const value = protocol.cbor.decode(okbytes.fromHex(hex));
    const user = value instanceof Map ? value.get(3) : null;
    if (!(user instanceof Map)) return null;
    const name = user.get('name') ?? user.get('displayName');
    return typeof name === 'string' && name ? name : null;
  } catch {
    return null;
  }
}

export function rpIdFromPayload(commandName: string, hex: string): string {
  if (!hex) return '';
  try {
    const value = protocol.cbor.decode(okbytes.fromHex(hex));
    if (!(value instanceof Map)) return '';
    if (commandName === 'makeCredential') {
      const rp = value.get(2);
      const id = rp instanceof Map ? rp.get('id') : null;
      return typeof id === 'string' ? id : '';
    }
    if (commandName === 'getAssertion') {
      const id = value.get(1);
      return typeof id === 'string' ? id : '';
    }
    return '';
  } catch {
    return '';
  }
}
import type {
  AuthenticatorConfig,
  CtapRequestEvent,
  PermissionStatus,
  GattStatusEvent,
} from '../../specs/NativeFidoGatt';

export type {AuthenticatorConfig, CtapRequestEvent, GattStatusEvent, PermissionStatus};

export type GattState = 'idle' | 'advertising' | 'connected' | 'stopped' | 'error';

/**
 * Did this request come from the target? The bridges' second gate - the
 * native one has already asked (setIoPolicy).
 *
 * Case-insensitive: the native side hands addresses out upper-case, but the
 * target comes out of storage, and a lower-case copy of the same computer
 * must not read as a stranger. A missing address or a missing target is
 * never a match - the gate fails shut.
 */
export function isFromTarget(address: string | undefined, target: string | null): boolean {
  if (!address || !target) return false;
  return address.toUpperCase() === target.toUpperCase();
}

/*
 * CTAP2 status codes, from the library.
 *
 * This file used to keep its own table, and it was WRONG in two places:
 * NOT_ALLOWED was 0x30, which the spec does not define at all, and
 * UNSUPPORTED_OPTION was 0x2b, which is really NO_CREDENTIALS. Since
 * rejectRequest() defaults to NOT_ALLOWED, every rejected BLE request went out
 * carrying an undefined status byte.
 *
 * Nothing about that was hard to get right; it was hard to NOTICE, because a
 * second copy of a spec table looks exactly like the first until someone
 * compares them. protocol/ctaphid.js is the one copy now, and a test there
 * asserts every sendable status is a code the spec defines.
 *
 * The command table that used to sit here went with it - it was byte-identical
 * to the library's CTAP2_CMD and nothing referenced it.
 */
const CTAP2_STATUS = protocol.ctaphid.CTAP2_STATUS;

export const DEFAULT_AUTHENTICATOR_CONFIG: AuthenticatorConfig = {
  displayName: 'OnlyKey Mobile',
  // Placeholder AAGUID. Replace with a registered one before shipping - relying
  // parties use it to identify the authenticator model.
  aaguid: '00000000000000000000000000000000',
  requireUserVerification: true,
  preferStrongBox: true,
};

export type FidoGattEvents = {
  status: (event: {state: GattState; message: string; mtu: number}) => void;
  request: (event: CtapRequestEvent) => void;
};

type Listener<K extends keyof FidoGattEvents> = FidoGattEvents[K];

class FidoGattClient {
  private readonly listeners = new Map<keyof FidoGattEvents, Set<Function>>();
  private nativeSubs: Array<{remove: () => void}> = [];
  private started = false;

  private ensureSubscribed(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    this.nativeSubs.push(
      NativeFidoGatt.onGattStatus((event: GattStatusEvent) => {
        this.emit('status', {
          state: event.state as GattState,
          message: event.message,
          mtu: event.mtu,
        });
      }),
    );

    this.nativeSubs.push(
      NativeFidoGatt.onCtapRequest((event: CtapRequestEvent) => {
        ioPulse('key'); /* data in, from a computer: the status icons show it */
        /*
         * The native side reassembles the CTAP2 payload and hands it over as
         * hex; it never parsed the relying party out of it, so `rpId` was
         * '' on every event and the FIDO screen showed "-" for a year. The
         * library's CBOR decoder is the right parser and the wrong thing to
         * grow in Kotlin, so the id is filled in here, from the same bytes.
         */
        const withRp = event.rpId ? event : {...event, rpId: rpIdFromPayload(event.commandName, event.hex)};
        /* the Key Chain recorder names a FIDO derive by this rpId (the firmware reports only its hash) */
        noteRpId(withRp.rpId);
        /* the press sheet presents the site (and a register's user) beside the press (Brad, 2026-10-10) */
        if (withRp.commandName === 'makeCredential' || withRp.commandName === 'getAssertion') {
          noteFidoAsk(withRp.commandName, withRp.rpId, withRp.commandName === 'makeCredential' ? userFromPayload(event.hex) : null);
        }
        this.emit('request', withRp);
      }),
    );
  }

  on<K extends keyof FidoGattEvents>(event: K, listener: Listener<K>): () => void {
    this.ensureSubscribed();
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }

  private emit<K extends keyof FidoGattEvents>(
    event: K,
    ...args: Parameters<Listener<K>>
  ): void {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    for (const fn of set) {
      (fn as (...a: unknown[]) => void)(...args);
    }
  }

  isSupported(): Promise<boolean> {
    return NativeFidoGatt.isSupported();
  }

  requestPermissions(): Promise<boolean> {
    return NativeFidoGatt.requestPermissions();
  }

  permissionStatus(): Promise<PermissionStatus> {
    return NativeFidoGatt.permissionStatus();
  }

  requestNotificationPermission(): Promise<boolean> {
    return NativeFidoGatt.requestNotificationPermission();
  }

  openAppSettings(): void {
    NativeFidoGatt.openAppSettings();
  }

  configure(config: Partial<AuthenticatorConfig> = {}): void {
    NativeFidoGatt.configure({...DEFAULT_AUTHENTICATOR_CONFIG, ...config});
  }

  async startAdvertising(): Promise<void> {
    this.ensureSubscribed();
    await NativeFidoGatt.startAdvertising();
  }

  stopAdvertising(): Promise<void> {
    return NativeFidoGatt.stopAdvertising();
  }

  getState(): GattState {
    return NativeFidoGatt.getState() as GattState;
  }

  /** Who may talk to the key, over which door - see the spec. */
  setIoPolicy(target: string | null, webauthn: boolean, api: boolean): void {
    NativeFidoGatt.setIoPolicy(target, webauthn, api);
  }

  respondToRequest(requestId: string, hex: string): Promise<void> {
    ioPulse('key');
    return NativeFidoGatt.respondToRequest(requestId, hex);
  }

  /**
   * Tell the host the authenticator is still working, without answering yet.
   *
   * CTAP keepalive status: 0x01 PROCESSING, 0x02 UP_NEEDED.
   */
  sendKeepAlive(requestId: string, status: number): Promise<void> {
    ioPulse('key');
    return NativeFidoGatt.sendKeepAlive(requestId, status);
  }

  /** Reject a request with a CTAP2 status byte and no CBOR body. */
  rejectRequest(requestId: string, status: number = CTAP2_STATUS.NOT_ALLOWED): Promise<void> {
    ioPulse('key');
    return NativeFidoGatt.respondToRequest(requestId, status.toString(16).padStart(2, '0'));
  }

  createCredential(rpId: string, userHandleHex: string): Promise<string> {
    return NativeFidoGatt.createCredential(rpId, userHandleHex);
  }

  signWithCredential(credentialIdHex: string, payloadHex: string): Promise<string> {
    return NativeFidoGatt.signWithCredential(credentialIdHex, payloadHex);
  }

  destroy(): void {
    for (const sub of this.nativeSubs) {
      sub.remove();
    }
    this.nativeSubs = [];
    this.listeners.clear();
    this.started = false;
  }
}

export const FidoGatt = new FidoGattClient();
export default FidoGatt;
