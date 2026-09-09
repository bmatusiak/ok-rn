import {protocol} from 'node-onlykey-lib';
import NativeFidoGatt from '../../specs/NativeFidoGatt';
import type {
  AuthenticatorConfig,
  CtapRequestEvent,
  GattStatusEvent,
} from '../../specs/NativeFidoGatt';

export type {AuthenticatorConfig, CtapRequestEvent, GattStatusEvent};

export type GattState = 'idle' | 'advertising' | 'connected' | 'stopped' | 'error';

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
        this.emit('request', event);
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

  respondToRequest(requestId: string, hex: string): Promise<void> {
    return NativeFidoGatt.respondToRequest(requestId, hex);
  }

  /**
   * Tell the host the authenticator is still working, without answering yet.
   *
   * CTAP keepalive status: 0x01 PROCESSING, 0x02 UP_NEEDED.
   */
  sendKeepAlive(requestId: string, status: number): Promise<void> {
    return NativeFidoGatt.sendKeepAlive(requestId, status);
  }

  /** Reject a request with a CTAP2 status byte and no CBOR body. */
  rejectRequest(requestId: string, status: number = CTAP2_STATUS.NOT_ALLOWED): Promise<void> {
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
