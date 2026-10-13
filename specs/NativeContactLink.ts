/**
 * The Bluetooth link for Guest Book's in-person key swap (onlykey-edge features/GUEST-BOOK-SPEC.md;
 * Brad, 2026-10-12: "use the qr code to setup and create a link over bluetooth").
 *
 * Two phones, two roles:
 *   host(link)   the phone showing the invite QR: a GATT service named by the invite's 8-byte
 *                link id (UUID 6f6b726e-636f-6e74-<link>), advertised in its OWN advertising set
 *                beside the soft key's, while the QR is open. One peer at a time.
 *   join(link)   the phone that scanned it: scans for exactly that service, connects, asks for
 *                MTU 247, subscribes. Resolves with the bytes one write can carry.
 *
 * No OS pairing and no encryption at this layer, on purpose: the swap (node-onlykey-lib
 * guestbook/src/swap.js) authenticates both phones' OnlyKeys with X-Wing and seals what crosses.
 * Nothing about the link is saved; close() ends it and stops the advertising.
 *
 * send(hex) is one fragment (guestbook/src/frames.js splits messages); it resolves when the
 * other side has it (write acknowledged / notification sent). Fragments that arrive come as
 * onContactLink {type: 'data', hex}; {type: 'connected', mtu} when the peer is ready (host side);
 * {type: 'closed', message} when the link drops.
 */
import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';
import type {CodegenTypes} from 'react-native';

export type ContactLinkEvent = {
  type: string;
  hex: string;
  mtu: number;
  message: string;
};

export interface Spec extends TurboModule {
  /** Bluetooth scan, connect and advertise; false when the person refused. */
  requestPermissions(): Promise<boolean>;
  host(linkHex: string): Promise<void>;
  join(linkHex: string, timeoutMs: number): Promise<number>;
  send(hex: string): Promise<void>;
  close(): Promise<void>;
  readonly onContactLink: CodegenTypes.EventEmitter<ContactLinkEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeContactLink');
