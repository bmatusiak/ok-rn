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
 * S5: receipt messages come by sync, and pairReceipts shows one only when it
 *     hashes to its receipt link.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {block, chain, codes, copy, sync as syncLib, receipts} from 'node-onlykey-lib/edge';
import {fromHex, toHex} from 'node-onlykey-lib/bytes';
import type {EdgeCopyKey, EdgeLinkRecord, EdgeSource} from './edgeFake';
import {raiseAlarms} from './edgeAlerts';
import {computerHeldMs} from './vendorBridge';
import {currentNet, edgeKey} from './net';

const KEY_PREFIX = (): string => edgeKey('mirror.');
const READ_BATCH = 16;

type StoredMirror = {
  /* 1 since the clean start (Brad, 2026-10-07); a copy without it is the old chain's and is not read */
  v?: number;
  deviceId: string;
  links: {link: string; head: string; reveal?: string}[];
  messages: Record<string, string>;
  lastSeen: {seq: number; head: string} | null;
  lastSync: number | null;
  setAside?: {link: string; head: string; at: number}[];
  seen?: Record<string, number>;
  reasons?: Record<string, {agent: string; text: string; at: number}>;
  refusals?: {agent: string; seq: number; status: string; at: number}[];
  publicKey?: string;
  continued?: ContinueCheck | null;
  merged?: {seq: number; head: string; signature: string; at: number}[];
  seals?: {seq: number; head: string; signature: string; ended: number[]}[];
};

/*
 * R28: this copy's chain begins with a CONTINUE link - checked once against the
 * old copies this phone keeps (lib copy.checkContinue). ok: it names exactly an
 * old copy's head (and, when that copy starts at its chain's first link, its
 * debts). Not ok: 'no-old-copy' (restored onto this phone - nothing to compare)
 * or 'no-match' (no copy here has that head - shown as an alarm).
 */
export type ContinueCheck = {ok: boolean; fromDeviceId?: string; oldSeq: number; debtsChecked?: boolean; reason?: string};

export type Seal = {seq: number; head: Uint8Array; signature: Uint8Array; ended: number[]};

export type Mirror = {
  deviceId: Uint8Array;
  links: EdgeLinkRecord[];
  messages: Record<number, string>;
  lastSeen: {seq: number; head: Uint8Array} | null;
  lastSync: number | null;
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
  /*
   * B7 stage 2: EDGE_NOTE - the agent's own words (spec 2026-10-04). Kept as it
   * said them; the tab shows a reason only for a seq that agent's budget paid
   * (checked at display: a note can come before its link is synced). They change
   * nothing - no state, no debts, no budgets.
   */
  reasons: Record<number, {agent: string; text: string; at: number}>;
  /* refused TX starts as the agents reported them (their word; the key's own count is HEAD's), newest 50 */
  refusals: {agent: string; seq: number; status: string; at: number}[];
  /*
   * R28 (spec: "keep the old checkpoint public key with the old copy"): the key's
   * checkpoint public key, saved at each sync - so after the key moves to its own
   * chain, this old copy and its checkpoints stay checkable without the key.
   */
  publicKey?: Uint8Array | null;
  continued?: ContinueCheck | null;
  /*
   * On ANOTHER device's copy (2026-10-08): the signed checkpoints of that device this
   * phone merged its log up to, when you approved it - what the next offer is checked
   * against (a rollback or a changed head alarms; lib sync.anchorCheck). No link on this
   * key records a merge: pairing and sync are all app (Brad).
   */
  merged?: {seq: number; head: Uint8Array; signature: Uint8Array; at: number}[];
  /*
   * SEALED BLOCKS (BLOCKS.md §2, §2a; Brad, 2026-10-07: "checkpoints can happen on a
   * budget grant end, like it's the end of the block of transactions"; "we only need
   * to verify the new stuff"). A checkpoint the key signed over a head this phone had
   * just verified, taken when a budget had ended since the last seal. NOT a
   * "verified" mark: the next session checks the signature again, with the public
   * key the key gives that session, and re-welds the stored links up to it.
   * ended: the grant ids not live when the seal was taken (to see a new end).
   */
  seals?: Seal[];
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
  /** B7 stage 2: refused TX starts the agents reported (their word), newest last */
  refusals?: Mirror['refusals'];
  /** records moved out of the copy because they were never links of this chain (Mirror.setAside) */
  setAside?: {seq: number | null; at: number}[];
  /** R28: this chain continues an old one (Mirror.continued) */
  continued?: ContinueCheck | null;
};

const asideOf = (mirror: Mirror) => mirror.setAside.map(x => {
  try { return {seq: chain.decodeLink(x.link).seq, at: x.at}; } catch { return {seq: null, at: x.at}; }
});

export type EdgeRow = {
  seq: number;
  fields: ReturnType<typeof chain.decodeLink>;
  weld: string;
  verified: boolean;
  receipt?: ReturnType<typeof receipts.pairReceipts>['uses'][number];
  /** when this phone first stored the link (its clock; links carry no time) */
  seenAt?: number;
  /** B7 stage 2: the reason an agent's note gave for this seq (not yet checked against the budget's agent) */
  note?: {agent: string; text: string; at: number};
};

const storageKey = (deviceId: Uint8Array) => KEY_PREFIX() + toHex(deviceId);

/*
 * THE COPY IN MEMORY FOR THE SESSION (option A; Brad, 2026-10-07: "option A is good").
 * Every sync read the whole copy back from storage, parsed it, and hashed it to see
 * whether anything had edited it - on the A13 ~130 ms to load and 60-500 ms to hash,
 * every sync. Now storage is read once a session; after that the copy lives here and
 * storage is only written. Other apps cannot edit this process's memory, so the copy
 * in memory is the one this session checked: what changed since is told by its
 * RECORDS - the same objects (appended to) or not - with nothing to hash.
 *   An edit to the copy in STORAGE while the app runs must still turn red, so it is
 *   never written over: each save first reads the stored text back and compares it
 *   with what this session last read or wrote (a string compare - no parsing, no
 *   hashing). Different: something else wrote it - the save is not made, the copy in
 *   memory is dropped, and the next sync reads storage and checks it (red if edited).
 *   Found by its test (2026-10-07): without this the next save quietly erased the
 *   edit. The Sync button (forgetVerifiedFor) and a restart read storage at once.
 * Records are never changed in place (tamper replaces them), and loadMirror hands out
 * a copy of the lists, so a caller that changes it without saving changes nothing.
 */
const inMemory = new Map<string, Mirror>();
/* the stored text as this session last read or wrote it */
const storedText = new Map<string, string>();
function cloneMirror(m: Mirror): Mirror {
  return {
    ...m, links: m.links.slice(), messages: {...m.messages}, seen: {...m.seen}, reasons: {...m.reasons},
    refusals: m.refusals.slice(), setAside: m.setAside.slice(),
    ...(m.merged ? {merged: m.merged.slice()} : {}), ...(m.seals ? {seals: m.seals.slice()} : {}),
  };
}
/* each record's stored form, kept with it: a save turns only the NEW records into hex (A13: "save 80-290") */
type StoredLink = StoredMirror['links'][number];
const storedForm = new WeakMap<EdgeLinkRecord, StoredLink>();
function storedOf(l: EdgeLinkRecord): StoredLink {
  let x = storedForm.get(l);
  if (!x) {
    x = {link: toHex(l.link), head: toHex(l.head), ...(l.reveal ? {reveal: toHex(l.reveal)} : {})};
    storedForm.set(l, x);
  }
  return x;
}

export async function loadMirror(deviceId: Uint8Array): Promise<Mirror> {
  const kept = inMemory.get(toHex(deviceId));
  if (kept) return cloneMirror(kept);
  const m = await readMirror(deviceId);
  inMemory.set(toHex(deviceId), m);
  return cloneMirror(m);
}

async function readMirror(deviceId: Uint8Array): Promise<Mirror> {
  const raw = await AsyncStorage.getItem(storageKey(deviceId));
  if (raw) storedText.set(toHex(deviceId), raw);
  else storedText.delete(toHex(deviceId));
  if (!raw) return {deviceId, links: [], messages: {}, lastSeen: null, lastSync: null, setAside: [], seen: {}, reasons: {}, refusals: []};
  const s = JSON.parse(raw) as StoredMirror;
  if (s.v !== 1) {
    /* the old chain's copy (before the clean start, edgeV1.ts): not read - this key starts again */
    storedText.delete(toHex(deviceId));
    return {deviceId, links: [], messages: {}, lastSeen: null, lastSync: null, setAside: [], seen: {}, reasons: {}, refusals: []};
  }
  return {
    deviceId: fromHex(s.deviceId),
    links: s.links.map(l => {
      const r = {link: fromHex(l.link), head: fromHex(l.head), reveal: l.reveal ? fromHex(l.reveal) : null};
      storedForm.set(r, l);
      return r;
    }),
    messages: Object.fromEntries(Object.entries(s.messages).map(([k, v]) => [Number(k), v])),
    lastSeen: s.lastSeen ? {seq: s.lastSeen.seq, head: fromHex(s.lastSeen.head)} : null,
    lastSync: s.lastSync,
    setAside: (s.setAside ?? []).map(x => ({link: fromHex(x.link), head: fromHex(x.head), at: x.at})),
    seen: Object.fromEntries(Object.entries(s.seen ?? {}).map(([k, v]) => [Number(k), v])),
    reasons: Object.fromEntries(Object.entries(s.reasons ?? {}).map(([k, v]) => [Number(k), v])),
    refusals: s.refusals ?? [],
    publicKey: s.publicKey ? fromHex(s.publicKey) : null,
    continued: s.continued ?? null,
    merged: (s.merged ?? []).map(a => ({seq: a.seq, head: fromHex(a.head), signature: fromHex(a.signature), at: a.at})),
    seals: (s.seals ?? []).map(x => ({seq: x.seq, head: fromHex(x.head), signature: fromHex(x.signature), ended: x.ended ?? []})),
  };
}

export async function saveMirror(m: Mirror): Promise<void> {
  const id = toHex(m.deviceId);
  const s: StoredMirror = {
    v: 1,
    deviceId: toHex(m.deviceId),
    links: m.links.map(storedOf),
    messages: Object.fromEntries(Object.entries(m.messages).map(([k, v]) => [String(k), v])),
    lastSeen: m.lastSeen ? {seq: m.lastSeen.seq, head: toHex(m.lastSeen.head)} : null,
    lastSync: m.lastSync,
    seen: Object.fromEntries(Object.entries(m.seen).map(([k, v]) => [String(k), v])),
    ...(Object.keys(m.reasons).length ? {reasons: Object.fromEntries(Object.entries(m.reasons).map(([k, v]) => [String(k), v]))} : {}),
    ...(m.refusals.length ? {refusals: m.refusals} : {}),
    ...(m.setAside.length ? {setAside: m.setAside.map(x => ({link: toHex(x.link), head: toHex(x.head), at: x.at}))} : {}),
    ...(m.publicKey ? {publicKey: toHex(m.publicKey)} : {}),
    ...(m.continued ? {continued: m.continued} : {}),
    ...(m.merged?.length ? {merged: m.merged.map(a => ({seq: a.seq, head: toHex(a.head), signature: toHex(a.signature), at: a.at}))} : {}),
    ...(m.seals?.length ? {seals: m.seals.map(x => ({seq: x.seq, head: toHex(x.head), signature: toHex(x.signature), ended: x.ended}))} : {}),
  };
  const text = JSON.stringify(s);
  const now = await AsyncStorage.getItem(storageKey(m.deviceId));
  if (inMemory.has(id) && now !== (storedText.get(id) ?? null)) {
    console.log(`[edge] the stored copy of ${id.slice(0, 8)} was changed outside this session - not written over; the next sync reads it back and checks it`);
    inMemory.delete(id);
    verifiedNow.delete(id);
    answers.delete(id);
    return;
  }
  inMemory.set(id, cloneMirror(m));
  if (now === text) return; /* nothing new to store */
  await AsyncStorage.setItem(storageKey(m.deviceId), text);
  storedText.set(id, text);
}

export async function forgetMirror(deviceId: Uint8Array): Promise<void> {
  inMemory.delete(toHex(deviceId));
  storedText.delete(toHex(deviceId));
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
/*
 * ONE CHAIN STATE (okrn-edge-tab.md S3a; Brad, 2026-10-07: "unify the state of the
 * block chain in memory so ui and bluetooth dont need to constantly hammer
 * verifying ... 1 complete check, both bluetooth and ui or anything else can just
 * ask for validity"; "a lot easier to manage and save, and watch events on it").
 *
 * There were three verify paths with their own state - the tab's (here), the
 * soft key's check() for the display and the agent sheet, and Approve/resume's
 * strict copy check in the library - and on a Galaxy A13 one agent request could
 * run four full checks of 10-16 s each, on the thread that answers Bluetooth.
 * Now everything asks chainState.validity(): the answer from memory when nothing
 * changed (the same head, the same stored copy), else ONE queued sync - the same
 * queue every sync already shares, so two askers never run two checks. Every
 * sync records its answer and emits: 'checked' (every check), 'changed' (the
 * verdict's kind changed), 'sealed' (a budget end sealed a block).
 * In memory only: nothing "verified" is stored (BLOCKS.md 2a rule 4).
 */
export type ChainAnswer = {
  deviceId: string;
  view: EdgeView;
  /* the head the copy verified through - what Approve/resume hand the key (R27) - or null */
  head: {seq: number; head: Uint8Array} | null;
  ok: boolean;
  path: 'full' | 'new-links' | 'sealed' | 'skipped' | null;
  at: number;
  ms: number;
};
type ChainEvent = 'checked' | 'changed' | 'sealed';
const answers = new Map<string, ChainAnswer>();
const asking = new Map<string, Promise<ChainAnswer>>();
const chainListeners: Record<ChainEvent, Set<(a: ChainAnswer) => void>> = {checked: new Set(), changed: new Set(), sealed: new Set()};
function emitChain(ev: ChainEvent, a: ChainAnswer) {
  /* a listener's failure is its own: it never breaks the check that told it */
  for (const fn of [...chainListeners[ev]]) {
    try { fn(a); } catch (e) { console.warn(`[edge] chain state: a '${ev}' listener threw: ${String(e)}`); }
  }
}
function record(deviceId: Uint8Array, mirror: Mirror, view: EdgeView, ms: number, sealsBefore: number) {
  const id = toHex(deviceId);
  const prev = answers.get(id);
  const seen = mirror.lastSeen;
  /* a head only from a check that vouched for it now: lastSeen can be an older sync's, and a tampered copy offers none */
  const vouched = view.verdict.kind === 'verified' || view.verdict.kind === 'gap';
  const head = vouched && seen && view.headSeq !== null && seen.seq === view.headSeq ? {seq: seen.seq, head: seen.head} : null;
  const a: ChainAnswer = {deviceId: id, view, head, ok: view.verdict.kind === 'verified' && head !== null, path: lastCheck, at: Date.now(), ms};
  answers.set(id, a);
  emitChain('checked', a);
  if (!prev || prev.view.verdict.kind !== view.verdict.kind) emitChain('changed', a);
  if ((mirror.seals?.length ?? 0) > sealsBefore) emitChain('sealed', a);
}
export const chainState = {
  /** watch the chain: returns the unsubscribe */
  on(ev: ChainEvent, fn: (a: ChainAnswer) => void): () => void {
    chainListeners[ev].add(fn);
    return () => { chainListeners[ev].delete(fn); };
  },
  /** the last answer, no I/O (null before the first check this session) */
  current(deviceId: Uint8Array): ChainAnswer | null {
    return answers.get(toHex(deviceId)) ?? null;
  },
  /**
   * Is the copy valid, up to the key's live head? From memory when nothing
   * changed; else one sync (queued with every other) - never a second check
   * while one runs.
   */
  validity(source: EdgeSource): Promise<ChainAnswer> {
    const id = toHex(source.deviceId);
    const running = asking.get(id);
    if (running) return running;
    const p = (async () => {
      const t0 = Date.now();
      const prev = answers.get(id);
      const head = await source.head();
      if (prev?.head && prev.head.seq === head.seq && toHex(prev.head.head) === toHex(head.head)) {
        const was = verifiedNow.get(id);
        const m = await loadMirror(source.deviceId);
        if (was && was.seq === head.seq && was.head === toHex(head.head) && sameCopy(m.links, was)) {
          const a: ChainAnswer = {...prev, path: 'skipped', at: Date.now(), ms: Date.now() - t0};
          answers.set(id, a);
          return a;
        }
      }
      await sync(source);
      return answers.get(id)!;
    })().finally(() => asking.delete(id));
    asking.set(id, p);
    return p;
  },
};

export function sync(source: EdgeSource, now = Date.now()): Promise<{mirror: Mirror; view: EdgeView}> {
  const run = syncing.then(() => syncNow(source, now), () => syncNow(source, now));
  syncing = run.catch(() => undefined);
  return run;
}

/**
 * B7 stage 2: keep a verified EDGE_NOTE (edgeAgents checked the signature and
 * that its key was registered with a press). In the sync queue, so a note and a
 * sync never save over each other.
 */
export type EdgeNote = {agent: string; seq: number; reason?: string; receiptMsg?: string; txRefused?: string};
export function addNote(deviceId: Uint8Array, n: EdgeNote, now = Date.now()): Promise<void> {
  const run = syncing.then(() => addNoteNow(deviceId, n, now), () => addNoteNow(deviceId, n, now));
  syncing = run.catch(() => undefined);
  return run;
}
async function addNoteNow(deviceId: Uint8Array, n: EdgeNote, now: number): Promise<void> {
  const m = await loadMirror(deviceId);
  const agent = n.agent.toLowerCase();
  if (n.reason !== undefined) m.reasons[n.seq] = {agent, text: n.reason, at: now};
  /* by the use's seq, as receipts.pairReceipts reads it: shown only if it hashes to the receipt */
  if (n.receiptMsg !== undefined) m.messages[n.seq] = n.receiptMsg;
  if (n.txRefused !== undefined) m.refusals = [...m.refusals, {agent, seq: n.seq, status: n.txRefused, at: now}].slice(-50);
  await saveMirror(m);
}

/* R28: a chain that begins with a CONTINUE - which old copy on this phone does it continue? */
async function continuedFrom(mirror: Mirror): Promise<ContinueCheck | null> {
  const first = mirror.links[0];
  let f;
  try { f = first ? chain.decodeLink(first.link) : null; } catch { return null; }
  if (!f || f.op !== OP_CONTINUE) return null;
  const own = toHex(mirror.deviceId);
  const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(KEY_PREFIX()) && k !== KEY_PREFIX() + own);
  let unverifiable: ContinueCheck | null = null;
  for (const k of keys) {
    const old = await loadMirror(fromHex(k.slice(KEY_PREFIX().length)));
    const r = copy.checkContinue(first.link, {deviceId: old.deviceId, links: old.links});
    if (r.ok) return {ok: true, fromDeviceId: toHex(old.deviceId), oldSeq: r.oldSeq ?? f.seq - 1, debtsChecked: r.debtsChecked};
    if (r.reason === 'unverifiable') unverifiable = {ok: false, fromDeviceId: toHex(old.deviceId), oldSeq: r.oldSeq ?? f.seq - 1, reason: 'unverifiable'};
  }
  return unverifiable ?? {ok: false, oldSeq: f.seq - 1, reason: keys.length ? 'no-match' : 'no-old-copy'};
}
const OP_CONTINUE = 16;
const OP_RECEIPT = codes.OP.RECEIPT;

async function syncNow(source: EdgeSource, now: number): Promise<{mirror: Mirror; view: EdgeView}> {
  /* where a sync's time goes, for the log (Brad, 2026-10-06) - times only */
  const t0 = Date.now();
  const held0 = computerHeldMs(); /* a computer's turn on the key during this sync: waited for, not worked */
  let tp = t0;
  const laps: string[] = [];
  const lap = (n: string) => { const x = Date.now(); laps.push(`${n} ${x - tp}`); tp = x; };
  const mirror = await loadMirror(source.deviceId);
  const sealsBefore = mirror.seals?.length ?? 0;
  lap('load');
  const head = await source.head();
  lap('head');
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
      /*
       * NOT PAST THE HEAD THIS SYNC READ (Pixel, 2026-10-07). A batch can return a link
       * the key wrote AFTER the head was read (a commit signing mid-sync). Kept, the copy
       * held a link beyond the key's head, the check read that as the key going
       * backwards - "rollback at #496", tampered (red) - and every check fell back to the
       * full one (on the A13: 22 s, and Bluetooth replies missed). It waits for the next
       * sync, which reads a head that includes it.
       */
      if (seqOf(r) > head.seq) { welded = false; break; }
      const last = mirror.links[mirror.links.length - 1];
      if (follows(last, r)) { mirror.links.push(r); mirror.seen[seqOf(r)] = mirror.seen[seqOf(r)] ?? now; }
      else if (!last || seqOf(r) > seqOf(last)) { welded = false; break; } /* not this chain's next link: read it again next sync */
    }
    if (!welded) break;
    from = seqOf(got[got.length - 1]) + 1;
  }
  lap('read');
  mirror.messages = {...mirror.messages, ...(await source.messages())};
  lap('messages');
  /*
   * A CHECKPOINT ONLY WHEN IT IS USED (Pixel, 2026-10-07: copyKey 400-1070 ms a
   * sync, 4.5 s in a burst - each agent request makes a sync, and each sync's key
   * requests queue behind the agent's own). The key signs one for: the first check
   * this session (full or sealed), a check that was not clean, and a seal (a budget
   * ended since the last one). A sync that only checks new links on a verified copy
   * is anchored by the head it read; if that check does not hold, liveView asks for
   * the checkpoint before the full check. (BLOCKS.md's "a seal at every sync" is the
   * key-to-key sync, R30 - not this copy's sync.)
   */
  const live = await source.budgets(true).then(bs => bs.map(b => b.grantId)).catch(() => null as number[] | null);
  lap('budgets');
  const was = verifiedNow.get(toHex(source.deviceId));
  const wantCheckpoint = !was || was.verdict.kind !== 'verified' || (live !== null && sealDue(mirror, live));
  const ownKey = source.copyKey ? await source.copyKey({checkpoint: wantCheckpoint}).catch(() => null) : null;
  lap(wantCheckpoint ? 'copyKey' : 'copyKey (no checkpoint)');
  if (ownKey?.publicKey) mirror.publicKey = ownKey.publicKey;
  if (!mirror.continued) mirror.continued = await continuedFrom(mirror);
  lap('continued');
  mirror.lastSync = now;
  vlaps = {};
  const view = await liveView(source, mirror, head, ownKey ?? undefined);
  lap('verify');
  laps[laps.length - 1] += ` (${Object.entries(vlaps).map(([k, v]) => `${k} ${v}`).join(', ')})`;
  if (view.verdict.kind === 'verified' || view.verdict.kind === 'gap') {
    mirror.lastSeen = {seq: head.seq, head: head.head};
  }
  /* a budget ended since the last seal: its block is closed - seal it (BLOCKS.md §2, stage a) */
  if (live && view.verdict.kind === 'verified' && ownKey?.checkpoint) takeSeal(mirror, head, ownKey.checkpoint, live);
  await saveMirror(mirror);
  lap('save');
  /* B7: new alarms become phone notifications - every sync, the tab's and the background copy's */
  await raiseAlarms(mirror, view, live ?? []).catch(() => {});
  lap('alarms');
  const held = computerHeldMs() - held0;
  console.log(`[edge] sync ${Date.now() - t0} ms${held ? ` (${held} of it a computer's turn on the key)` : ''}: ${laps.join(', ')} -> ${view.verdict.kind}${'through' in view.verdict ? ` #${view.verdict.through}` : ''}${'seq' in view.verdict ? ` at #${view.verdict.seq}` : ''} (${lastCheck})`);
  record(source.deviceId, mirror, view, Date.now() - t0, sealsBefore);
  return {mirror, view};
}

/**
 * okedge sync phase 2 (Brad, 2026-10-05): a place that keeps copies offers
 * links for this phone's copy. Merged into a CANDIDATE, checked the same way
 * every sync is (liveView: the key's head, its ring, its checkpoint - R27),
 * and NOT saved: the caller saves only after the sheet, Yes, the press and
 * the key's `sync` link. A link that disagrees with one this copy already holds
 * is a fork - reported, never chosen between (the copy stays as it is).
 */
export async function mergeOffered(source: EdgeSource, offered: EdgeLinkRecord[], now = Date.now()):
  Promise<{candidate: Mirror; added: EdgeLinkRecord[]; conflicts: number[]; view: EdgeView}> {
  const mirror = await loadMirror(source.deviceId);
  const m = syncLib.merge(mirror.links, offered);
  const candidate: Mirror = {...mirror, links: m.links, seen: {...mirror.seen}};
  for (const r of m.added) candidate.seen[seqOf(r)] = candidate.seen[seqOf(r)] ?? now;
  const view = await liveView(source, candidate);
  return {candidate, added: m.added, conflicts: m.conflicts, view};
}

/**
 * Keep the offered links - only after the key linked the sync. IN THE SYNC QUEUE,
 * and merged into the copy as it is NOW, not saved from mergeOffered's candidate:
 * found on the Pixel (2026-10-05), the background copy sync loaded the mirror
 * while the sheet was up and saved it after this, dropping the five links the
 * person had just approved. A link that now disagrees is a fork: nothing kept.
 */
/**
 * R30 (P2c): a SIBLING's links offered to this phone, merged with the copy of
 * that sibling's chain it already holds (the same store, keyed by the sibling's
 * device id - it never mixes with this phone's own chain). No I/O beyond the read.
 */
export async function mergeOther(chainId: Uint8Array, offered: EdgeLinkRecord[]):
  Promise<{mirror: Mirror; links: EdgeLinkRecord[]; added: EdgeLinkRecord[]; conflicts: number[]}> {
  const mirror = await loadMirror(chainId);
  const m = syncLib.merge(mirror.links, offered);
  return {mirror, links: m.links, added: m.added, conflicts: m.conflicts};
}

/**
 * Keep another device's links and the checkpoint they were merged up to - only once you
 * approved that device's held log (edgeDevices.approveHeld). In the sync queue.
 */
export function keepMerged(chainId: Uint8Array, publicKey: Uint8Array, added: EdgeLinkRecord[], point: NonNullable<Mirror['merged']>[number], now = Date.now()): Promise<void> {
  const run = syncing.then(() => keepMergedNow(chainId, publicKey, added, point, now), () => keepMergedNow(chainId, publicKey, added, point, now));
  syncing = run.catch(() => undefined);
  return run;
}
async function keepMergedNow(chainId: Uint8Array, publicKey: Uint8Array, added: EdgeLinkRecord[], point: NonNullable<Mirror['merged']>[number], now: number): Promise<void> {
  const mirror = await loadMirror(chainId);
  const m = syncLib.merge(mirror.links, added);
  if (m.conflicts.length) throw new Error(`a fork at #${m.conflicts.join(', #')} - nothing kept`);
  mirror.links = m.links;
  for (const r of m.added) mirror.seen[seqOf(r)] = mirror.seen[seqOf(r)] ?? now;
  mirror.publicKey = publicKey;
  mirror.merged = [...(mirror.merged ?? []), point];
  mirror.lastSync = now;
  await saveMirror(mirror);
}

export function keepOffered(deviceId: Uint8Array, added: EdgeLinkRecord[], now = Date.now()): Promise<void> {
  const run = syncing.then(() => keepOfferedNow(deviceId, added, now), () => keepOfferedNow(deviceId, added, now));
  syncing = run.catch(() => undefined);
  return run;
}
async function keepOfferedNow(deviceId: Uint8Array, added: EdgeLinkRecord[], now: number): Promise<void> {
  const mirror = await loadMirror(deviceId);
  const m = syncLib.merge(mirror.links, added);
  if (m.conflicts.length) throw new Error(`a fork at #${m.conflicts.join(', #')} - nothing kept`);
  mirror.links = m.links;
  for (const r of m.added) mirror.seen[seqOf(r)] = mirror.seen[seqOf(r)] ?? now;
  await saveMirror(mirror);
}

/**
 * The verdict against what the key says THIS session: its live head, the links
 * its ring still holds (read fresh - what it holds is not missing, whatever the
 * copy can weld) and, from a key that signs, its public key and checkpoints
 * (R27 anchors). Every verdict the tab shows comes through here.
 */
export async function liveView(source: EdgeSource, mirror: Mirror, known?: {seq: number; head: Uint8Array; ringFrom: number}, knownKey?: EdgeCopyKey | null): Promise<EdgeView> {
  const head = known ?? (await source.head());
  /* the key's public key and checkpoint: the caller's, when it has just read them (syncNow) - not a second read */
  const key = knownKey !== undefined ? knownKey : source.copyKey ? await source.copyKey() : null;
  const ring = async () => (head.seq >= 0 ? source.read(head.ringFrom, head.seq - head.ringFrom + 1) : []);
  /* the receipt pairing on its own turn of the JS thread, not stacked on the check (rows, A13: 215 ms) */
  await new Promise<void>(r => setTimeout(r, 0));
  receiptsBySeq(mirror);
  await new Promise<void>(r => setTimeout(r, 0));
  /*
   * The key's ring is for the FULL check (its links count as held). When this
   * session's check can reuse its result or check only the new links, the ring
   * is not read; if that turns out to need the full check after all, the ring is
   * read and it runs again from nothing.
   */
  if (shortPath(mirror, head)) {
    const view = evaluateWith(mirror, head, [], key, true);
    if (view && lastCheck !== 'full') return view;
    verifiedNow.delete(toHex(mirror.deviceId));
  }
  /* a sync in a burst asks no checkpoint (syncNow); the full check has one again */
  const full = key && !key.checkpoint && source.copyKey ? await source.copyKey().catch(() => key) : key;
  return evaluate(mirror, head, await ring(), full);
}

/* would evaluate() reuse this session's result, or check only the new links? (no I/O, no verification) */
function shortPath(mirror: Mirror, head: {seq: number; head: Uint8Array}): boolean {
  const was = verifiedNow.get(toHex(mirror.deviceId));
  if (!was) return false;
  if (was.seq === head.seq && was.head === toHex(head.head) && sameCopy(mirror.links, was)) return true;
  return was.verdict.kind === 'verified' && was.count > 0 && was.count <= mirror.links.length &&
    (mirror.links.length > was.count || head.seq > was.seq) && samePrefix(mirror.links, was);
}

/* the grant ids the copy has seen opened (grant-create links) */
function grantIdsIn(mirror: Mirror): number[] {
  const ids = new Set<number>();
  for (const r of mirror.links) {
    try { const f = chain.decodeLink(r.link); if (f.op === codes.OP.GRANT_CREATE) ids.add(f.grantId); } catch { /* not a link: the check reports it */ }
  }
  return [...ids];
}

/*
 * TAKE A SEAL (BLOCKS.md §2, stage a): only over the head this sync just verified,
 * with the key's checkpoint for exactly that head, and only when a budget ended
 * since the last seal - its block of transactions is closed. Stage (b) moves this
 * into the key (R15: grant-end and the checkpoint in one step).
 */
function takeSeal(mirror: Mirror, head: {seq: number; head: Uint8Array}, cp: {seq: number; head: Uint8Array; signature: Uint8Array}, live: number[]) {
  if (cp.seq !== head.seq || toHex(cp.head) !== toHex(head.head)) return;
  const seals = mirror.seals ?? [];
  const last = seals[seals.length - 1];
  if (last && cp.seq <= last.seq) return;
  if (!sealDue(mirror, live)) return;
  const ended = grantIdsIn(mirror).filter(id => !live.includes(id));
  const before = new Set(last ? last.ended : []);
  /* every seal is kept: each closes a block, and the blocks (BLOCKS.md §3) need all of them (one seal ~ 200 bytes) */
  mirror.seals = [...seals, {seq: cp.seq, head: cp.head, signature: cp.signature, ended}];
  console.log(`[edge] sealed #${cp.seq}: budget ${ended.filter(id => !before.has(id)).join(', ')} ended - its block is closed`);
}

/* a budget the copy saw opened is no longer live, and the last seal did not close it */
function sealDue(mirror: Mirror, live: number[]): boolean {
  const last = mirror.seals?.[mirror.seals.length - 1];
  const before = new Set(last ? last.ended : []);
  return grantIdsIn(mirror).some(id => !live.includes(id) && !before.has(id));
}

/*
 * THE SEALED START (BLOCKS.md §2a). With nothing verified this session: the newest
 * seal at or below the copy's end, its signature checked with the public key the
 * key gave THIS session (whose device id must be this copy's). copy.assess then
 * welds the stored links to it like any anchor. Anything that does not fit -> null,
 * and the caller checks in full.
 */
/* why the last sealed start was not used, said once per reason (a fallback is never silent) */
let sealNoSaid = '';
function sealedStart(mirror: Mirror, head: {seq: number}, key: EdgeCopyKey | null): {seq: number; head: Uint8Array} | null {
  const no = (why: string) => {
    if (mirror.seals?.length && sealNoSaid !== why) { sealNoSaid = why; console.log(`[edge] sealed start not used: ${why}`); }
    return null;
  };
  if (!mirror.seals?.length || !mirror.links.length) return null;
  if (!key?.publicKey) return no('the key gave no public key this session');
  let deviceId: Uint8Array;
  try { deviceId = chain.deviceIdOf(key.publicKey); } catch { return no('the public key is not an Edge key'); }
  if (toHex(deviceId) !== toHex(mirror.deviceId)) return no(`the public key is another device's (${toHex(deviceId).slice(0, 8)} vs ${toHex(mirror.deviceId).slice(0, 8)})`);
  const lastSeq = seqOf(mirror.links[mirror.links.length - 1]);
  const seal = [...mirror.seals].reverse().find(x => x.seq <= lastSeq && x.seq <= head.seq);
  if (!seal) return no('no seal at or below the end of the copy');
  if (!chain.verifyCheckpoint({deviceId, seq: seal.seq, head: seal.head}, seal.signature, key.publicKey)) return no(`the seal at #${seal.seq} does not verify`);
  /* the stored links are welded to it by copy.assess, as every anchor is - a copy that starts late (the Pixel's, at #268) works as in the full check */
  return {seq: seal.seq, head: seal.head};
}

/** The Sync button: the next check of this key's copy is a full one, from the root. */
export function forgetVerifiedFor(deviceId: Uint8Array) {
  verifiedNow.delete(toHex(deviceId));
  inMemory.delete(toHex(deviceId)); /* from storage, as at a start: an edit made there shows now */
  answers.delete(toHex(deviceId));
}

/** Verify a mirror against a live head (no I/O): the verdict and the rows to draw. */
/*
 * WHAT THIS SESSION ALREADY VERIFIED - IN MEMORY ONLY (Brad, 2026-10-05: a
 * pull-down re-checked the whole chain every time). Keyed by the key's head AND
 * the copy's records (option A: the same objects in memory - what this session
 * checked; a changed or removed record is a different object). Never saved - a
 * restart reads the copy from storage and checks it again.
 *   nothing here (app start)        -> full check
 *   same head, same copy            -> skip: the result from memory
 *   head moved, older part the same -> only the new links, from the verified head
 *   anything else (copy changed)    -> full check (red if it fails)
 */
/* seq/head: the key's head then; count/lastSeq/lastHead: the copy's links then, and its last one (whose stored head the full check confirmed) */
type Verified = {seq: number; head: string; count: number; lastSeq: number; lastHead: string; records: EdgeLinkRecord[]; verdict: Verdict; unverified: number[]};
/* the copy holds exactly the records this session verified / starts with them (the rest appended) */
function samePrefix(links: EdgeLinkRecord[], was: {records: EdgeLinkRecord[]}): boolean {
  if (links.length < was.records.length) return false;
  for (let i = 0; i < was.records.length; i++) if (links[i] !== was.records[i]) return false;
  return true;
}
function sameCopy(links: EdgeLinkRecord[], was: {records: EdgeLinkRecord[]}): boolean {
  return links.length === was.records.length && samePrefix(links, was);
}
const verifiedNow = new Map<string, Verified>();
/** for tests: forget what this session verified, as a restart does */
export function forgetVerified() {
  verifiedNow.clear();
  inMemory.clear(); /* a restart reads the copy from storage again */
  storedText.clear();
  answers.clear(); /* the one chain state forgets too: a restart */
  asking.clear();
}
/*
 * WHERE THE VERIFY TIME GOES (A13, 2026-10-07: "verify 740" on a check that was
 * skipped). Summed over a sync, printed in its log line: decode, receipts, check, rows.
 */
let vlaps: Record<string, number> = {};
const vlap = (n: string, t0: number) => { vlaps[n] = (vlaps[n] ?? 0) + Date.now() - t0; };
/* the path each verdict took, for the log and the tests: not saved, nothing sensitive */
let lastCheck: 'full' | 'new-links' | 'sealed' | 'skipped' | null = null;
export function lastCheckPath() {
  return lastCheck;
}

export function evaluate(mirror: Mirror, head: {seq: number; head: Uint8Array; ringFrom: number} | null, held: EdgeLinkRecord[] = [], key: EdgeCopyKey | null = null): EdgeView {
  return evaluateWith(mirror, head, held, key, false)!;
}

/*
 * noFull: the quick path (liveView, without the key's ring). When only the full
 * check would do, it stops and says so (null) instead of running the full check
 * WITHOUT the ring and having liveView run it again with it - after a burst of
 * links on a Galaxy A13 that was 22.5 s of checking in one sync (2026-10-07).
 */
function evaluateWith(mirror: Mirror, head: {seq: number; head: Uint8Array; ringFrom: number} | null, held: EdgeLinkRecord[], key: EdgeCopyKey | null, noFull: boolean): EdgeView | null {
  const td = Date.now();
  const decoded = mirror.links.map(r => ({r, f: chain.decodeLink(r.link)}));
  vlap('decode', td);
  if (!head) {
    return {verdict: {kind: 'not-synced'}, headSeq: null, lastSync: mirror.lastSync, rows: rowsOf(decoded, new Set(), mirror), setAside: asideOf(mirror), refusals: mirror.refusals, continued: mirror.continued ?? null};
  }
  const id = toHex(mirror.deviceId);
  const headHex = toHex(head.head);
  const tc = Date.now();
  const viewOf = (verdict: Verdict, unverified: Set<number>): EdgeView => {
    vlap('check', tc);
    const tr = Date.now();
    try {
      return {verdict, headSeq: head.seq, lastSync: mirror.lastSync, rows: rowsOf(decoded, unverified, mirror), setAside: asideOf(mirror), refusals: mirror.refusals, continued: mirror.continued ?? null};
    } finally { vlap('rows', tr); }
  };
  const was = verifiedNow.get(id);
  /*
   * ONE MOMENT OF THE KEY (as lib grants.check, Pixel 2026-10-06; seen again on the
   * A13 2026-10-07): the head and the key's checkpoint are separate reads, and a link
   * that lands between them (a push's signature right after a receipt) gives a
   * checkpoint for a NEWER head than the one checked. As an anchor past the end it
   * made the new-links check fail and sent every check to the full one. It is only
   * one anchor: check without it; the next sync has both at the same head.
   */
  const cp = key?.checkpoint && key.checkpoint.seq <= head.seq ? key.checkpoint : null;
  if (key?.checkpoint && !cp) console.log(`[edge] verify ${id.slice(0, 8)}: the key's checkpoint is for #${key.checkpoint.seq}, the head read was #${head.seq} - a link landed during the sync; checked without it`);
  const remember = (verdict: Verdict, unverified: number[]) => {
    const last = decoded[decoded.length - 1];
    verifiedNow.set(id, {seq: head.seq, head: headHex, count: mirror.links.length, lastSeq: last ? last.f.seq : -1, lastHead: last ? toHex(last.r.head) : '', records: mirror.links.slice(), verdict, unverified});
  };
  if (was && was.seq === head.seq && was.head === headHex && sameCopy(mirror.links, was)) {
    lastCheck = 'skipped';
    console.log(`[edge] verify ${id.slice(0, 8)}: skipped (same head #${head.seq}, same copy)`);
    return viewOf(was.verdict, new Set(was.unverified));
  }
  /*
   * A verified copy may carry losses the person accepted (R24) - older history,
   * unchanged while its records are: they and the seqs they leave unverified carry
   * over, and only the links after the copy's last verified one are new - the
   * key's head moved, or the copy caught up with links the key's ring held
   * (seen on the Pixel: a restart checked the copy, then the sync appended
   * #292 and checked it all again). A gap or a red verdict always goes to the
   * full check.
   */
  const grew = was && (mirror.links.length > was.count || head.seq > was.seq);
  if (was && grew && was.verdict.kind === 'verified' && was.count > 0 && was.count <= mirror.links.length &&
      samePrefix(mirror.links, was)) {
    const a = copy.assess(
      {links: mirror.links, openings: key?.openings ?? {}},
      {publicKey: key?.publicKey, deviceId: mirror.deviceId, head: {seq: head.seq, head: head.head}, held, checkpoint: cp},
      {from: {seq: was.lastSeq, head: fromHex(was.lastHead)}, ringFrom: head.ringFrom},
    );
    if (a.chain.ok && !a.chain.gaps.length && !a.open.length && !a.missing.length) {
      const lost = was.verdict.kind === 'verified' ? was.verdict.lost : undefined;
      const verdict: Verdict = lost ? {kind: 'verified', through: head.seq, lost} : {kind: 'verified', through: head.seq};
      remember(verdict, was.unverified);
      lastCheck = 'new-links';
      console.log(`[edge] verify ${id.slice(0, 8)}: new links #${was.lastSeq + 1}..#${head.seq} only`);
      return viewOf(verdict, new Set(was.unverified));
    }
    /* anything but a clean pass: the full check decides (and names what failed) */
    console.log(`[edge] verify ${id.slice(0, 8)}: new links not clean (${(a.chain.failure ? `${a.chain.failure.reason} at #${a.chain.failure.seq}` : `${a.chain.gaps.length} gap(s), ${a.open.length} open, ${a.missing.length} missing`)}) - full check`);
  }
  if (noFull) {
    lastCheck = 'full';
    return null;
  }
  /*
   * R27 "what counts as verified": the library's one answer, the same Approve
   * reads - anchors (genesis, HEAD, every checkpoint the key's own public key
   * verifies), the gap only what no anchor reaches, minus the key's own links,
   * and only a verified LOSS later than a gap covers it.
   *
   * SEALED (BLOCKS.md §2a; Brad, 2026-10-07: "we only need to verify the new
   * stuff"). With nothing from this session, the check starts from the newest seal
   * the key signed - its signature checked against the public key the key gave
   * THIS session - which stands in for every signature at or below it (one per
   * budget ever opened: the cost that grew with the chain). The stored links are
   * still welded to it and the verdict is computed as in the full check. A clean
   * result is the answer; anything else runs again without the seal, and that
   * full check decides.
   */
  const sealed = was ? null : sealedStart(mirror, head, key);
  const assessWith = (seal: {seq: number; head: Uint8Array} | null) => copy.assess(
    {links: mirror.links, openings: key?.openings ?? {}},
    {publicKey: key?.publicKey, deviceId: mirror.deviceId, head: {seq: head.seq, head: head.head}, held, checkpoint: cp},
    {ringFrom: head.ringFrom, lastSeen: mirror.lastSeen ?? undefined, ...(seal ? {sealed: seal} : {})},
  );
  let a = sealed ? assessWith(sealed) : null;
  if (a && sealed && !a.chain.failure && !a.open.length) {
    lastCheck = 'sealed';
    console.log(`[edge] verify ${id.slice(0, 8)}: sealed through #${sealed.seq} (its signature checked this session), full checks after it through #${head.seq}`);
  } else {
    if (a) console.log(`[edge] verify ${id.slice(0, 8)}: the sealed start was not clean (${a.chain.failure ? `${a.chain.failure.reason} at #${a.chain.failure.seq}` : `${a.chain.gaps.length} gap(s), ${a.open.length} open`}) - full check`);
    lastCheck = 'full';
    console.log(`[edge] verify ${id.slice(0, 8)}: full check through #${head.seq}${was && was.seq === head.seq && !sameCopy(mirror.links, was) ? ' (the copy changed under the same head)' : ''}`);
    a = assessWith(null);
  }
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
  remember(verdict, [...unverified]);
  return viewOf(verdict, unverified);
}

/*
 * THE RECEIPT PAIRING, ONCE PER COPY (A13, 2026-10-07: "rows 215" on every sync, a
 * skipped one too - one block on the JS thread that answers Bluetooth). Pairing
 * every use with its receipt and checking each receipt's message hash is the same
 * answer while the links and the messages are the same: the same records (option A)
 * and the messages as they are now, compared in full - a changed message pairs again
 * and shows its mismatch.
 */
/* one per chain: the A13 keeps the Pixel's chain too, and one slot was taken in turns */
const pairedMemo = new Map<string, {records: EdgeLinkRecord[]; messages: string; bySeq: Map<number, ReturnType<typeof receipts.pairReceipts>['uses'][number]>}>();
function receiptsBySeq(mirror: Mirror) {
  const id = toHex(mirror.deviceId);
  const messages = JSON.stringify(mirror.messages ?? {});
  const was = pairedMemo.get(id);
  if (was && was.messages === messages && sameCopy(mirror.links, was)) return was.bySeq;
  const t0 = Date.now();
  const paired = receipts.pairReceipts(mirror.links, mirror.messages);
  vlap('receipts', t0);
  const bySeq = new Map(paired.uses.map(u => [u.seq, u]));
  pairedMemo.set(id, {records: mirror.links.slice(), messages, bySeq});
  return bySeq;
}

function rowsOf(decoded: {r: EdgeLinkRecord; f: ReturnType<typeof chain.decodeLink>}[], unverified: Set<number>, mirror: Mirror): EdgeRow[] {
  const bySeq = receiptsBySeq(mirror);
  return decoded
    .map(({r, f}) => ({seq: f.seq, fields: f, weld: toHex(r.head), verified: !unverified.has(f.seq), receipt: bySeq.get(f.seq), seenAt: mirror.seen[f.seq], note: mirror.reasons[f.seq]}))
    .reverse();
}

/*
 * TESTING MODE: edit the phone's copy the ways an attacker could (spec 6), so
 * every red and amber verdict can be seen against a key that is telling the
 * truth. Each returns the edited mirror, already saved.
 */
export type Tamper = 'flip' | 'delete' | 'swap' | 'truncate' | 'forget' | 'stray' | 'receipt';
/*
 * IN THE SYNC QUEUE, like every other write to the copy: found on the Pixel
 * (2026-10-06), a background sync that had loaded the copy before "Flip a
 * receipt" was undone saved it back, and the restart found the flip still there.
 */
export function tamper(deviceId: Uint8Array, how: Tamper): Promise<Mirror> {
  const run = syncing.then(() => tamperNow(deviceId, how), () => tamperNow(deviceId, how));
  syncing = run.catch(() => undefined);
  return run;
}
async function tamperNow(deviceId: Uint8Array, how: Tamper): Promise<Mirror> {
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
  const flipped = (i: number) => {
    const link = m.links[i].link.slice();
    link[20] ^= 0x01;
    m.links[i] = {...m.links[i], link};
  };
  if (how === 'flip') flipped(mid);
  /* the newest RECEIPT link (Brad, 2026-10-06: "edit a stored ticket and it shows red"); a second flip restores it */
  if (how === 'receipt') {
    const at = m.links.map(r => chain.decodeLink(r.link).op).lastIndexOf(OP_RECEIPT);
    if (at >= 0) flipped(at);
  }
  if (how === 'delete') m.links.splice(mid, 1);
  if (how === 'swap') [m.links[mid], m.links[mid + 1]] = [m.links[mid + 1], m.links[mid]];
  if (how === 'truncate') m.links.splice(m.links.length - 2, 2);
  await saveMirror(m);
  return m;
}

/*
 * BLOCKS (BLOCKS.md §3, Brad 2026-10-07: "we use hash of a json"): this key's copy
 * cut at its seals into canonical JSON blocks - one per closed budget, each sealed
 * by the key's signed checkpoint - for Export. Each block is checked against the
 * key's public key kept with the copy and the block before it; one that does not
 * verify is still exported (that is the evidence), and counted.
 */
export async function blocksOf(deviceId: Uint8Array): Promise<{json: string; count: number; open: number; bad: number; reason?: string}> {
  const mirror = await loadMirror(deviceId);
  const r = block.blocksFrom({net: currentNet(), deviceId, records: mirror.links, seals: mirror.seals ?? []});
  let bad = 0;
  r.blocks.forEach((b: any, i: number) => {
    const v = mirror.publicKey ? block.verifyBlock(b, mirror.publicKey, i ? r.blocks[i - 1] : null) : {ok: false};
    if (!v.ok) bad += 1;
  });
  return {json: JSON.stringify(r.blocks, null, 2) + '\n', count: r.blocks.length, open: r.open, bad, ...(r.reason ? {reason: r.reason} : {})};
}
