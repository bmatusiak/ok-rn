/*
 * R30 (P2c), the ONE TIMELINE: the chains of the keys this key is paired with,
 * as this phone holds them - each sync with a paired key keeps that key's links
 * up to its signed checkpoint, beside the anchor this key wrote for them
 * (edgeStore keepSibling). The Presses list shows them under the anchor that
 * brought them, so both keys' presses read as one history.
 *
 * Read-only: the phone's copies, the key's sibling list (no press), the names
 * the person gave (edgeSiblingNames). Reloaded whenever this key's head moves.
 */
import {useEffect, useState} from 'react';
import {chain} from 'node-onlykey-lib/edge';
import {fromHex} from 'node-onlykey-lib/bytes';
import {loadMirror} from '../edgeStore';
import {siblingNames} from '../edgeSiblingNames';

export type SiblingLink = {seq: number; op: number; slot: number; flags: number; seenAt?: number};
export type SiblingChain = {
  deviceId: string;
  key: string;
  name: string | null;
  links: SiblingLink[]; /* oldest first */
  anchors: {seq: number; mySeq: number}[]; /* in this key's order */
};

export function useSiblingChains(siblings: () => Promise<{index: number; key: string; deviceId: string}[]>, headSeq: number | null | undefined): SiblingChain[] {
  const [chains, setChains] = useState<SiblingChain[]>([]);
  useEffect(() => {
    let gone = false;
    (async () => {
      try {
        const list = await siblings();
        const names = await siblingNames();
        const out: SiblingChain[] = [];
        for (const s of list) {
          const m = await loadMirror(fromHex(s.deviceId));
          const links = m.links.map(r => {
            const f = chain.decodeLink(r.link);
            return {seq: f.seq, op: f.op, slot: f.slot, flags: f.flags, seenAt: m.seen[f.seq]};
          });
          const anchors = (m.anchors ?? []).map(a => ({seq: a.seq, mySeq: a.mySeq})).sort((a, b) => a.mySeq - b.mySeq);
          out.push({deviceId: s.deviceId, key: s.key, name: names[s.key.toLowerCase()] ?? null, links, anchors});
        }
        if (!gone) setChains(out);
      } catch {
        /* the key did not answer (locked, restarting): keep what was shown */
      }
    })();
    return () => { gone = true; };
  }, [siblings, headSeq]);
  return chains;
}

/**
 * The other key's links an anchor (this key's link #mySeq) brought: after the
 * previous anchor of the same key, up to this one's seq. Newest first, as Presses reads.
 */
export function linksForAnchor(chains: SiblingChain[], mySeq: number): {chain: SiblingChain; upTo: number; links: SiblingLink[]} | null {
  for (const c of chains) {
    const i = c.anchors.findIndex(a => a.mySeq === mySeq);
    if (i < 0) continue;
    const upTo = c.anchors[i].seq;
    const from = i > 0 ? c.anchors[i - 1].seq : -1;
    return {chain: c, upTo, links: c.links.filter(l => l.seq > from && l.seq <= upTo).reverse()};
  }
  return null;
}
