/*
 * YOUR DEVICES, THIS PHONE'S NAMETAG, AND THE LOGS HELD FOR YOUR APPROVAL (Brad, 2026-10-08).
 *
 *   "pairing and sync is all app stuff, not firmware"
 *   "if it has the private ecc key to sign the block, then i want the log"
 *   "the approve sheet should not be displayed automatically ... a banner at the top of edge
 *    tab to open it"; "we should hold these blocks in the app until approved and merged"
 *   a device gives "its own name for its device fingerprint in the block" - its NAMETAG;
 *   "find a way to fix multi names for the same device"; "so its not 'unknown'".
 *
 * A computer you approved for Bluetooth offers another device's log (lib sync OFFER): its
 * links up to its key's signed checkpoint and its owner statement. The phone HOLDS it here -
 * nothing merges, no sheet pops up. The Edge tab shows a banner; its sheet lists each held
 * device, sorted by the lib (devices.classify, with THIS key's owner key):
 *   mine-known  merged on Approve
 *   mine-new    "A device made with your OnlyKey appeared - is it yours?": Yes merges it and
 *               adds it to your devices; No raises the LEAK alarm (kept as evidence)
 *   forged      never merged; kept as evidence against the computer that sent it
 * Decline keeps a log out of your view but stored. The device's nametag comes from its own
 * signed statement - the highest seq wins, older ones stay as history - so there is one
 * name per fingerprint and never 'unknown'.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {devices as devicesLib} from 'node-onlykey-lib/edge';
import {fromHex, toHex} from 'node-onlykey-lib/bytes';
import NativeEdgeAlert from '../specs/NativeEdgeAlert';
import {keepMerged, loadMirror} from './edgeStore';
import type {EdgeLinkRecord} from './edgeFake';
import {edgeKey, netTag} from './net';

const DEVICES = (): string => edgeKey('devices');
const OWN = (): string => edgeKey('ownStatement');
const HELD = (): string => edgeKey('held');

/** A statement as stored (hex), and as the lib takes it (bytes). */
export type StoredStatement = {deviceId: string; publicKey: string; seq: number | null; nametag: string; signature: string; ownerKey?: string};
export type Statement = {deviceId: Uint8Array; publicKey: Uint8Array; seq: number | null; nametag: string; signature: Uint8Array};
/** One of your devices, as lib devices.remember keeps it. */
export type Device = {deviceId: string; publicKey: string; since: number; statements: {seq: number | null; nametag: string; signature: string}[]};
/** A log held for your approval. */
export type HeldLog = {
  deviceId: string;
  publicKey: string;
  from: string;
  at: number;
  records: [string, string, string | null][];
  checkpoint: {seq: number; head: string; signature: string};
  statement: StoredStatement;
  declined?: boolean;
  leak?: boolean;
};
/** What the Approve sheet shows for one held device. */
export type HeldView = {deviceId: string; nametag: string | null; claimed: string; class: 'mine-known' | 'mine-new' | 'forged'; count: number; from: string; at: number; checkOk: boolean; alarm: string | null; declined: boolean; leak: boolean};

const toStatement = (s: StoredStatement): Statement => ({deviceId: fromHex(s.deviceId), publicKey: fromHex(s.publicKey), seq: s.seq ?? null, nametag: s.nametag, signature: fromHex(s.signature)});
const store = (s: Statement & {ownerKey?: Uint8Array}): StoredStatement => ({
  deviceId: toHex(s.deviceId), publicKey: toHex(s.publicKey), seq: s.seq ?? null, nametag: s.nametag, signature: toHex(s.signature),
  ...(s.ownerKey ? {ownerKey: toHex(s.ownerKey)} : {}),
});

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------ this phone */

/** This phone's own latest statement (its nametag), or null before one is set. */
export async function ownStatement(): Promise<StoredStatement | null> {
  return readJson<StoredStatement | null>(OWN(), null);
}

/** This key's owner public key (X||Y), from its own statement - null before a nametag is set. */
export async function ownerKey(): Promise<Uint8Array | null> {
  const s = await ownStatement();
  return s?.ownerKey ? fromHex(s.ownerKey) : null;
}

/**
 * Set this phone's nametag: the key signs it with its owner key (no press, no link) and the
 * phone keeps that statement - it travels with this phone's log to your other devices.
 */
export async function setNametag(soft: {statement(nametag: string): Promise<any>}, nametag: string): Promise<StoredStatement> {
  const st = await soft.statement(nametag);
  const s = store(st);
  await AsyncStorage.setItem(OWN(), JSON.stringify(s));
  notify();
  return s;
}

/* ------------------------------------------------ your devices */

export async function loadDevices(): Promise<Device[]> {
  return readJson<Device[]>(DEVICES(), []);
}

/** A device's nametag now, and what it was called before (its own signed statements only). */
export async function nametagOf(d: Device): Promise<{nametag: string; previously: string[]} | null> {
  const owner = await ownerKey();
  if (!owner) return d.statements.length ? {nametag: d.statements[d.statements.length - 1].nametag, previously: []} : null;
  const r = devicesLib.nametagOf(devicesLib.statementsOf(d), owner);
  return r ? {nametag: r.nametag, previously: r.previously} : null;
}

/** Forget a device on this phone (its merged copy stays; a later log from it asks again). */
export async function forgetDevice(deviceId: string): Promise<void> {
  const list = (await loadDevices()).filter(d => d.deviceId !== deviceId.toLowerCase());
  await AsyncStorage.setItem(DEVICES(), JSON.stringify(list));
  notify();
}

/* ------------------------------------------------ held logs */

export async function loadHeld(): Promise<HeldLog[]> {
  return readJson<HeldLog[]>(HELD(), []);
}
async function saveHeld(list: HeldLog[]): Promise<void> {
  await AsyncStorage.setItem(HELD(), JSON.stringify(list));
  notify();
}

/**
 * A log offered by a computer: HELD, never merged here. A newer offer of the same device
 * replaces an older one; an older one never replaces a newer one. -> {held, count}
 */
export async function holdLog(o: {deviceId: Uint8Array; publicKey: Uint8Array; records: EdgeLinkRecord[]; checkpoint: {seq: number; head: Uint8Array; signature: Uint8Array}; statement: Statement; from: string}, now = Date.now()): Promise<{held: boolean; count: number}> {
  const id = toHex(o.deviceId);
  const list = await loadHeld();
  const was = list.find(h => h.deviceId === id);
  if (was && was.checkpoint.seq > o.checkpoint.seq) return {held: false, count: 0};
  const entry: HeldLog = {
    deviceId: id, publicKey: toHex(o.publicKey), from: o.from, at: now,
    records: o.records.map(r => [toHex(r.link), toHex(r.head), r.reveal ? toHex(r.reveal) : null]),
    checkpoint: {seq: o.checkpoint.seq, head: toHex(o.checkpoint.head), signature: toHex(o.checkpoint.signature)},
    statement: store(o.statement),
  };
  await saveHeld([...list.filter(h => h.deviceId !== id), entry]);
  return {held: true, count: entry.records.length};
}

const recordsOf = (h: HeldLog): EdgeLinkRecord[] => h.records.map(([l, hd, r]) => ({link: fromHex(l), head: fromHex(hd), reveal: r ? fromHex(r) : null}));
const logOf = (h: HeldLog) => ({
  deviceId: fromHex(h.deviceId), publicKey: fromHex(h.publicKey), records: recordsOf(h),
  checkpoint: {seq: h.checkpoint.seq, head: fromHex(h.checkpoint.head), signature: fromHex(h.checkpoint.signature)},
  statement: toStatement(h.statement),
});

/** The held logs as the sheet shows them, sorted by the lib with THIS key's owner key. */
export async function reviewHeld(): Promise<HeldView[]> {
  const owner = await ownerKey();
  const known = await loadDevices();
  const out: HeldView[] = [];
  for (const h of await loadHeld()) {
    const merged = ((await loadMirror(fromHex(h.deviceId))).merged ?? []).map(m => ({seq: m.seq, head: m.head}));
    const c = owner ? devicesLib.classify({log: logOf(h), ownerKey: owner, known, merged}) : {class: 'forged', nametag: null, check: {ok: false, alarm: 'no-nametag'}};
    out.push({
      deviceId: h.deviceId, nametag: c.nametag, claimed: h.statement.nametag, class: c.class as HeldView['class'], count: h.records.length, from: h.from, at: h.at,
      checkOk: !!c.check.ok, alarm: c.check.ok ? null : c.check.alarm ?? 'bad', declined: !!h.declined, leak: !!h.leak,
    });
  }
  return out;
}

/** How many held items still wait for an answer (the banner): device logs, and a Key Chain list. */
export async function waitingCount(): Promise<number> {
  return (await loadHeld()).filter(h => !h.declined && !h.leak).length + ((await heldKeychain()) ? 1 : 0);
}

/**
 * Approve a held device's log: merge it into this phone's view of that device and keep it
 * among your devices. A mine-new device needs \`isMine\` (the "is it yours?" answer); a
 * forged log, or one whose chain does not check, is never merged.
 */
export async function approveHeld(deviceId: string, {isMine = false}: {isMine?: boolean} = {}): Promise<{merged: number}> {
  const id = deviceId.toLowerCase();
  const list = await loadHeld();
  const h = list.find(x => x.deviceId === id);
  if (!h) throw new Error('nothing held for that device');
  const view = (await reviewHeld()).find(v => v.deviceId === id)!;
  if (view.class === 'forged') throw new Error('not made with your OnlyKey - it is kept as evidence, never merged');
  if (!view.checkOk) throw new Error(`its chain does not check (${view.alarm}) - kept, not merged`);
  if (view.class === 'mine-new' && !isMine) throw new Error('say whether this device is yours first');
  const log = logOf(h);
  await keepMerged(log.deviceId, log.publicKey, log.records, {seq: h.checkpoint.seq, head: log.checkpoint.head, signature: log.checkpoint.signature, at: Date.now()});
  const known = devicesLib.remember(await loadDevices(), log.statement);
  await AsyncStorage.setItem(DEVICES(), JSON.stringify(known));
  await saveHeld(list.filter(x => x.deviceId !== id));
  return {merged: log.records.length};
}

/** Decline: kept as evidence, out of your view. */
export async function declineHeld(deviceId: string): Promise<void> {
  const list = await loadHeld();
  await saveHeld(list.map(x => (x.deviceId === deviceId.toLowerCase() ? {...x, declined: true} : x)));
}

/**
 * "Is it yours?" - No: a device made with YOUR OnlyKey secret that you do not know. Someone
 * holds your secret (a leak): the red alarm, and the log kept as evidence.
 */
export async function notMine(deviceId: string): Promise<void> {
  const id = deviceId.toLowerCase();
  const list = await loadHeld();
  const h = list.find(x => x.deviceId === id);
  if (!h) return;
  await saveHeld(list.map(x => (x.deviceId === id ? {...x, leak: true} : x)));
  NativeEdgeAlert?.post(parseInt(id.slice(0, 6), 16), netTag() + 'Edge: someone else holds your OnlyKey',
    `A device made with your OnlyKey secret that is not yours ("${h.statement.nametag}", ${id.slice(0, 8)}…, from ${h.from}). Its log is kept as evidence.`, 'Edge alarm', false);
}

/* ------------------------------------------------ the Key Chain list a computer offered */

/*
 * Brad, 2026-10-08 ("Own links direct, Key Chain held"): a computer's public Key Chain list
 * that would CHANGE this phone's list waits in the same Approve sheet, as one row. Entries
 * only the computer lacks need no approval - the phone just gives them (TAKE), like GIVE.
 */
const HELD_KC = (): string => edgeKey('heldKeychain');
export type HeldKeychain = {from: string; at: number; merged: any[]; in: number; out: number};

export async function heldKeychain(): Promise<HeldKeychain | null> {
  return readJson<HeldKeychain | null>(HELD_KC(), null);
}
export async function holdKeychain(k: HeldKeychain): Promise<void> {
  await AsyncStorage.setItem(HELD_KC(), JSON.stringify(k));
  notify();
}
/** Approve: the merged list becomes this phone's (keyChainRecorder.keepMergedKeyChain does the keeping). */
export async function approveKeychain(keep: (merged: any[]) => Promise<void>): Promise<number> {
  const k = await heldKeychain();
  if (!k) return 0;
  await keep(k.merged);
  await AsyncStorage.removeItem(HELD_KC());
  notify();
  return k.in;
}
export async function declineKeychain(): Promise<void> {
  await AsyncStorage.removeItem(HELD_KC());
  notify();
}

/* ------------------------------------------------ change notices (the banner refreshes on them) */

type Listener = () => void;
const listeners = new Set<Listener>();
export function onDevicesChanged(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
function notify(): void {
  for (const l of [...listeners]) {
    try { l(); } catch { /* a listener's own problem */ }
  }
}
