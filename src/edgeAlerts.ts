/**
 * B7 "stands out without looking" (onlykey-edge build/okrn-edge-tab.md): after a
 * sync, each NEW link that is an alarm becomes a phone notification - an alarm receipt
 * (bit 7 or a code the v1 table does not know). (v1 links no ordinary press and no
 * mismatched TX start - the key refuses one - so those alarms went, 2026-10-08.) Tapping one opens the Edge tab on it.
 *
 * Once per link: the newest seq already looked at is kept per key. On a phone
 * that never ran this, the first sync only records where the chain is - old
 * history is not news.
 *
 * Stage 1 runs with the app in front (the tab's sync and the background copy
 * are foreground timers); a native watcher for the app in the background is
 * stage 2. Budgets used up or expired need the budget's size, which the copy
 * does not hold - also stage 2.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {codes} from 'node-onlykey-lib/edge';
import {toHex} from 'node-onlykey-lib/bytes';
import NativeEdgeAlert from '../specs/NativeEdgeAlert';
import type {EdgeView, Mirror} from './edgeStore';
import {edgeKey, netTag} from './net';

const KEY_PREFIX = (): string => edgeKey('alerted.');
const {OP} = codes;

export type EdgeAlarm = {seq: number; title: string; text: string; budget?: number};

/** The alarms among links newer than `after`, oldest first (pure: the tests use it). */
export function alarmsAfter(view: EdgeView, after: number): EdgeAlarm[] {
  const out: EdgeAlarm[] = [];
  for (const r of [...view.rows].reverse()) {
    const f = r.fields;
    /* an alarm receipt: news when the RECEIPT link is new, shown on the use it answers */
    const t = r.receipt;
    if (t?.status === 'alarm' && t.receipt && t.receipt.seq > after) {
      const name = t.receipt.name ?? `unknown code 0x${t.receipt.code.toString(16).padStart(2, '0')}`;
      out.push({seq: r.seq, title: `Edge: alarm receipt ${name}`, text: `The agent's receipt for #${r.seq} is an alarm (#${t.receipt.seq}). Open Edge to look, or hold the budget.`, budget: f.grantId || undefined});
    }
    /* a receipt answering no use the copy holds, with an alarm code */
    /* a WAIVE (code 0x8F + the press flag, receipts.js) is your press, not an agent's alarm receipt */
    const isWaive = f.op === OP.RECEIPT && f.code === 0x8f && (f.flags & codes.FLAG.PRESS_OBSERVED) !== 0;
    if (f.op === OP.RECEIPT && f.code !== undefined && !isWaive && r.seq > after && !r.receipt) {
      const c = codes.receiptCode(f.code);
      if (c.alarm) out.push({seq: r.seq, title: `Edge: alarm receipt ${c.name ?? `0x${f.code.toString(16)}`}`, text: `Receipt #${r.seq} for #${f.refSeq} is an alarm.`});
    }
  }
  return out;
}

/** After a sync: post what is new, then remember how far this phone has looked. */
export async function raiseAlarms(mirror: Mirror, view: EdgeView, live: number[] = []): Promise<void> {
  if (!view.rows.length) return;
  const key = KEY_PREFIX() + toHex(mirror.deviceId);
  const newest = view.rows[0].seq;
  const kept = await AsyncStorage.getItem(key);
  if (kept === null) {
    await AsyncStorage.setItem(key, String(newest));
    return;
  }
  const after = Number(kept);
  if (!(newest > after)) return;
  for (const a of alarmsAfter(view, after)) NativeEdgeAlert?.post(a.seq, netTag() + a.title, a.text, lockText(a.budget, live), false);
  await AsyncStorage.setItem(key, String(newest));
}

/* Part T: a tapped Bluetooth alarm comes back as takeOpenedSeq() >= this (NativeEdgeAlertModule BT_SEQ_BASE) */
export const BT_SEQ_BASE = 1_000_000_000;

/** Part T: post a Bluetooth pairing alarm (no-op on an APK without the module). */
export function postBluetoothAlarm(id: number, text: string): void {
  NativeEdgeAlert?.postBluetooth?.(id, text);
}

/** The link whose alarm was tapped (once), or null. */
export function takeOpenedAlarm(): number | null {
  const s = NativeEdgeAlert ? NativeEdgeAlert.takeOpenedSeq() : -1;
  return s >= 0 ? s : null;
}

/* the lock screen: "Edge alarm" plus the budget, nothing else (spec 2026-10-04) */
function lockText(budget: number | undefined, live: number[]): string {
  if (budget) return `budget ${budget}`;
  return live.length ? `budget ${live.join(', ')}` : 'no budget live';
}

/*
 * ---------------------------------------------------------------- the watcher
 * B7 stage 2, option A (spec 2026-10-04): the background copy keeps running
 * with the app out of sight; after each sync it also checks the key's own state.
 * Red: the refused-TX start count rising (HEAD byte 60), a receipt owed past 10
 * minutes. Quiet: a budget used up or expired ("expect a continue request").
 */
const OWED_RED_MS = 10 * 60 * 1000;
/* the stored name keeps the old word: renaming it would make every phone forget the count it last saw and alert once for old refusals */
const TX_REFUSED_KEY = (): string => edgeKey('refusedArms.');
const OWED_KEY = (): string => edgeKey('owedAlerted.');
const ENDED_KEY = (): string => edgeKey('endedNoticed.');

export type WatchState = {refusedTx?: number; live: number[]; past: {grantId: number; endedHow?: string; uses: number; used: number}[]};

export async function raiseWatchAlarms(mirror: Mirror, view: EdgeView, st: WatchState, now = Date.now()): Promise<void> {
  const dev = toHex(mirror.deviceId);
  /* the key's refused TX starts since it started: a rise is news; a drop is a restart (a new count) */
  const refused = st.refusedTx ?? 0;
  const lastRefused = Number((await AsyncStorage.getItem(TX_REFUSED_KEY() + dev)) ?? '0');
  if (refused > lastRefused) {
    NativeEdgeAlert?.post(view.rows[0]?.seq ?? 0, netTag() + 'Edge: the key refused a TX start',
      `The key refused ${refused - lastRefused} TX start${refused - lastRefused === 1 ? '' : 's'} (${refused} since it started). A refused TX start writes no link - if you did not expect it, hold the budget.`,
      lockText(undefined, st.live), false);
  }
  if (refused !== lastRefused) await AsyncStorage.setItem(TX_REFUSED_KEY() + dev, String(refused));

  /* a receipt owed past 10 minutes: once per use */
  const owedDone: number[] = JSON.parse((await AsyncStorage.getItem(OWED_KEY() + dev)) ?? '[]');
  const owedNew = view.rows.filter(r => r.receipt?.status === 'waiting' && r.seenAt && now - r.seenAt > OWED_RED_MS && !owedDone.includes(r.seq));
  for (const r of owedNew) {
    NativeEdgeAlert?.post(r.seq, netTag() + 'Edge: a receipt is owed too long',
      `#${r.seq} has waited over 10 minutes for its receipt. Nothing automatic happens until it is receipted or waived.`,
      lockText(r.fields.grantId || undefined, st.live), false);
  }
  if (owedNew.length) await AsyncStorage.setItem(OWED_KEY() + dev, JSON.stringify([...owedDone, ...owedNew.map(r => r.seq)].slice(-100)));

  /* used up / expired: quiet, once per budget; the first look on a phone only records */
  const ended = st.past.filter(b => b.endedHow === 'used up' || b.endedHow === 'expired');
  const keptEnded = await AsyncStorage.getItem(ENDED_KEY() + dev);
  const endedDone: number[] = keptEnded === null ? ended.map(b => b.grantId) : JSON.parse(keptEnded);
  for (const b of ended.filter(x => !endedDone.includes(x.grantId))) {
    NativeEdgeAlert?.post(b.grantId, netTag() + `Edge: budget ${b.grantId} ${b.endedHow === 'expired' ? 'expired' : 'spent'}`,
      b.endedHow === 'expired'
        ? `Budget ${b.grantId} expired with ${Math.max(0, b.uses - b.used)} of ${b.uses} uses left: expect a continue request.`
        : `Budget ${b.grantId} used all ${b.uses} uses: expect a continue request.`,
      `budget ${b.grantId}`, true);
  }
  if (keptEnded === null || ended.some(x => !endedDone.includes(x.grantId))) {
    await AsyncStorage.setItem(ENDED_KEY() + dev, JSON.stringify([...new Set([...endedDone, ...ended.map(b => b.grantId)])].slice(-100)));
  }
}

/* the heartbeat (native watchdog: 30 s without one while watching -> "Edge watching stopped") */
export function watching(on: boolean): void {
  NativeEdgeAlert?.setWatching(on);
}
export function beat(): void {
  NativeEdgeAlert?.beat();
}

/* Hold from a notification: now (JS running) or once the app is up (takeHoldRequest) */
export function onHoldRequested(fn: () => void): () => void {
  const sub = NativeEdgeAlert?.onHoldRequested(fn);
  return () => sub?.remove();
}
/* the native clock for the watcher: JS timers stop in the background, native events still arrive */
export function onWatchTick(fn: () => void): () => void {
  const sub = NativeEdgeAlert?.onWatchTick?.(fn);
  return () => sub?.remove();
}
export function takeHoldRequest(): boolean {
  return NativeEdgeAlert ? NativeEdgeAlert.takeHoldRequest() : false;
}
