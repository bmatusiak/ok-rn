import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';
import type {CodegenTypes} from 'react-native';

/**
 * CTAP2-over-BLE peripheral: turns the phone into a roaming FIDO2 authenticator
 * that desktop browsers can talk to. See EXPLAINER/z.md.
 *
 * STATUS: scaffold. The Kotlin side advertises the FIDO service and wires up the
 * GATT characteristics + BLE fragmentation, but the CTAP2/CBOR command handlers
 * and the KeyStore signing path are stubs that reject with CTAP2_ERR_NOT_ALLOWED.
 */

/** FIDO Bluetooth Service, 16-bit UUID 0xFFFD. */
export type GattStatusEvent = {
  /** 'idle' | 'advertising' | 'connected' | 'stopped' | 'error' */
  state: string;
  message: string;
  /** Negotiated ATT MTU; 0 until a central connects. */
  mtu: number;
};

/** One reassembled CTAP2 command awaiting a response from JS. */
export type CtapRequestEvent = {
  /** Opaque id to pass back to respondToRequest(). */
  requestId: string;
  /** CTAP BLE command byte: 0x83 MSG, 0x81 PING, 0x82 KEEPALIVE, 0x84 CANCEL. */
  command: number;
  /** CTAP2 command name if recognised, else ''. */
  commandName: string;
  /** Lowercase hex of the reassembled CTAP2 payload (CBOR after the first byte). */
  hex: string;
  /** Relying-party id if the payload parsed, else ''. */
  rpId: string;
};

export type AuthenticatorConfig = {
  /** Shown to the user in the biometric prompt. */
  displayName: string;
  /** AAGUID as 32 hex chars. */
  aaguid: string;
  /** Require BiometricPrompt before every getAssertion. */
  requireUserVerification: boolean;
  /** Use StrongBox-backed keys when the device has a dedicated secure element. */
  preferStrongBox: boolean;
};

export interface Spec extends TurboModule {
  /** BLE peripheral mode + advertising + hardware keystore all present. */
  isSupported(): Promise<boolean>;

  /**
   * Runtime permissions (BLUETOOTH_ADVERTISE / BLUETOOTH_CONNECT on API 31+).
   * Resolves true once every required permission is granted.
   */
  requestPermissions(): Promise<boolean>;

  configure(config: AuthenticatorConfig): void;

  /** Opens the GATT server and starts advertising service 0xFFFD. */
  startAdvertising(): Promise<void>;
  stopAdvertising(): Promise<void>;

  /** 'idle' | 'advertising' | 'connected' | 'stopped' | 'error' */
  getState(): string;

  /**
   * Answer a CtapRequestEvent. `hex` is the raw CTAP2 response
   * (status byte followed by CBOR), which the native side fragments
   * across the FIDO Status characteristic.
   */
  respondToRequest(requestId: string, hex: string): Promise<void>;

  /** Generate a P-256 credential key in the TEE/StrongBox. Returns credentialId hex. */
  createCredential(rpId: string, userHandleHex: string): Promise<string>;

  /** Sign with a hardware key, gated on BiometricPrompt. Returns DER signature hex. */
  signWithCredential(credentialIdHex: string, payloadHex: string): Promise<string>;

  readonly onGattStatus: CodegenTypes.EventEmitter<GattStatusEvent>;
  readonly onCtapRequest: CodegenTypes.EventEmitter<CtapRequestEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeFidoGatt');
