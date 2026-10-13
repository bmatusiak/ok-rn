import AsyncStorage from '@react-native-async-storage/async-storage';
import {WIZARD_SAVE_KEY} from './screens/keychain/KeyChainWizard';

/**
 * "Set this up in Key Chain" from another screen (Brad, 2026-10-12: Messages'
 * make-and-forget composite key moves to Key Chain, "the better user frendly
 * flow that does not take away from security").
 *
 * The Wizard already reopens answers saved under WIZARD_SAVE_KEY (config mode
 * unmounts it), so starting it part way is the same thing: the answers are
 * saved, then App switches to the Key Chain tab, whose screen mounts and finds
 * them. The same listener pattern as edgeNav.ts.
 */
type Start = {answers: Record<string, unknown>; history: Record<string, unknown>[]};
const listeners = new Set<() => void>();

/** The Wizard at PQC keys → A PGP identity for email. */
export const QUANTUM_SAFE_PGP: Start = {answers: {use: 'pq', pqKind: 'pgp'}, history: [{}, {use: 'pq'}]};

export async function openKeyChainWizard(start: Start): Promise<void> {
  await AsyncStorage.setItem(WIZARD_SAVE_KEY, JSON.stringify(start)).catch(() => {});
  for (const fn of [...listeners]) fn();
}

export function onOpenKeyChainWizard(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
