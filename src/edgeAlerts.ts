/**
 * B7 "stands out without looking" (onlykey-edge build/okrn-edge-tab.md): after a
 * sync, each NEW link that is an alarm becomes a phone notification - an ARM that
 * did not match its request, a press asked for under a live budget (lib
 * live.classifyUse, the same answer okedge watch gives), an alarm ticket (bit 7
 * or a code the v1 table does not know). Tapping one opens the Edge tab on it.
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
import {codes, live} from 'node-onlykey-lib/edge';
import {toHex} from 'node-onlykey-lib/bytes';
import NativeEdgeAlert from '../specs/NativeEdgeAlert';
import type {EdgeView, Mirror} from './edgeStore';

const KEY_PREFIX = 'okrn.edge.alerted.';
const {OP} = codes;

export type EdgeAlarm = {seq: number; title: string; text: string; budget?: number};

/** The alarms among links newer than `after`, oldest first (pure: the tests use it). */
export function alarmsAfter(view: EdgeView, after: number): EdgeAlarm[] {
  const out: EdgeAlarm[] = [];
  for (const r of [...view.rows].reverse()) {
    const f = r.fields;
    const use = live.classifyUse(f);
    if (r.seq > after && use?.alarm) {
      const what = use.kind === live.KIND.MISMATCHED_ARM ? 'ARM did not match' : 'Press during a live budget';
      out.push({seq: r.seq, title: `Edge: ${what}`, text: `#${r.seq} ${f.op === OP.DECRYPT ? 'decrypt' : 'sign'} · slot ${f.slot} - ${use.alarm}.`, budget: f.grantId || undefined});
    }
    /* an alarm ticket: news when the TICKET link is new, shown on the use it answers */
    const t = r.ticket;
    if (t?.status === 'alarm' && t.ticket && t.ticket.seq > after) {
      const name = t.ticket.name ?? `unknown code 0x${t.ticket.code.toString(16).padStart(2, '0')}`;
      out.push({seq: r.seq, title: `Edge: alarm ticket ${name}`, text: `The agent's ticket for #${r.seq} is an alarm (#${t.ticket.seq}). Open Edge to look, or hold the budget.`, budget: f.grantId || undefined});
    }
    /* a ticket answering no use the copy holds, with an alarm code */
    /* a WAIVE (code 0x8F + the press flag, tickets.js) is your press, not an agent's alarm ticket */
    const isWaive = f.op === OP.TICKET && f.code === 0x8f && (f.flags & codes.FLAG.PRESS_OBSERVED) !== 0;
    if (f.op === OP.TICKET && f.code !== undefined && !isWaive && r.seq > after && !r.ticket) {
      const c = codes.ticketCode(f.code);
      if (c.alarm) out.push({seq: r.seq, title: `Edge: alarm ticket ${c.name ?? `0x${f.code.toString(16)}`}`, text: `Ticket #${r.seq} for #${f.refSeq} is an alarm.`});
    }
  }
  return out;
}

/** After a sync: post what is new, then remember how far this phone has looked. */
export async function raiseAlarms(mirror: Mirror, view: EdgeView, live: number[] = []): Promise<void> {
  if (!view.rows.length) return;
  const key = KEY_PREFIX + toHex(mirror.deviceId);
  const newest = view.rows[0].seq;
  const kept = await AsyncStorage.getItem(key);
  if (kept === null) {
    await AsyncStorage.setItem(key, String(newest));
    return;
  }
  const after = Number(kept);
  if (!(newest > after)) return;
  for (const a of alarmsAfter(view, after)) NativeEdgeAlert?.post(a.seq, a.title, a.text, lockText(a.budget, live), false);
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
 * Red: the refused-ARM count rising (HEAD byte 60), a ticket owed past 10
 * minutes. Quiet: a budget used up or expired ("expect a continue request").
 */
const OWED_RED_MS = 10 * 60 * 1000;
const ARMS_KEY = 'okrn.edge.refusedArms.';
const OWED_KEY = 'okrn.edge.owedAlerted.';
const ENDED_KEY = 'okrn.edge.endedNoticed.';

export type WatchState = {refusedArms?: number; live: number[]; past: {grantId: number; endedHow?: string; uses: number; used: number}[]};

export async function raiseWatchAlarms(mirror: Mirror, view: EdgeView, st: WatchState, now = Date.now()): Promise<void> {
  const dev = toHex(mirror.deviceId);
  /* the key's refused ARMs since it started: a rise is news; a drop is a restart (a new count) */
  const arms = st.refusedArms ?? 0;
  const lastArms = Number((await AsyncStorage.getItem(ARMS_KEY + dev)) ?? '0');
  if (arms > lastArms) {
    NativeEdgeAlert?.post(view.rows[0]?.seq ?? 0, 'Edge: the key refused an ARM',
      `The key refused ${arms - lastArms} ARM${arms - lastArms === 1 ? '' : 's'} (${arms} since it started). A refused ARM writes no link - if you did not expect it, hold the budget.`,
      lockText(undefined, st.live), false);
  }
  if (arms !== lastArms) await AsyncStorage.setItem(ARMS_KEY + dev, String(arms));

  /* a ticket owed past 10 minutes: once per use */
  const owedDone: number[] = JSON.parse((await AsyncStorage.getItem(OWED_KEY + dev)) ?? '[]');
  const owedNew = view.rows.filter(r => r.ticket?.status === 'waiting' && r.seenAt && now - r.seenAt > OWED_RED_MS && !owedDone.includes(r.seq));
  for (const r of owedNew) {
    NativeEdgeAlert?.post(r.seq, 'Edge: a ticket is owed too long',
      `#${r.seq} has waited over 10 minutes for its ticket. Nothing automatic happens until it is ticketed or waived.`,
      lockText(r.fields.grantId || undefined, st.live), false);
  }
  if (owedNew.length) await AsyncStorage.setItem(OWED_KEY + dev, JSON.stringify([...owedDone, ...owedNew.map(r => r.seq)].slice(-100)));

  /* used up / expired: quiet, once per budget; the first look on a phone only records */
  const ended = st.past.filter(b => b.endedHow === 'used up' || b.endedHow === 'expired');
  const keptEnded = await AsyncStorage.getItem(ENDED_KEY + dev);
  const endedDone: number[] = keptEnded === null ? ended.map(b => b.grantId) : JSON.parse(keptEnded);
  for (const b of ended.filter(x => !endedDone.includes(x.grantId))) {
    NativeEdgeAlert?.post(b.grantId, `Edge: budget ${b.grantId} ${b.endedHow === 'expired' ? 'expired' : 'spent'}`,
      b.endedHow === 'expired'
        ? `Budget ${b.grantId} expired with ${Math.max(0, b.uses - b.used)} of ${b.uses} uses left: expect a continue request.`
        : `Budget ${b.grantId} used all ${b.uses} uses: expect a continue request.`,
      `budget ${b.grantId}`, true);
  }
  if (keptEnded === null || ended.some(x => !endedDone.includes(x.grantId))) {
    await AsyncStorage.setItem(ENDED_KEY + dev, JSON.stringify([...new Set([...endedDone, ...ended.map(b => b.grantId)])].slice(-100)));
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
