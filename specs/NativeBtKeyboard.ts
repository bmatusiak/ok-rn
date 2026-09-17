import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';
import type {CodegenTypes} from 'react-native';

/**
 * The phone as a Bluetooth keyboard, so the soft key can type into a PC.
 *
 * The key's whole output channel is keystrokes. A slot is not read out over a
 * wire - the firmware presses it at a keyboard, one character at a time, into
 * whatever has focus (okcore.cpp), and a backup is the same thing 61 slots
 * long. On hardware that keyboard is USB. Here the firmware runs on the phone,
 * so its reports arrive in-process with nowhere to go: the app can decode them
 * and show a password, which is B1, but it cannot TYPE one anywhere.
 *
 * This is the missing wire. The reports the firmware already emits on
 * IFACE.KEYBOARD are forwarded verbatim to a host paired over Bluetooth, and
 * the host sees an ordinary keyboard.
 *
 * ## Why this is not BLE, and not a GATT characteristic
 *
 * EXPLAINER/serving-passwords-bluetooth.md describes the phone CONNECTING to a
 * dongle and writing the password to a custom characteristic. That is the
 * opposite arrangement, and it does not apply here: there is no dongle, the
 * phone is the dongle. It is also weaker - a custom characteristic write is
 * plaintext over the air, and an app-level MAC allowlist does not authenticate
 * anything, because a peripheral chooses the address it advertises.
 *
 * `BluetoothHidDevice` is the profile for this. It is Bluetooth CLASSIC HID in
 * the Device role, in the platform SDK since API 28, and it is what makes the
 * phone appear in a PC's Bluetooth settings as a keyboard rather than as an
 * app. The host bonds with it, so the link is encrypted by the radio and the
 * pairing is the trust anchor - the host has to have agreed to this keyboard
 * once, and a different phone is a different bond.
 *
 * ## What it deliberately does not carry
 *
 * The firmware's USB descriptor ends with an 8-byte Feature report (usage
 * 0x76) - the Yubikey OTP / HMAC-SHA1 channel, which rides USB control
 * transfers. There is no control-transfer equivalent here and no host asks for
 * it over HID-over-Bluetooth, so it is left out. Everything a slot types is in
 * the input report.
 */

/** Where the keyboard stands with the host. */
export type BtKeyboardStatusEvent = {
  /**
   * 'unsupported' | 'unregistered' | 'registered' | 'connecting' |
   * 'connected' | 'disconnected' | 'error'
   *
   * `registered` means the profile is published and a host MAY connect;
   * `connected` means one has, and only then will a report go anywhere.
   */
  state: string;
  message: string;
  /** The host's address, or '' when none. */
  address: string;
  /** The host's name if the platform knows it, else ''. */
  name: string;
};

/** A host this phone is bonded to and could type at. */
export type BtHost = {
  address: string;
  name: string;
  /** True for the one currently connected to the keyboard profile. */
  connected: boolean;
};

export interface Spec extends TurboModule {
  /**
   * Whether this device can be a Bluetooth keyboard at all.
   *
   * Not a version check. The HID Device profile is optional in AOSP and some
   * builds ship without it, in which case `getProfileProxy` simply never calls
   * back - so this resolves on what the platform actually offered.
   */
  isSupported(): Promise<boolean>;

  /** BLUETOOTH_CONNECT on API 31+; resolves false if the user declined. */
  requestPermissions(): Promise<boolean>;

  /**
   * Publish the keyboard, so hosts can find and pair with it.
   *
   * Idempotent. Until this is called the phone is not a keyboard and nothing
   * can connect; after it, pairing is driven from the HOST's Bluetooth
   * settings, the same as any other keyboard.
   */
  register(): Promise<boolean>;

  /** Withdraw it. The host sees the keyboard disappear. */
  unregister(): Promise<void>;

  /**
   * Ask the system to make this phone visible to other devices for a while.
   *
   * Required, and easy to miss: publishing the keyboard makes the phone
   * ANSWER to a host, not findable by one. A host that has never seen this
   * phone cannot add it as a keyboard until it turns up in a scan, and Android
   * is not discoverable by default. The system shows its own consent dialog -
   * an app cannot make the choice on the user's behalf.
   *
   * @param seconds how long to stay visible; the platform caps this at 300.
   * @returns the seconds actually granted, or 0 if the user declined. The
   *   system MAY SHORTEN what was asked for, so this is the only honest basis
   *   for a countdown - assuming the requested figure shows a window that is
   *   still open after the phone has gone back into hiding.
   */
  requestDiscoverable(seconds: number): Promise<number>;

  /**
   * The name a host will see this phone under.
   *
   * NOT the SDP name. "OnlyKey" is the service record's name and a host does
   * not show it in its device list - what it shows for a Classic Bluetooth
   * device is the ADAPTER name, which is whatever the phone is called in its
   * own Bluetooth settings. Telling the user to look for "OnlyKey" sends them
   * hunting for something that will not be there.
   */
  localName(): Promise<string>;

  /** Bonded devices that could be typed at, and which one is connected. */
  hosts(): Promise<BtHost[]>;

  /**
   * Ask a bonded host to connect.
   *
   * Usually unnecessary - a host reconnects to a keyboard by itself - but a
   * desktop that has gone to sleep will not, and waiting for it looks like a
   * hang.
   */
  connect(address: string): Promise<boolean>;

  disconnect(): Promise<void>;

  /**
   * Send one 8-byte input report: [modifiers, reserved, usage x 6].
   *
   * Verbatim from the firmware. This module does not build reports, does not
   * translate text, and does not know what a layout is - the firmware already
   * did all of that, against the layout the key is configured for, and second
   * -guessing it here would be a second implementation to disagree with.
   *
   * @param hex lowercase hex, 16 characters.
   * @returns false if there is no connected host, which is a state rather than
   *   an error - the key types whether or not anything is listening, exactly
   *   as it does on USB.
   */
  sendReport(hex: string): Promise<boolean>;

  readonly onStatus: CodegenTypes.EventEmitter<BtKeyboardStatusEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeBtKeyboard');
