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
 * back. It never answers a command itself - with ONE exception, the IO gate
 * (setIoPolicy): a request from a computer that is not the target, or on a
 * door that is shut, is refused at the radio before it reaches JS.
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

/** One reassembled request awaiting a response from JS. */
export type CtapRequestEvent = {
  /** Opaque id to pass back to respondToRequest(). */
  requestId: string;
  /**
   * Which BLE service the request arrived on: 'fido', or 'vendor' when the
   * OnlyKey vendor service is plugged in (VendorGattService.kt).
   *
   * One event carries both because respondToRequest() takes only the id and
   * routes the answer itself - a second event type would have meant a second
   * subscription in every consumer for no gain. A bridge that does not
   * recognise an interface must IGNORE the request rather than answer it,
   * which is what makes the vendor service removable: with the file deleted
   * nothing ever raises 'vendor', and with it present but no vendor bridge
   * attached, a host gets silence rather than a wrong answer.
   */
  iface: string;
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
  /**
   * The address of the central that sent it, upper-case.
   *
   * The native gate has already checked it against the target (setIoPolicy);
   * it is carried so the bridges can check it a SECOND time, because a
   * request can be in flight across a change of target, and because a gate
   * nobody can see from JS is one nobody can test from JS.
   */
  address: string;
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

export type PermissionStatus = {
  bluetooth: boolean;
  notifications: boolean;
  notificationsApply: boolean;
};

export interface Spec extends TurboModule {
  /** BLE peripheral mode + advertising + hardware keystore all present. */
  isSupported(): Promise<boolean>;

  /**
   * Runtime permissions (BLUETOOTH_ADVERTISE / BLUETOOTH_CONNECT on API 31+).
   * Resolves true once every required permission is granted. Asks for
   * POST_NOTIFICATIONS in the same dialog on API 33+, without requiring it.
   */
  requestPermissions(): Promise<boolean>;

  /**
   * Where each permission stands right now, without asking. `notificationsApply`
   * is false below API 33, where there is no such permission to grant.
   */
  permissionStatus(): Promise<PermissionStatus>;

  /** Ask for POST_NOTIFICATIONS alone (API 33+); true below that. */
  requestNotificationPermission(): Promise<boolean>;

  /**
   * The system's page for this app, where a permission refused with "don't
   * ask again" can only be turned back on. Android stops showing the dialog
   * after that refusal, so an in-app "ask again" that silently returns
   * false needs this next to it.
   */
  openAppSettings(): void;

  configure(config: AuthenticatorConfig): void;

  /**
   * WHO MAY TALK TO THE KEY, and over which door.
   *
   * `target` is the one computer approved for IO in both directions (the
   * Bluetooth tab's target; null = None, nothing in or out). `webauthn` gates
   * the FIDO service, `api` the vendor service. A write that fails either
   * test is still acknowledged on the wire - a refused write teaches Windows
   * to abandon the service - and then refused above it: a FIDO request gets
   * CTAP2_ERR_OPERATION_DENIED, to its sender only, and a vendor write is
   * dropped. Replies and reports go only to the target's own connection.
   *
   * Held by the process, like the GATT server. The default before the first
   * call is the safe one: no target, both doors shut.
   */
  setIoPolicy(target: string | null, webauthn: boolean, api: boolean): void;

  /** Opens the GATT server and starts advertising service 0xFFFD. */
  startAdvertising(): Promise<void>;
  stopAdvertising(): Promise<void>;

  /** 'idle' | 'advertising' | 'connected' | 'stopped' | 'error' */
  getState(): string;

  /**
   * Where our FIDO service (0xFFFD) sits in the phone's GATT table now (its
   * start handle), -1 when not registered. Windows keys its device entries by
   * that position; see fidoKnownHandle.
   */
  fidoHandle(): number;

  /**
   * Where it was the last time a computer read one of its characteristics (the
   * layout that computer has enumerated), -1 if never. After a Bluetooth off/on
   * the app restarts its services until fidoHandle() matches this.
   */
  fidoKnownHandle(): number;

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

  /**
   * Push one OnlyKey report to the host on the vendor service's notify
   * characteristic. Present only while VendorGattService.kt is.
   *
   * UNPROMPTED: the vendor protocol is not request/response. OKSETSLOT answers
   * nothing, OKGETLABELS answers with a report per slot, and a host reads when
   * it likes. So reports go up and down independently, as they do over USB HID,
   * and the host correlates.
   *
   * Await each call. The notify budget is per LINK and fragments reassemble by
   * position, so a second send before the first resolves would interleave.
   */
  sendVendorReport(hex: string): Promise<void>;

  /**
   * sendVendorReport with the frame command chosen by the caller (Part T):
   * 0x84 a sealed frame, 0x85 pairing / handshake, 0x83 a plaintext report.
   * Same rules: target only, API on, one send at a time.
   */
  sendVendorFrame(command: number, hex: string): Promise<void>;

  /** Generate a P-256 credential key in the TEE/StrongBox. Returns credentialId hex. */
  createCredential(rpId: string, userHandleHex: string): Promise<string>;

  /** Sign with a hardware key, gated on BiometricPrompt. Returns DER signature hex. */
  signWithCredential(credentialIdHex: string, payloadHex: string): Promise<string>;

  readonly onGattStatus: CodegenTypes.EventEmitter<GattStatusEvent>;
  readonly onCtapRequest: CodegenTypes.EventEmitter<CtapRequestEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeFidoGatt');
