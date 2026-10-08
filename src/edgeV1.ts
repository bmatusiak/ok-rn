/**
 * THE CLEAN START ON THE PHONE (Brad, 2026-10-07: "we change all the schemas to
 * V1, because we are doing a reset"; R31). The same build whose soft key starts
 * fresh (its Edge record is version 1 and an older one is erased) clears the
 * phone's Edge records once, on its first launch: every copy, seal, budget, agent,
 * alarm and sibling name - live and testnet - so nothing of the old chain is read
 * against the new one. What stays: the Key Chain list (the key's keys survive the
 * reset - R31 keeps every private key), Bluetooth pairing, settings.
 *
 * Runs at app start, before the login screen can start any soft key. Done once:
 * the mark is written last, so a launch cut short does it again.
 *
 * THE FIRST RELEASE (Brad, 2026-10-08: "v0 turns to v1, v1 = first release of the protocol
 * and schemas"): the mark moved from '1' to 'release-1', so the build that ships v1 clears
 * the development chain's records once more - together with its soft key, whose OKEDGEv1
 * record replaces the development OKEDGE01 one. A user's log is never reset after this.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {LIVE_PREFIX} from './net';

export const EDGE_V1_MARK = 'okrn.edgeV1';
export const EDGE_V1_DONE = 'release-1';
/* every Edge record (net.ts edgeKey: okrn.edge. and okrn.edge.test.), the sibling names' old key, the testnet's Key Chain list */
const EDGE_KEYS = (k: string) => k.startsWith(LIVE_PREFIX) || k === 'edge.siblingNames' || k === 'okrn.keychain.test.list';

export async function resetEdgeStoreOnce(): Promise<{removed: number} | null> {
  if ((await AsyncStorage.getItem(EDGE_V1_MARK)) === EDGE_V1_DONE) return null;
  const keys = (await AsyncStorage.getAllKeys()).filter(EDGE_KEYS);
  for (const k of keys) await AsyncStorage.removeItem(k);
  await AsyncStorage.setItem(EDGE_V1_MARK, EDGE_V1_DONE);
  console.log(`[edge] the clean start (v1): ${keys.length} Edge record(s) of the old chain removed`);
  return {removed: keys.length};
}
