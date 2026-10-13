import AsyncStorage from '@react-native-async-storage/async-storage';

import {formats, store} from 'node-onlykey-lib/guestbook';
import {currentNet} from '../../net';
import type {RecipientKey, RecipientSource} from '../recipients';

/*
 * GUEST BOOK OUTSIDE ITS TAB (GUEST-BOOK-SPEC.md, UI: "In Encrypt, the recipient box gains 'Add
 * from Guest Book' ... After an online lookup in Messages, a 'Save to Guest Book' button appears
 * on each result"). Offered to core screens through the recipients service (src/plugins/
 * recipients.ts), so Messages never imports this plugin.
 *
 * The store setup lives here, shared with the tab's hook (useGuestBook), and a change made from
 * Messages tells the tab to read the list again.
 */

declare const crypto: {getRandomValues<T extends Uint8Array>(array: T): T};

export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
/* one list per net, as Key Chain's: the testnet's is cleared with the testnet (src/testnet.ts) */
export const storageKey = () => (currentNet() === 'test' ? 'okrn.guestbook.test:v1' : store.KEY);
export const openBook = () => store.createGuestBook({storage: AsyncStorage, randomBytes, key: storageKey()});
/*
 * YOUR NAME ON A SWAP (Brad, 2026-10-12: "a name for the contact can be provided by the person
 * offering the key, in Me ... give yourself a name, and send the name with the pubkey, and the
 * receiver can edit the name if they want"). Set on the Me page, sent on every card, kept per net
 * like the list.
 */
const myNameKey = () => (currentNet() === 'test' ? 'okrn.guestbook.test:myname' : 'okrn.guestbook:myname');
export const readMyName = async () => (await AsyncStorage.getItem(myNameKey()).catch(() => null)) || '';
export const saveMyName = (name: string) => AsyncStorage.setItem(myNameKey(), name.trim().slice(0, 64));
/*
 * WHICH OF YOUR KEYS A SWAP OFFERS (Brad, 2026-10-12: "lets put a toggle, all default off, the
 * toggled ones are the keys that get offered"). Guest Book collects the keys people encrypt
 * messages to and check signatures with - "SSH ... is not something normal to trade" - so nothing
 * goes out until its owner turns it on, key by key, on the Me page. Ids are My card's (myCard.ts).
 */
const offeredKey = () => (currentNet() === 'test' ? 'okrn.guestbook.test:offered' : 'okrn.guestbook:offered');
export async function readOffered(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(offeredKey());
    const ids = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter((x: unknown) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
export async function setOffered(id: string, on: boolean): Promise<Set<string>> {
  const ids = await readOffered();
  if (on) ids.add(id);
  else ids.delete(id);
  await AsyncStorage.setItem(offeredKey(), JSON.stringify([...ids]));
  return ids;
}
/* the 1.2 MB OpenPGP fork, loaded the first time a PGP key is read (MessagesScreen does the same) */
export const openpgp = () => require('node-onlykey-lib/crypto/pgp');

const listeners = new Set<() => void>();
/** The list changed outside the tab (a key saved from Messages): read it again. */
export function onGuestBookChanged(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}
export const guestBookChanged = () => listeners.forEach(l => l());

export const recipientSource: RecipientSource = {
  name: 'Guest Book',

  async pgpKeys(): Promise<RecipientKey[]> {
    const {contacts} = await openBook().load();
    const out: RecipientKey[] = [];
    for (const c of contacts) {
      for (const k of c.keys) {
        /* a revoked key is never offered to encrypt to (spec Security: "Encrypt refuses it") */
        if (k.format !== 'openpgp' || k.info?.revoked) continue;
        out.push({contact: c.name, label: k.label || 'PGP key', text: k.text, verified: !!k.verified});
      }
    }
    return out.sort((a, b) => a.contact.localeCompare(b.contact));
  },

  async save(armored, label, from) {
    const {found} = await formats.detectAll(armored, {openpgp: openpgp()});
    if (!found.length) throw new Error('no public key in that to save');
    const book = openBook();
    const {contacts} = await book.load();
    const at = contacts.findIndex((c: any) => c.keys.some((k: any) => found.some((f: any) => f.format === k.format && f.fingerprint === k.fingerprint)));
    if (at >= 0) contacts[at] = book.addKeys(contacts[at], found, from);
    else contacts.push(book.newContact({name: label, found, source: from}));
    await book.save(contacts);
    guestBookChanged();
    return at >= 0 ? `Already in Guest Book as ${contacts[at].name} - its source was added.` : `Saved to Guest Book as ${contacts[contacts.length - 1].name}.`;
  },
};
