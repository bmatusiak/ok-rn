/**
 * The swap's real parts on the phone (swapLink.ts takes them as deps): the Bluetooth link
 * (specs/NativeContactLink.ts) and this phone's OnlyKey as the contact identity.
 */
import NativeContactLink from '../../../specs/NativeContactLink';
import {recordNamed} from '../../keyChainRecorder';
import {CONTACT_LABEL, type Link} from './swapLink';

const ask = async () => {
  if (!(await NativeContactLink.requestPermissions())) {
    throw new Error('Swapping keys needs the Bluetooth permission (nearby devices).');
  }
};

export const nativeLink: Link = {
  host: async linkHex => {
    await ask();
    await NativeContactLink.host(linkHex);
  },
  join: async (linkHex, timeoutMs) => {
    await ask();
    return NativeContactLink.join(linkHex, timeoutMs);
  },
  send: hex => NativeContactLink.send(hex),
  close: () => NativeContactLink.close(),
  listen: fn => {
    const sub = NativeContactLink.onContactLink(fn);
    return () => sub.remove();
  },
};

/*
 * THE CONTACT IDENTITY: the derived X-Wing key under CONTACT_LABEL on the OnlyKey in use. Its
 * public half is read without a press; opening a seal is the one press of a swap. Kept in Key
 * Chain by its name (recordNamed), so the press sheet can say WHICH key the OnlyKey is about
 * to use - "okrn-contact:v1" - rather than an unnamed label hash.
 */
type Okcrypto = {deviceAge: {identity: Function; decapsulate: Function}};
export function contactIdentity(getKey: () => Promise<{okcrypto: Okcrypto}>) {
  return async () => {
    const {okcrypto} = await getKey();
    const id = await okcrypto.deviceAge.identity(CONTACT_LABEL, {timeoutMs: 20000});
    const publicKey = Uint8Array.from(id.recipient as Uint8Array);
    recordNamed({scheme: 'label', label: CONTACT_LABEL, type: 'xwing', publicKey, tool: 'Guest Book'}).catch(() => {});
    return {
      publicKey,
      decapsulate: (ct: Uint8Array, onDigits: (d: number[]) => void) =>
        okcrypto.deviceAge.decapsulate(CONTACT_LABEL, ct, {
          timeoutMs: 60000,
          /* a hard key in challenge mode waits for these digits; the press sheet shows the soft key's */
          confirm: ({digits}: {digits: number[]}) => onDigits(digits || []),
        }) as Promise<Uint8Array>,
    };
  };
}

/*
 * AN INVITE FROM OUTSIDE THE TAB: the phone's own camera opened an okrn://connect link, or it
 * was scanned on Add. App switches to Guest Book and hands it over; the screen takes it when it
 * mounts, or hears it when it is already open.
 */
let pending: string | null = null;
const listeners = new Set<(url: string) => void>();
export function openInvite(url: string): void {
  if (listeners.size) for (const fn of [...listeners]) fn(url);
  else pending = url;
}
export function takeInvite(): string | null {
  const url = pending;
  pending = null;
  return url;
}
export function onInvite(fn: (url: string) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export const isInvite = (text: string | null | undefined) => /^okrn:\/\/connect\?/.test(String(text || '').trim());
