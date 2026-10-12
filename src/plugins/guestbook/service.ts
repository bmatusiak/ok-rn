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
