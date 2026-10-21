/**
 * THE AGENT IDENTITY THIS PHONE KEEPS (SPEC H7; Brad, 2026-10-20: "edge should hold the
 * identity (on the app side) with the block chain", shown in the Edge Management drawer,
 * "computer sets, phone keeps").
 *
 * The record (node-onlykey-lib/edge identity.js): the ssh label and gpg user ID the key
 * derives the agent's keys from, the committer, and the certificate a computer made with
 * `onlykey-js edge setup`. It is kept here, not on any computer, so every computer paired
 * with this phone is the same agent with the same keys (Brad: "same identity, so i wont
 * need to keep adding a bunch of keys to github").
 *
 * One record per net - edgeKey() keeps the live chain's and the testnet's apart (H6).
 * Written only by the Edge sheet's Approve (edgeAgents.ts); read by every agent's start
 * (EDGE_IDENTITY_GET) and by Edge Management.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {identity as identityLib} from 'node-onlykey-lib/edge';
import {edgeKey} from './net';

const RECORD = (): string => edgeKey('identity');
const SET_BY = (): string => edgeKey('identitySetBy');

export type KeptIdentity = {record: any; setBy: {computer: string; at: number} | null};
type Listener = (k: KeptIdentity | null) => void;
const listeners = new Set<Listener>();

/** The record this phone keeps on the current net, or null (none, or not a usable one). */
export async function loadIdentity(): Promise<any | null> {
  try {
    const r = JSON.parse((await AsyncStorage.getItem(RECORD())) || 'null');
    return r && identityLib.checkRecord(r).ok ? identityLib.clean(r) : null;
  } catch {
    return null;
  }
}

/** The record and which computer set it, for Edge Management. */
export async function loadKept(): Promise<KeptIdentity | null> {
  const record = await loadIdentity();
  if (!record) return null;
  let setBy = null;
  try { setBy = JSON.parse((await AsyncStorage.getItem(SET_BY())) || 'null'); } catch { setBy = null; }
  return {record, setBy};
}

/** Keep it - only after the person approved it on the sheet. */
export async function keepIdentity(record: any, computer: string): Promise<void> {
  const checked = identityLib.checkRecord(record);
  if (!checked.ok) throw new Error(`not a usable identity (${checked.reason})`);
  const r = identityLib.clean(record);
  const setBy = {computer, at: Date.now()};
  await AsyncStorage.setItem(RECORD(), JSON.stringify(r));
  await AsyncStorage.setItem(SET_BY(), JSON.stringify(setBy));
  for (const l of listeners) l({record: r, setBy});
}

/** Edge Management redraws when an identity is kept. */
export function onIdentity(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
