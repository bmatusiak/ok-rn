/**
 * WHICH CHAIN THIS PHONE'S SOFT KEY IS ON: the live one or the testnet
 * (BLOCKS.md §5; Brad, 2026-10-07: "everthing for test is throwaway").
 *
 * The net is decided once, when the firmware starts: the login screen's "Log in"
 * starts it on storageSlot, "Enter testing mode" on testStorageSlot (buildInfo.ts).
 * A started firmware cannot change its storage, so the net then holds until the
 * app restarts. It is read back from the folder the firmware runs on, never
 * assumed - after a JS reload the firmware is still running and says where.
 *
 * Every Edge record on the phone is stored under the net's own prefix, so a
 * testnet budget, copy or agent can never land in the live chain's storage, and
 * clearing the testnet is deleting its prefix (and its slot folder).
 */
import {testStorageSlot} from './buildInfo';

export type Net = 'live' | 'test';

let current: Net = 'live';
const listeners = new Set<(net: Net) => void>();

export function currentNet(): Net {
  return current;
}

/** The net of a firmware storage folder: the testnet's slot, or live. */
export function netOfStorageDir(dir: string | null | undefined): Net {
  const leaf = String(dir ?? '').replace(/[\/]+$/, '').split(/[\/]/).pop();
  return leaf === testStorageSlot ? 'test' : 'live';
}

export function setNet(net: Net): void {
  if (net === current) return;
  current = net;
  for (const l of [...listeners]) l(net);
}

export function onNet(listener: (net: Net) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** What a notification title starts with on the testnet, so a test alarm never reads as a live one. */
export function netTag(): string {
  return current === 'test' ? 'TESTNET · ' : '';
}

/** The prefix every Edge storage key on this net starts with. */
export const LIVE_PREFIX = 'okrn.edge.';
export const TEST_PREFIX = 'okrn.edge.test.';

/** An Edge storage key on the current net: okrn.edge.<rest> live, okrn.edge.test.<rest> on the testnet. */
export function edgeKey(rest: string): string {
  return (current === 'test' ? TEST_PREFIX : LIVE_PREFIX) + rest;
}
