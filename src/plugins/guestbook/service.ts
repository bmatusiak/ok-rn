import AsyncStorage from '@react-native-async-storage/async-storage';

import {refresh, store} from 'node-onlykey-lib/guestbook';
import {currentNet} from '../../net';
import type {RecipientContact, RecipientKey, RecipientSource} from '../recipients';

/*
 * GUEST BOOK OUTSIDE ITS TAB (Brad, 2026-10-18: "guestbook will be how we get and store pubkey,
 * and encrypt/decrypt uses guestbook"). Encrypt / Decrypt picks people from here - to encrypt to,
 * and to name who signed a message - through the recipients service (src/plugins/recipients.ts),
 * so that screen never imports this plugin.
 *
 * The store setup lives here, shared with the tab's hook (useGuestBook), and a refresh made from
 * Encrypt / Decrypt tells the tab to read the list again.
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

/* a composite PGP key's primary is ML-DSA-65 + Ed25519 (the fork's pqc_mldsa_ed25519) */
const isComposite = (algorithm: unknown) => /pqc|mldsa|mlkem/i.test(String(algorithm || ''));

const fetchFn = async (url: string) => {
  const res = await fetch(url);
  return {ok: res.ok, status: res.status, url: res.url, text: () => res.text()};
};

export const recipientSource: RecipientSource = {
  name: 'Guest Book',

  async me() {
    /* My card's PGP certificates (Key Chain keeps them), the same keys the Me page shows */
    const {readMyCard} = require('./myCard');
    const mine = (await readMyCard()).filter((k: any) => k.format === 'PGP');
    if (!mine.length) return null;
    const name = await readMyName();
    return {
      id: 'me',
      name: name ? `Me - ${name}` : 'Me',
      keys: mine.map((k: any) => ({label: k.title, text: k.text, verified: true, composite: k.title.includes('(+PQC)')})),
    };
  },

  async pgpContacts(): Promise<RecipientContact[]> {
    const {contacts} = await openBook().load();
    const out: RecipientContact[] = [];
    for (const c of contacts) {
      const keys: RecipientKey[] = c.keys
        /* a revoked key is never offered to encrypt to (spec Security: "Encrypt refuses it") */
        .filter((k: any) => k.format === 'openpgp' && !k.info?.revoked)
        .map((k: any) => ({label: k.label || 'PGP key', text: k.text, verified: !!k.verified, composite: isComposite(k.info?.algorithm)}));
      if (keys.length) out.push({id: c.id, name: c.name, keys});
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },

  async refresh(contactId) {
    const book = openBook();
    const {contacts} = await book.load();
    const at = contacts.findIndex((c: any) => c.id === contactId);
    if (at < 0) return [];
    const r = await refresh.refreshContact(contacts[at], {fetchFn, openpgp: openpgp()});
    contacts[at] = r.contact;
    await book.save(contacts);
    guestBookChanged();
    return r.changes;
  },
};
