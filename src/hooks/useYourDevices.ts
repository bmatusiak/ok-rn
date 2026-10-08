/*
 * YOUR DEVICES' LOGS, as this phone holds them (Brad, 2026-10-08: "how we view the block
 * chain in the app between 2 devices creating blocks using the same key with different
 * salts (non-transferable), so i know a different key made the block, each key with a
 * different salt gives a different fingerprint we can track, but because its made with our
 * key we want that block").
 *
 * Each device you approved (edgeDevices) with the links merged from it, tagged with its
 * fingerprint (device id) and its NAMETAG - from its own signed statements, the newest
 * one wins, older ones are "previously". Read-only; reloaded when this key's head moves or
 * a merge or a nametag changes.
 */
import {useEffect, useState} from 'react';
import {chain} from 'node-onlykey-lib/edge';
import {fromHex} from 'node-onlykey-lib/bytes';
import {loadMirror} from '../edgeStore';
import {loadDevices, nametagOf, onDevicesChanged} from '../edgeDevices';

export type DeviceLink = {seq: number; op: number; slot: number; flags: number; grantId: number; seenAt?: number};
export type YourDevice = {
  deviceId: string;
  publicKey: string;
  nametag: string | null;
  previously: string[];
  links: DeviceLink[]; /* newest first */
  mergedUpTo: number | null;
  mergedAt: number | null;
};

export function useYourDevices(headSeq: number | null | undefined): YourDevice[] {
  const [devices, setDevices] = useState<YourDevice[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => onDevicesChanged(() => setTick(t => t + 1)), []);
  useEffect(() => {
    let gone = false;
    (async () => {
      try {
        const out: YourDevice[] = [];
        for (const d of await loadDevices()) {
          const m = await loadMirror(fromHex(d.deviceId));
          const links = m.links.map(r => {
            const f = chain.decodeLink(r.link);
            return {seq: f.seq, op: f.op, slot: f.slot, flags: f.flags, grantId: f.grantId, seenAt: m.seen[f.seq]};
          }).reverse();
          const last = (m.merged ?? [])[(m.merged ?? []).length - 1] ?? null;
          const n = await nametagOf(d);
          out.push({deviceId: d.deviceId, publicKey: d.publicKey, nametag: n?.nametag ?? null, previously: n?.previously ?? [], links, mergedUpTo: last?.seq ?? null, mergedAt: last?.at ?? null});
        }
        if (!gone) setDevices(out);
      } catch {
        /* storage not readable now: keep what was shown */
      }
    })();
    return () => { gone = true; };
  }, [headSeq, tick]);
  return devices;
}
