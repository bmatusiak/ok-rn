/**
 * The phone's copy of a key's Edge chain (spec okrn-edge-tab.md 4.2), and
 * turning it into the tab's verdict.
 *
 * S1: one mirror per key, keyed by device_id (soft and hard key never share
 *     one), in AsyncStorage like the Key Chain list.
 * S3: the mirror is UNTRUSTED. Anything with the phone can edit it, so every
 *     verdict is recomputed from it against the key's LIVE head (B4: nothing is
 *     green that was not recomputed this session). The only thing kept from an
 *     earlier session is `lastSeen` - the head this phone verified last time -
 *     and it is used only to catch a key that went BACKWARDS (rollback).
 * S5: ticket messages come by sync, and pairTickets shows one only when it
 *     hashes to its ticket link.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {chain, copy, tickets} from 'node-onlykey-lib/edge';
import {fromHex, toHex} from 'node-onlykey-lib/bytes';
import type {EdgeLinkRecord, EdgeSource} from './edgeFake';

const KEY_PREFIX = 'okrn.edge.mirror.';
const READ_BATCH = 16;

type StoredMirror = {
  deviceId: string;
  links: {link: string; head: string; reveal?: string}[];
  messages: Record<string, string>;
  lastSeen: {seq: number; head: string} | null;
  lastSync: number | null;
  vouch?: {seq: number; head: string; tag: string} | null;
};

export type Mirror = {
  deviceId: Uint8Array;
  links: EdgeLinkRecord[];
  messages: Record<number, string>;
  lastSeen: {seq: number; head: Uint8Array} | null;
  lastSync: number | null;
  /*
   * R26: the newest head the key vouched for (its HMAC tag over (seq, head)),
   * read at each sync. After a restore, only a replay up to a vouched head can
   * be committed; anything newer falls under the LOSS.
   */
  vouch: {seq: number; head: Uint8Array; tag: Uint8Array} | null;
};

export type Verdict =
  | {kind: 'no-edge'}
  | {kind: 'locked'}
  | {kind: 'not-synced'}
  /* lost: ranges the person accepted as gone (LOSS links, R24) - verified around them */
  | {kind: 'verified'; through: number; lost?: {from: number; to: number}[]}
  | {kind: 'gap'; through: number; from: number; to: number}
  | {kind: 'tampered'; seq: number; reason: string};

export type EdgeView = {
  verdict: Verdict;
  headSeq: number | null;
  lastSync: number | null;
  /** newest first, for the chain view */
  rows: EdgeRow[];
};

export type EdgeRow = {
  seq: number;
  fields: ReturnType<typeof chain.decodeLink>;
  weld: string;
  verified: boolean;
  ticket?: ReturnType<typeof tickets.pairTickets>['uses'][number];
};

const storageKey = (deviceId: Uint8Array) => KEY_PREFIX + toHex(deviceId);

export async function loadMirror(deviceId: Uint8Array): Promise<Mirror> {
  const raw = await AsyncStorage.getItem(storageKey(deviceId));
  if (!raw) return {deviceId, links: [], messages: {}, lastSeen: null, lastSync: null, vouch: null};
  const s = JSON.parse(raw) as StoredMirror;
  return {
    deviceId: fromHex(s.deviceId),
    links: s.links.map(l => ({link: fromHex(l.link), head: fromHex(l.head), reveal: l.reveal ? fromHex(l.reveal) : null})),
    messages: Object.fromEntries(Object.entries(s.messages).map(([k, v]) => [Number(k), v])),
    lastSeen: s.lastSeen ? {seq: s.lastSeen.seq, head: fromHex(s.lastSeen.head)} : null,
    lastSync: s.lastSync,
    vouch: s.vouch ? {seq: s.vouch.seq, head: fromHex(s.vouch.head), tag: fromHex(s.vouch.tag)} : null,
  };
}

export async function saveMirror(m: Mirror): Promise<void> {
  const s: StoredMirror = {
    deviceId: toHex(m.deviceId),
    links: m.links.map(l => ({link: toHex(l.link), head: toHex(l.head), ...(l.reveal ? {reveal: toHex(l.reveal)} : {})})),
    messages: Object.fromEntries(Object.entries(m.messages).map(([k, v]) => [String(k), v])),
    lastSeen: m.lastSeen ? {seq: m.lastSeen.seq, head: toHex(m.lastSeen.head)} : null,
    lastSync: m.lastSync,
    vouch: m.vouch ? {seq: m.vouch.seq, head: toHex(m.vouch.head), tag: toHex(m.vouch.tag)} : null,
  };
  await AsyncStorage.setItem(storageKey(m.deviceId), JSON.stringify(s));
}

export async function forgetMirror(deviceId: Uint8Array): Promise<void> {
  await AsyncStorage.removeItem(storageKey(deviceId));
}

const seqOf = (r: EdgeLinkRecord) => chain.decodeLink(r.link).seq;

/**
 * B1: HEAD, then READ from the last mirrored seq; store what came; verify the
 * whole mirror against the live head; keep `lastSeen` only when it verified.
 */
export async function sync(source: EdgeSource, now = Date.now()): Promise<{mirror: Mirror; view: EdgeView}> {
  const mirror = await loadMirror(source.deviceId);
  const head = await source.head();
  const have = mirror.links.length ? seqOf(mirror.links[mirror.links.length - 1]) : -1;
  for (let from = have + 1; from <= head.seq; ) {
    const got = await source.read(from, READ_BATCH);
    if (!got.length) break;
    for (const r of got) if (seqOf(r) > (mirror.links.length ? seqOf(mirror.links[mirror.links.length - 1]) : -1)) mirror.links.push(r);
    from = seqOf(got[got.length - 1]) + 1;
  }
  mirror.messages = {...mirror.messages, ...(await source.messages())};
  /* R26: keep the key's newest vouch with the copy (a restoring key gives none) */
  const v = source.vouch ? await source.vouch() : null;
  if (v) mirror.vouch = v;
  mirror.lastSync = now;
  const view = evaluate(mirror, head);
  if (view.verdict.kind === 'verified' || view.verdict.kind === 'gap') {
    mirror.lastSeen = {seq: head.seq, head: head.head};
  }
  await saveMirror(mirror);
  return {mirror, view};
}

/** Verify a mirror against a live head (no I/O): the verdict and the rows to draw. */
export function evaluate(mirror: Mirror, head: {seq: number; head: Uint8Array; ringFrom: number} | null): EdgeView {
  const decoded = mirror.links.map(r => ({r, f: chain.decodeLink(r.link)}));
  if (!head) {
    return {verdict: {kind: 'not-synced'}, headSeq: null, lastSync: mirror.lastSync, rows: rowsOf(decoded, new Set(), mirror)};
  }
  const result = chain.verify(mirror.links, {
    deviceId: mirror.deviceId,
    expectHead: {seq: head.seq, head: head.head},
    lastSeen: mirror.lastSeen ?? undefined,
    ringFrom: head.ringFrom,
  });
  const unverified = new Set<number>();
  for (const g of result.gaps) for (let s = g.from; s <= g.to; s++) unverified.add(s);
  let verdict: Verdict;
  /* a gap a LOSS link covers is not a gap any more (R24, R27): the person accepted it - the lib's own rule */
  const open: {from: number; to: number}[] = copy.uncoveredGaps(mirror.links, result.gaps);
  if (result.failure) verdict = {kind: 'tampered', seq: result.failure.seq, reason: result.failure.reason};
  else if (open.length) verdict = {kind: 'gap', through: result.verifiedThrough, from: open[0].from, to: open[0].to};
  else if (result.gaps.length) verdict = {kind: 'verified', through: head.seq, lost: result.gaps};
  else verdict = {kind: 'verified', through: result.verifiedThrough};
  return {verdict, headSeq: head.seq, lastSync: mirror.lastSync, rows: rowsOf(decoded, unverified, mirror)};
}

function rowsOf(decoded: {r: EdgeLinkRecord; f: ReturnType<typeof chain.decodeLink>}[], unverified: Set<number>, mirror: Mirror): EdgeRow[] {
  const paired = tickets.pairTickets(mirror.links, mirror.messages);
  const bySeq = new Map(paired.uses.map(u => [u.seq, u]));
  return decoded
    .map(({r, f}) => ({seq: f.seq, fields: f, weld: toHex(r.head), verified: !unverified.has(f.seq), ticket: bySeq.get(f.seq)}))
    .reverse();
}

/*
 * TESTING MODE: edit the phone's copy the ways an attacker could (spec 6), so
 * every red and amber verdict can be seen against a key that is telling the
 * truth. Each returns the edited mirror, already saved.
 */
export type Tamper = 'flip' | 'delete' | 'swap' | 'truncate' | 'forget';
export async function tamper(deviceId: Uint8Array, how: Tamper): Promise<Mirror> {
  const m = await loadMirror(deviceId);
  const mid = Math.floor(m.links.length / 2);
  if (how === 'forget') {
    await forgetMirror(deviceId);
    return loadMirror(deviceId);
  }
  if (m.links.length < 3) return m;
  if (how === 'flip') m.links[mid].link[20] ^= 0x01;
  if (how === 'delete') m.links.splice(mid, 1);
  if (how === 'swap') [m.links[mid], m.links[mid + 1]] = [m.links[mid + 1], m.links[mid]];
  if (how === 'truncate') m.links.splice(m.links.length - 2, 2);
  await saveMirror(m);
  return m;
}
