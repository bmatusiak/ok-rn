import {bytes} from 'node-onlykey-lib';
import {inner} from 'node-onlykey-lib/passwords';

import NativeKdf from '../../../specs/NativeKdf';
import {nameDerive} from '../../pressAsk';
import {LABEL} from './stores';

/*
 * AN ENTRY'S OWN KEY (PASSWORD-MANAGER-SPEC.md "One key for identity, per-entry keys when
 * wanted"; lib passwords/src/inner.js). The store's key opens the list; an entry may seal its
 * secrets (password, history, notes, an authenticator's setup key) a second time:
 *
 *  - with the key: the derive on `vault:entry:<ref>` - asked every time the entry opens (the
 *    session cache is wiped right after, so "one more touch each time that entry opens" holds);
 *  - with a passphrase: PBKDF2 600k in OkSSL (NativeKdf - Brad, 2026-10-12: "use okssl when you
 *    can instead of webcrypto"), joined with the store's key by HKDF, so neither alone opens it.
 */

export type Seal = 'none' | 'key' | 'passphrase';

type Vault = {
  key(label: string, opts?: object): Promise<Uint8Array>;
  lock(label: string): unknown;
};
type KeyOkcrypto = {deviceVault: Vault};

declare const crypto: {getRandomValues<T extends Uint8Array>(array: T): T};
const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/* OkSSL's PBKDF2-HMAC-SHA256, called directly (no WebCrypto layer) */
const okPbkdf2 = async (password: Uint8Array, salt: Uint8Array, rounds: number, dkLen: number): Promise<Uint8Array> =>
  bytes.fromHex(await NativeKdf.pbkdf2Sha256(bytes.toHex(password), bytes.toHex(salt), rounds, dkLen));

/** The key of a key-sealed entry: its own derive, not kept in the session afterwards. */
async function entryDeriveKey(okcrypto: KeyOkcrypto, ref: string, press: boolean): Promise<Uint8Array> {
  const label = inner.entryLabel(ref);
  nameDerive(`vault:${label}`, 'Passwords: open one sealed entry');
  try {
    return Uint8Array.from(await okcrypto.deviceVault.key(label, {requirePress: press}));
  } finally {
    okcrypto.deviceVault.lock(label);
  }
}

/** The key of a passphrase-sealed entry: OkSSL PBKDF2 of the passphrase, joined with the store's key. */
async function passphraseEntryKey(okcrypto: KeyOkcrypto, passphrase: string, salt: Uint8Array, press: boolean): Promise<Uint8Array> {
  /* the store is open, so its key is in the session: no press */
  const managerKey = await okcrypto.deviceVault.key(LABEL, {requirePress: press});
  return inner.passphraseKey({passphrase, salt, managerKey, pbkdf2: okPbkdf2});
}

/** Seal an entry's secrets a second time. -> the entry to save (its secrets moved into `inner`). */
export async function sealEntry(
  entry: any,
  how: {seal: Exclude<Seal, 'none'>; passphrase?: string},
  okcrypto: KeyOkcrypto,
  press: boolean,
): Promise<any> {
  if (how.seal === 'key') {
    const ref = entry.inner?.ref ?? inner.newRef(randomBytes);
    const k = await entryDeriveKey(okcrypto, ref, press);
    try {
      return inner.sealInner(stripInner(entry), k, randomBytes, {seal: 'entry-derive', ref});
    } finally {
      k.fill(0);
    }
  }
  if (!how.passphrase) throw new Error('a passphrase is needed');
  const salt = randomBytes(16);
  const k = await passphraseEntryKey(okcrypto, how.passphrase, salt, press);
  try {
    return inner.sealInner(stripInner(entry), k, randomBytes, {seal: 'entry-passphrase', salt});
  } finally {
    k.fill(0);
  }
}

/** Open a sealed entry: the key's derive, or the passphrase. -> the entry with its secrets back. */
export async function openEntry(entry: any, okcrypto: KeyOkcrypto, press: boolean, passphrase?: string): Promise<any> {
  if (!entry?.inner) return entry;
  let k: Uint8Array;
  if (entry.inner.seal === 'entry-derive') {
    k = await entryDeriveKey(okcrypto, entry.inner.ref, press);
  } else {
    if (!passphrase) throw new Error('this entry opens with its passphrase');
    k = await passphraseEntryKey(okcrypto, passphrase, inner.saltOf(entry)!, press);
  }
  try {
    return {...inner.openInner(entry, k), sealedWith: entry.inner.seal === 'entry-derive' ? 'key' : 'passphrase'};
  } catch {
    throw new Error(entry.inner.seal === 'entry-derive' ? 'this key does not open the entry' : 'that passphrase does not open the entry');
  } finally {
    k.fill(0);
  }
}

/** An opened entry back to its plain shape (no `inner`, no app-only fields). */
export function stripInner(entry: any): any {
  const {inner: _inner, sealedWith: _with, ...rest} = entry;
  return rest;
}

/** How an entry is sealed now. */
export const sealOf = (entry: any): Seal =>
  entry?.inner?.seal === 'entry-derive' ? 'key' : entry?.inner?.seal === 'entry-passphrase' ? 'passphrase' : entry?.sealedWith ?? 'none';
