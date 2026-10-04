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

export type EdgeAlarm = {seq: number; title: string; text: string};

/** The alarms among links newer than `after`, oldest first (pure: the tests use it). */
export function alarmsAfter(view: EdgeView, after: number): EdgeAlarm[] {
  const out: EdgeAlarm[] = [];
  for (const r of [...view.rows].reverse()) {
    const f = r.fields;
    const use = live.classifyUse(f);
    if (r.seq > after && use?.alarm) {
      const what = use.kind === live.KIND.MISMATCHED_ARM ? 'ARM did not match' : 'Press during a live budget';
      out.push({seq: r.seq, title: `Edge: ${what}`, text: `#${r.seq} ${f.op === OP.DECRYPT ? 'decrypt' : 'sign'} · slot ${f.slot} - ${use.alarm}.`});
    }
    /* an alarm ticket: news when the TICKET link is new, shown on the use it answers */
    const t = r.ticket;
    if (t?.status === 'alarm' && t.ticket && t.ticket.seq > after) {
      const name = t.ticket.name ?? `unknown code 0x${t.ticket.code.toString(16).padStart(2, '0')}`;
      out.push({seq: r.seq, title: `Edge: alarm ticket ${name}`, text: `The agent's ticket for #${r.seq} is an alarm (#${t.ticket.seq}). Open Edge to look, or hold the budget.`});
    }
    /* a ticket answering no use the copy holds, with an alarm code */
    if (f.op === OP.TICKET && f.code !== undefined && r.seq > after && !r.ticket) {
      const c = codes.ticketCode(f.code);
      if (c.alarm) out.push({seq: r.seq, title: `Edge: alarm ticket ${c.name ?? `0x${f.code.toString(16)}`}`, text: `Ticket #${r.seq} for #${f.refSeq} is an alarm.`});
    }
  }
  return out;
}

/** After a sync: post what is new, then remember how far this phone has looked. */
export async function raiseAlarms(mirror: Mirror, view: EdgeView): Promise<void> {
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
  for (const a of alarmsAfter(view, after)) NativeEdgeAlert?.post(a.seq, a.title, a.text);
  await AsyncStorage.setItem(key, String(newest));
}

/** The link whose alarm was tapped (once), or null. */
export function takeOpenedAlarm(): number | null {
  const s = NativeEdgeAlert ? NativeEdgeAlert.takeOpenedSeq() : -1;
  return s >= 0 ? s : null;
}
