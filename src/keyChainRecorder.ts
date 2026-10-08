/**
 * THE PHONE RECORDS EVERY DERIVE ITS SOFT KEY ANSWERS (spec session + Brad,
 * 2026-10-03), on any transport - the vendor interface (this app, a computer
 * over Bluetooth) and FIDO (the web page path) alike - into the phone's Key
 * Chain list (the same storage the Key Chain tab shows).
 *
 * Only the firmware sees every transport in the clear (the FIDO derive is
 * transit-encrypted before this app could read it), so the soft key's
 * key_chain plugin makes the record and hands it up as an event
 * (android/okemu/plugins/key_chain). Public data only: the label HASH the
 * request carried (the firmware never sees a label as text), the code, keytype,
 * transport, the FIDO rpId hash, and the public key. The names come from a
 * computer's list when the two are merged (export/import): its entries carry
 * the text, and the lib can hash it.
 *
 * Never "yours": the own-identities mark is set only in the Edge tab, with its
 * confirm (list.createEntry drops it anyway). A derive is not a use - nothing
 * here touches Edge receipts or budgets.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import NativeOkEmu from '../specs/NativeOkEmu';
import {currentNet} from './net';

const keychain = require('node-onlykey-lib/keychain');
const {sha256} = require('node-onlykey-lib/vendor/@noble/hashes/sha2.js');

/*
 * THE rpId TEXT (spec session, 2026-10-03): the firmware reports only the rpId's
 * hash. The FIDO paths that hand the soft key a request (Bluetooth FIDO,
 * src/transport/FidoGatt.ts; the passkey provider, src/credprovider/flow.ts)
 * note the text here first; a derive whose rpId hash matches is named by it.
 */
const rpIds = new Map<string, string>();
export function noteRpId(rpId: string): void {
  if (!rpId || typeof rpId !== 'string') return;
  const bytes = Uint8Array.from(rpId, c => c.charCodeAt(0) & 0xff);
  rpIds.set(hexOf(sha256(bytes)), rpId);
  while (rpIds.size > 64) rpIds.delete(rpIds.keys().next().value as string);
}

/* the Key Chain tab's own storage (KeyChainScreen) - the live key's name */
export const KEYCHAIN_LIST_KEY = 'okrn.keychain.list';
/*
 * The list on the current net (src/net.ts): the testnet's soft key is another key
 * with other keys, so its list is its own and is cleared with the testnet.
 */
export function keychainListKey(): string {
  return currentNet() === 'test' ? 'okrn.keychain.test.list' : KEYCHAIN_LIST_KEY;
}

const CODE_SCHEME: Record<number, string> = {132: 'agent-v1', 232: 'agent-v2', 128: 'web'};
/* agent derivation keytypes (okcrypto OKGETPUBKEY) */
const AGENT_TYPE: Record<number, string> = {1: 'ed25519', 2: 'p256', 3: 'secp256k1', 4: 'x25519', 6: 'xwing'};
/* the web key (code 128, ok_extension): 1 is NaCl, i.e. Curve25519 */
const WEB_TYPE: Record<number, string> = {1: 'x25519', 4: 'x25519', 2: 'p256', 3: 'secp256k1', 6: 'xwing'};

export type DeriveRecord = {
  transport: 'vendor' | 'fido';
  code: number;
  keytype: number;
  labelHash: string;
  rpIdHash: string | null;
  publicKey: Uint8Array;
};

const hexOf = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => Uint8Array.from((h.match(/../g) || []).map(x => parseInt(x, 16)));

/** The plugin's record (okplugin_key_chain.cpp) -> its fields. Throws on anything else. */
export function decodeDerive(hex: string): DeriveRecord {
  const b = fromHex(hex);
  if (b.length < 72 || b[0] !== 1) throw new Error('key_chain: not a version-1 derive record');
  const publen = b[70] | (b[71] << 8);
  if (b.length !== 72 + publen) throw new Error('key_chain: the record length does not match its public key');
  return {
    transport: b[1] === 1 ? 'fido' : 'vendor',
    code: b[2] | (b[3] << 8),
    keytype: b[4],
    labelHash: hexOf(b.subarray(6, 38)),
    rpIdHash: b[5] ? hexOf(b.subarray(38, 70)) : null,
    publicKey: b.slice(72),
  };
}

/** The Key Chain entry for a derive (public only), or null for a code or keytype it does not know. */
export function deriveEntry(r: DeriveRecord, now: string) {
  const scheme = CODE_SCHEME[r.code];
  const type = (r.code === 128 ? WEB_TYPE : AGENT_TYPE)[r.keytype];
  if (!scheme || !type) return null;
  let pub = r.publicKey;
  /* a P-256 / secp256k1 point as 0x04||X||Y: keep X||Y, like the slots and the computer's list */
  if ((type === 'p256' || type === 'secp256k1') && pub.length === 65 && pub[0] === 4) pub = pub.slice(1);
  /* an agent Ed25519/X25519 answer is 32 bytes and 32 zeros */
  if ((type === 'ed25519' || type === 'x25519') && pub.length === 64) pub = pub.slice(0, 32);
  return keychain.list.createEntry({
    kind: 'derived',
    scheme,
    label: `hash:${r.labelHash}`,
    type,
    publicKey: pub,
    code: r.code,
    transport: r.transport,
    ...(r.rpIdHash ? {rpIdHash: r.rpIdHash} : {}),
    ...(r.rpIdHash && rpIds.has(r.rpIdHash) ? {rpId: rpIds.get(r.rpIdHash)} : {}),
    fingerprint: keychain.list.fingerprint(pub),
    firstSeen: now,
    lastSeen: now,
    tools: ['soft key'],
  });
}

const listeners = new Set<() => void>();
/** The list changed (a derive was recorded) - the Key Chain tab reads it again. */
export function onKeyChainRecorded(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/* one write at a time: derives arrive back to back (a push signs and derives) */
let queue: Promise<unknown> = Promise.resolve();

/** Record one derive: added the first time, last seen after that. */
export function recordDerive(r: DeriveRecord): Promise<void> {
  const run = queue.then(async () => {
    const now = new Date().toISOString();
    const e = deriveEntry(r, now);
    if (!e) return;
    const raw = await AsyncStorage.getItem(keychainListKey());
    const entries: any[] = raw ? keychain.list.parse(raw) : [];
    /* the same key already here by its name (imported from a computer): that entry, not a second one */
    const old = entries.find(x => x.id === e.id) || (keychain.list.findTwin ? keychain.list.findTwin(entries, e) : null);
    if (old) {
      old.lastSeen = now;
      if (r.rpIdHash && !old.rpIdHash) old.rpIdHash = r.rpIdHash;
      if (e.rpId && !old.rpId) old.rpId = e.rpId;
      if (!old.labelHash && String(old.label).startsWith('hash:') === false) old.labelHash = r.labelHash;
      old.tools = [...new Set([...(old.tools || []), 'soft key'])];
    } else {
      entries.push(e);
    }
    await AsyncStorage.setItem(keychainListKey(), keychain.list.serialize(entries));
    for (const l of listeners) l();
  });
  queue = run.catch(() => {});
  return run;
}

/** This phone's Key Chain list as it is now (public entries). */
export async function readKeyChainList(): Promise<any[]> {
  const raw = await AsyncStorage.getItem(keychainListKey());
  return raw ? keychain.list.parse(raw) : [];
}

/**
 * okedge sync phase 2: keep a list merged with a place's (after the sheet, Yes
 * and the press) - in THIS queue, merged into the list as it is NOW, so a derive
 * recorded meanwhile is never lost (the copy sync lost approved links that way).
 */
export function keepMergedKeyChain(merged: any[]): Promise<void> {
  const run = queue.then(async () => {
    /*
     * The MERGED list as it is - the place takes exactly this back - plus only
     * entries recorded since (none of its ids, no twin in it). Merging it INTO
     * the old list kept the old version of every joined entry, so the phone and
     * the computer held different lists and every sync moved the same entries
     * again (the A13, 2026-10-05: a second sync, a second press, nothing new).
     */
    const now = await readKeyChainList();
    const ids = new Set(merged.map((e: any) => e.id));
    const since = now.filter((e: any) => !ids.has(e.id) && !keychain.list.findTwin(merged, e));
    await AsyncStorage.setItem(keychainListKey(), keychain.list.serialize([...merged, ...since]));
    for (const l of listeners) l();
  });
  queue = run.catch(() => {});
  return run;
}

/** Listen for the soft key's derive events for the life of the app. */
export function startKeyChainRecorder(): () => void {
  try {
    const sub = NativeOkEmu.onPluginEvent(ev => {
      if (ev.name !== 'key_chain') return;
      try {
        void recordDerive(decodeDerive(ev.hex)).catch(() => {});
      } catch {
        /* a record it cannot read: dropped, never a crash */
      }
    });
    return () => sub.remove();
  } catch {
    return () => {};
  }
}
