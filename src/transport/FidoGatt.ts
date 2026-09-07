import NativeFidoGatt from '../../specs/NativeFidoGatt';
import type {
  AuthenticatorConfig,
  CtapRequestEvent,
  GattStatusEvent,
} from '../../specs/NativeFidoGatt';

export type {AuthenticatorConfig, CtapRequestEvent, GattStatusEvent};

export type GattState = 'idle' | 'advertising' | 'connected' | 'stopped' | 'error';

/** CTAP2 command bytes (CTAP 2.1, section 6). */
export const CTAP2 = {
  MAKE_CREDENTIAL: 0x01,
  GET_ASSERTION: 0x02,
  GET_INFO: 0x04,
  CLIENT_PIN: 0x06,
  RESET: 0x07,
  GET_NEXT_ASSERTION: 0x08,
} as const;

/** CTAP2 status codes used by the response path. */
export const CTAP2_STATUS = {
  OK: 0x00,
  INVALID_COMMAND: 0x01,
  INVALID_PARAMETER: 0x02,
  NOT_ALLOWED: 0x30,
  OPERATION_DENIED: 0x27,
  UNSUPPORTED_OPTION: 0x2b,
} as const;

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
