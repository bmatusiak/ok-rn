import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';
import type {CodegenTypes} from 'react-native';

/**
 * CTAP2-over-BLE peripheral: turns the phone into a roaming FIDO2 authenticator
 * that desktop browsers can talk to. See EXPLAINER/z.md.
 *
 * The native side is a TRANSPORT, not an authenticator. It advertises the FIDO
 * service, reassembles Control Point writes into whole CTAP2 messages, hands
 * each one to JS as an onCtapRequest event, and fragments whatever JS gives
 * back. It never answers a command itself and never rejects one.
 *
 * That last sentence used to read "the CTAP2/CBOR command handlers and the
 * KeyStore signing path are stubs that reject with CTAP2_ERR_NOT_ALLOWED",
 * which described code that does not exist - there is no such constant in the
 * Kotlin and no path that auto-rejects. It matters because it points at the
 * wrong layer: a command that goes unanswered is JS not answering it.
 *
 * The answers come from the OnlyKey firmware running in this same process, via
 * protocol.bridge in node-onlykey-lib. The KeyStore functions below are real
 * but nothing calls them; the credentials live in the firmware's flash.
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
  /**
   * CTAP BLE command byte: 0x81 PING, 0x82 KEEPALIVE, 0x83 MSG, 0xbe CANCEL,
   * 0xbf ERROR (CTAP 2.1, table in section 11.2.9).
   *
   * This said 0x84 for CANCEL, which is not a CTAP BLE command at all. The
   * Kotlin has always had 0xbe and is right.
   */
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

  /**
   * Relay a KEEPALIVE to the host while the authenticator is still working.
   *
   * The request stays pending - this is not the answer. Needed because the
   * firmware sends one keepalive when its status changes and then waits up to
   * nineteen seconds for a button, and a host hearing nothing for that long
   * gives up on the ceremony.
   *
   * @param status CTAP keepalive status: 0x01 PROCESSING, 0x02 UP_NEEDED.
   */
  sendKeepAlive(requestId: string, status: number): Promise<void>;

  /** Generate a P-256 credential key in the TEE/StrongBox. Returns credentialId hex. */
  createCredential(rpId: string, userHandleHex: string): Promise<string>;

  /** Sign with a hardware key, gated on BiometricPrompt. Returns DER signature hex. */
  signWithCredential(credentialIdHex: string, payloadHex: string): Promise<string>;

  readonly onGattStatus: CodegenTypes.EventEmitter<GattStatusEvent>;
  readonly onCtapRequest: CodegenTypes.EventEmitter<CtapRequestEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeFidoGatt');
