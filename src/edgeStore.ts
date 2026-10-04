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
import type {EdgeCopyKey, EdgeLinkRecord, EdgeSource} from './edgeFake';
import {raiseAlarms} from './edgeAlerts';

const KEY_PREFIX = 'okrn.edge.mirror.';
const READ_BATCH = 16;

type StoredMirror = {
  deviceId: string;
  links: {link: string; head: string; reveal?: string}[];
  messages: Record<string, string>;
  lastSeen: {seq: number; head: string} | null;
  lastSync: number | null;
  vouch?: {seq: number; head: string; tag: string} | null;
  setAside?: {link: string; head: string; at: number}[];
  seen?: Record<string, number>;
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
  /*
   * Records that were never links of this chain, moved out of `links` (kept, not
   * deleted, so what happened stays readable). A late PICKUP reply, read one
   * report out of step, was once stored as link #447194052 (the A13,
   * 2026-10-04): above the key's head, it read as a rollback and stopped Sync.
   */
  setAside: {link: Uint8Array; head: Uint8Array; at: number}[];
  /*
   * B7: when THIS phone first stored each link (seq -> ms, its own clock). The
   * chain carries no time; this is the copy's note, editable like the rest of it,
   * so the tab shows it as "seen", never as when the key did it.
   */
  seen: Record<number, number>;
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
  /** records moved out of the copy because they were never links of this chain (Mirror.setAside) */
  setAside?: {seq: number | null; at: number}[];
};

const asideOf = (mirror: Mirror) => mirror.setAside.map(x => {
  try { return {seq: chain.decodeLink(x.link).seq, at: x.at}; } catch { return {seq: null, at: x.at}; }
});

export type EdgeRow = {
  seq: number;
  fields: ReturnType<typeof chain.decodeLink>;
  weld: string;
  verified: boolean;
  ticket?: ReturnType<typeof tickets.pairTickets>['uses'][number];
  /** when this phone first stored the link (its clock; links carry no time) */
  seenAt?: number;
};

const storageKey = (deviceId: Uint8Array) => KEY_PREFIX + toHex(deviceId);

export async function loadMirror(deviceId: Uint8Array): Promise<Mirror> {
  const raw = await AsyncStorage.getItem(storageKey(deviceId));
  if (!raw) return {deviceId, links: [], messages: {}, lastSeen: null, lastSync: null, vouch: null, setAside: [], seen: {}};
  const s = JSON.parse(raw) as StoredMirror;
  return {
    deviceId: fromHex(s.deviceId),
    links: s.links.map(l => ({link: fromHex(l.link), head: fromHex(l.head), reveal: l.reveal ? fromHex(l.reveal) : null})),
    messages: Object.fromEntries(Object.entries(s.messages).map(([k, v]) => [Number(k), v])),
    lastSeen: s.lastSeen ? {seq: s.lastSeen.seq, head: fromHex(s.lastSeen.head)} : null,
    lastSync: s.lastSync,
    vouch: s.vouch ? {seq: s.vouch.seq, head: fromHex(s.vouch.head), tag: fromHex(s.vouch.tag)} : null,
    setAside: (s.setAside ?? []).map(x => ({link: fromHex(x.link), head: fromHex(x.head), at: x.at})),
    seen: Object.fromEntries(Object.entries(s.seen ?? {}).map(([k, v]) => [Number(k), v])),
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
    seen: Object.fromEntries(Object.entries(m.seen).map(([k, v]) => [String(k), v])),
    ...(m.setAside.length ? {setAside: m.setAside.map(x => ({link: toHex(x.link), head: toHex(x.head), at: x.at}))} : {}),
  };
  await AsyncStorage.setItem(storageKey(m.deviceId), JSON.stringify(s));
}

export async function forgetMirror(deviceId: Uint8Array): Promise<void> {
  await AsyncStorage.removeItem(storageKey(deviceId));
}

const seqOf = (r: EdgeLinkRecord) => chain.decodeLink(r.link).seq;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/*
 * Does `r` belong after `prev` in this copy? A link the key wrote has bytes
 * 47-63 zero (R3); the very next seq must weld from prev's head. A later seq
 * cannot be welded here (a gap) - the copy check judges it.
 */
function follows(prev: EdgeLinkRecord | undefined, r: EdgeLinkRecord): boolean {
  let f;
  try { f = chain.decodeLink(r.link); } catch { return false; }
  if (!f.reservedZero) return false;
  if (!prev) return true;
  const p = seqOf(prev);
  if (f.seq <= p) return false;
  return f.seq !== p + 1 || sameBytes(chain.weld(prev.head, r.link), r.head);
}

/*
 * Records past the key's head that no sync ever verified, and that do not weld
 * straight onto the record before them, go to setAside. MEASURED ON THE A13
 * (2026-10-04, decoded from its storage): a PICKUP had timed out after link #86
 * but before #86's head; that late head arrived first in the next PICKUP, every
 * report after it shifted by one, and the copy stored the head (32 bytes, then
 * zeros - its reserved bytes WERE zero) as "link #447194052", with link #86 as
 * its head. A seq jump looks like a gap, so shape alone cannot tell it apart.
 * What can: a real link past the key's head was verified when it was copied
 * (lastSeen reaches it) or welds onto the one before it. So a copy that is
 * truly ahead of the key still reads as a rollback.
 */
function setAsideStrays(mirror: Mirror, keySeq: number, now: number): void {
  const verified = mirror.lastSeen ? mirror.lastSeen.seq : -1;
  for (let n = mirror.links.length; n > 0; n = mirror.links.length) {
    const r = mirror.links[n - 1];
    let seq;
    try { seq = seqOf(r); } catch { seq = Infinity; }
    if (seq <= keySeq || seq <= verified) return;
    const prev = mirror.links[n - 2];
    if (prev && seq === seqOf(prev) + 1 && follows(prev, r)) return;
    mirror.links.pop();
    mirror.setAside.push({link: r.link, head: r.head, at: now});
  }
}

/**
 * B1: HEAD, then READ from the last mirrored seq; store what came; verify the
 * whole mirror against the live head; keep `lastSeen` only when it verified.
 */
/*
 * ONE SYNC AT A TIME. The Edge tab and the background copy (useEdgeBackgroundSync)
 * both sync; two at once would each load the mirror, append and save, and the
 * second save would drop the first one's links.
 */
let syncing: Promise<unknown> = Promise.resolve();
export function sync(source: EdgeSource, now = Date.now()): Promise<{mirror: Mirror; view: EdgeView}> {
  const run = syncing.then(() => syncNow(source, now), () => syncNow(source, now));
  syncing = run.catch(() => undefined);
  return run;
}

async function syncNow(source: EdgeSource, now: number): Promise<{mirror: Mirror; view: EdgeView}> {
  const mirror = await loadMirror(source.deviceId);
  const head = await source.head();
  setAsideStrays(mirror, head.seq, now);
  const have = mirror.links.length ? seqOf(mirror.links[mirror.links.length - 1]) : -1;
  /*
   * From the next link this copy lacks - but never before the oldest link the
   * key still holds: anything older is gone from the key, and asking for it
   * returned an empty batch that stopped the sync short of the ring (seen on the
   * Pixel: a forgotten copy read nothing and the ring links it lacked looked
   * like tampering).
   */
  for (let from = Math.max(have + 1, head.ringFrom); from <= head.seq; ) {
    const got = await source.read(from, READ_BATCH);
    if (!got.length) break;
    let welded = true;
    for (const r of got) {
      const last = mirror.links[mirror.links.length - 1];
      if (follows(last, r)) { mirror.links.push(r); mirror.seen[seqOf(r)] = mirror.seen[seqOf(r)] ?? now; }
      else if (!last || seqOf(r) > seqOf(last)) { welded = false; break; } /* not this chain's next link: read it again next sync */
    }
    if (!welded) break;
    from = seqOf(got[got.length - 1]) + 1;
  }
  mirror.messages = {...mirror.messages, ...(await source.messages())};
  /* R26: keep the key's newest vouch with the copy (a restoring key gives none) */
  const v = source.vouch ? await source.vouch() : null;
  if (v) mirror.vouch = v;
  mirror.lastSync = now;
  const view = await liveView(source, mirror, head);
  if (view.verdict.kind === 'verified' || view.verdict.kind === 'gap') {
    mirror.lastSeen = {seq: head.seq, head: head.head};
  }
  await saveMirror(mirror);
  /* B7: new alarms become phone notifications - every sync, the tab's and the background copy's */
  await raiseAlarms(mirror, view).catch(() => {});
  return {mirror, view};
}

/**
 * The verdict against what the key says THIS session: its live head, the links
 * its ring still holds (read fresh - what it holds is not missing, whatever the
 * copy can weld) and, from a key that signs, its public key and checkpoints
 * (R27 anchors). Every verdict the tab shows comes through here.
 */
export async function liveView(source: EdgeSource, mirror: Mirror, known?: {seq: number; head: Uint8Array; ringFrom: number}): Promise<EdgeView> {
  const head = known ?? (await source.head());
  const held = head.seq >= 0 ? await source.read(head.ringFrom, head.seq - head.ringFrom + 1) : [];
  const key = source.copyKey ? await source.copyKey() : null;
  return evaluate(mirror, head, held, key);
}

/** Verify a mirror against a live head (no I/O): the verdict and the rows to draw. */
export function evaluate(mirror: Mirror, head: {seq: number; head: Uint8Array; ringFrom: number} | null, held: EdgeLinkRecord[] = [], key: EdgeCopyKey | null = null): EdgeView {
  const decoded = mirror.links.map(r => ({r, f: chain.decodeLink(r.link)}));
  if (!head) {
    return {verdict: {kind: 'not-synced'}, headSeq: null, lastSync: mirror.lastSync, rows: rowsOf(decoded, new Set(), mirror), setAside: asideOf(mirror)};
  }
  /*
   * R27 "what counts as verified": the library's one answer, the same Approve
   * reads - anchors (genesis, HEAD, every checkpoint the key's own public key
   * verifies), the gap only what no anchor reaches, minus the key's own links,
   * and only a verified LOSS later than a gap covers it.
   */
  const a = copy.assess(
    {links: mirror.links, openings: key?.openings ?? {}},
    {publicKey: key?.publicKey, deviceId: mirror.deviceId, head: {seq: head.seq, head: head.head}, held, checkpoint: key?.checkpoint ?? null},
    {ringFrom: head.ringFrom, lastSeen: mirror.lastSeen ?? undefined},
  );
  const result = a.chain;
  const unverified = new Set<number>();
  for (const g of result.gaps) for (let s = g.from; s <= g.to; s++) unverified.add(s);
  let verdict: Verdict;
  const open: {from: number; to: number}[] = a.open;
  const lost: {from: number; to: number}[] = a.missing;
  if (result.failure) verdict = {kind: 'tampered', seq: result.failure.seq, reason: result.failure.reason};
  else if (open.length) verdict = {kind: 'gap', through: result.verifiedThrough, from: open[0].from, to: open[0].to};
  else if (lost.length) verdict = {kind: 'verified', through: head.seq, lost};
  else verdict = {kind: 'verified', through: result.verifiedThrough};
  return {verdict, headSeq: head.seq, lastSync: mirror.lastSync, rows: rowsOf(decoded, unverified, mirror), setAside: asideOf(mirror)};
}

function rowsOf(decoded: {r: EdgeLinkRecord; f: ReturnType<typeof chain.decodeLink>}[], unverified: Set<number>, mirror: Mirror): EdgeRow[] {
  const paired = tickets.pairTickets(mirror.links, mirror.messages);
  const bySeq = new Map(paired.uses.map(u => [u.seq, u]));
  return decoded
    .map(({r, f}) => ({seq: f.seq, fields: f, weld: toHex(r.head), verified: !unverified.has(f.seq), ticket: bySeq.get(f.seq), seenAt: mirror.seen[f.seq]}))
    .reverse();
}

/*
 * TESTING MODE: edit the phone's copy the ways an attacker could (spec 6), so
 * every red and amber verdict can be seen against a key that is telling the
 * truth. Each returns the edited mirror, already saved.
 */
export type Tamper = 'flip' | 'delete' | 'swap' | 'truncate' | 'forget' | 'stray';
export async function tamper(deviceId: Uint8Array, how: Tamper): Promise<Mirror> {
  const m = await loadMirror(deviceId);
  const mid = Math.floor(m.links.length / 2);
  if (how === 'forget') {
    await forgetMirror(deviceId);
    return loadMirror(deviceId);
  }
  if (how === 'stray') {
    /* the A13's stray (2026-10-04): a late head report stored as a link - reserved bytes zero, a seq far past the head */
    const junk = new Uint8Array(64); /* the A13's shape: a head report (32 bytes, then zeros) */
    junk.set(Uint8Array.from({length: 32}, () => Math.floor(Math.random() * 256)), 0);
    junk[3] = 0x1a; /* a seq far past the head */
    m.links.push({link: junk, head: Uint8Array.from({length: 32}, () => Math.floor(Math.random() * 256)), reveal: null});
    await saveMirror(m);
    return m;
  }
  if (m.links.length < 3) return m;
  if (how === 'flip') m.links[mid].link[20] ^= 0x01;
  if (how === 'delete') m.links.splice(mid, 1);
  if (how === 'swap') [m.links[mid], m.links[mid + 1]] = [m.links[mid + 1], m.links[mid]];
  if (how === 'truncate') m.links.splice(m.links.length - 2, 2);
  await saveMirror(m);
  return m;
}
