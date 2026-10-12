import {useCallback, useEffect, useMemo, useState} from 'react';

import {formats, refresh, sources, store} from 'node-onlykey-lib/guestbook';
import NativeShare from '../../../specs/NativeShare';
import {onGuestBookChanged, openBook, openpgp} from './service';

/*
 * GUEST BOOK'S STATE (onlykey-edge/features/GUEST-BOOK-SPEC.md): the contacts list, kept by the
 * lib's store (node-onlykey-lib/guestbook) in AsyncStorage. Local only, no OnlyKey needed.
 *
 * One list per net, as Key Chain's: the testnet's list is `okrn.guestbook.test:v1` (cleared with
 * the testnet, src/testnet.ts), so trying things in testing mode never touches the real one.
 *
 * The network is touched only by a person's press (Look up, Refresh, Refresh all) - ok-rn is
 * air-gapped by default. PUBLIC ONLY: every way in goes through the lib's guard; a private key is
 * refused with a reason and nothing is saved (Brad, 2026-10-12).
 */

export type Contact = any;
export type Found = {format: string; text: string; fingerprint: string; label: string; info?: any};
export type Source = {kind: string; handle: string};

/* the phone's fetch as the lib wants it: status, final URL (https check), text */
const fetchFn = async (url: string) => {
  const res = await fetch(url);
  return {ok: res.ok, status: res.status, url: res.url, text: () => res.text()};
};
const EXPORT_FORMAT = 'okrn-guestbook';

export function useGuestBook() {
  const book = useMemo(() => openBook(), []);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const read = () =>
      book.load().then((r: any) => {
        if (!live) return;
        setContacts(r.contacts);
        setRecovered(r.recovered);
        setLoaded(true);
      });
    read();
    /* a key saved from Messages (service.ts): the list on screen reads it in */
    const off = onGuestBookChanged(() => void read());
    return () => {
      live = false;
      off();
    };
  }, [book]);

  const save = useCallback(
    async (next: Contact[]) => {
      const saved = await book.save(next);
      setContacts(saved);
      return saved;
    },
    [book],
  );

  /** Every public key in a paste or a scan; a private key throws PrivateKeyError (nothing kept). */
  const read = useCallback((text: string) => formats.detectAll(text, {openpgp: openpgp()}), []);

  /** A person's Look up: each result with the keys found in it. */
  const lookup = useCallback(async (kind: string, query: string) => {
    const results = await sources.lookup(kind, query, fetchFn);
    const out = [];
    for (const r of results) {
      try {
        const {found} = await formats.detectAll(r.body, {openpgp: openpgp()});
        if (found.length) out.push({label: r.label, where: r.where, source: r.source, found});
      } catch (e: any) {
        out.push({label: r.label, where: r.where, source: r.source, found: [], error: String(e?.message ?? e)});
      }
    }
    return out;
  }, []);

  /** Add: a new contact, or more keys onto one that exists. */
  const add = useCallback(
    async ({name, found, source, contactId}: {name?: string; found: Found[]; source: Source; contactId?: string}) => {
      if (contactId) {
        return save(contacts.map((c: Contact) => (c.id === contactId ? book.addKeys(c, found, source) : c)));
      }
      return save([...contacts, book.newContact({name, found, source})]);
    },
    [book, contacts, save],
  );

  const update = useCallback(
    (id: string, change: (c: Contact) => Contact) => save(contacts.map((c: Contact) => (c.id === id ? change(c) : c))),
    [contacts, save],
  );

  const remove = useCallback((id: string) => save(contacts.filter((c: Contact) => c.id !== id)), [contacts, save]);

  /** Refresh one contact, or all of them (one at a time); returns the change lines for the screen. */
  const refreshOne = useCallback(
    async (id: string) => {
      const c = contacts.find((x: Contact) => x.id === id);
      if (!c) return [];
      setRefreshing(c.name);
      try {
        const r = await refresh.refreshContact(c, {fetchFn, openpgp: openpgp()});
        await save(contacts.map((x: Contact) => (x.id === id ? r.contact : x)));
        return r.changes;
      } finally {
        setRefreshing(null);
      }
    },
    [contacts, save],
  );

  const refreshAll = useCallback(async () => {
    setRefreshing('everyone');
    try {
      const r = await refresh.refreshAll(contacts, {fetchFn, openpgp: openpgp(), onContact: (c: Contact) => setRefreshing(c.name)});
      await save(r.contacts);
      return r.changes;
    } finally {
      setRefreshing(null);
    }
  }, [contacts, save]);

  /** Export: the contacts list as a file - public keys only, the store's guard ran on every one. */
  const exportFile = useCallback(async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const body = JSON.stringify({format: EXPORT_FORMAT, v: 1, contacts}, null, 2);
    formats.refusePublicOnly(body);
    return NativeShare.saveFile(`guest-book-${stamp}.json`, body, 'application/json');
  }, [contacts]);

  /** Import: a Guest Book export. Keys already here only gain the source; new people are added. */
  const importFile = useCallback(async () => {
    const picked = await NativeShare.pickTextFile('application/json');
    if (!picked.picked) return null;
    formats.refusePublicOnly(picked.content);
    const blob = JSON.parse(picked.content);
    if (blob?.format !== EXPORT_FORMAT || !Array.isArray(blob.contacts)) throw new Error('that file is not a Guest Book export');
    let next = [...contacts];
    let added = 0;
    for (const raw of blob.contacts) {
      const incoming = store.shapeContact(raw);
      const at = next.findIndex((c: Contact) =>
        c.keys.some((k: any) => incoming.keys.some((i: any) => i.format === k.format && i.fingerprint === k.fingerprint)),
      );
      if (at >= 0) next[at] = book.addKeys(next[at], incoming.keys, {kind: 'paste', handle: ''});
      else {
        next.push(incoming);
        added += 1;
      }
    }
    await save(next);
    return {added, total: blob.contacts.length};
  }, [book, contacts, save]);

  return {
    contacts,
    loaded,
    recovered,
    refreshing,
    read,
    readRaw: formats.readRaw,
    lookup,
    add,
    update,
    remove,
    refreshOne,
    refreshAll,
    accept: (id: string, keyId: string, fp: string) => update(id, c => refresh.acceptPending(c, keyId, fp)),
    keepCurrent: (id: string, keyId: string) => update(id, c => refresh.keepCurrent(c, keyId)),
    keepAndRemove: (id: string, keyId: string) => update(id, c => refresh.keepAndRemoveSources(c, keyId)),
    setVerified: (id: string, keyId: string, v: boolean) => update(id, c => book.setVerified(c, keyId, v)),
    rename: (id: string, name: string, note?: string) => update(id, c => book.rename(c, name, note)),
    removeKey: (id: string, keyId: string) => update(id, c => book.removeKey(c, keyId)),
    exportFile,
    importFile,
  };
}
