/*
 * R30 (spec, 2026-10-05): the STOPPED-ANCHORING alarm. A paired key that has
 * not synced with this one - no anchor written here for it - for 24 hours (a
 * setting) raises an Edge alarm on this phone, with a reminder at 20 hours
 * (4 h before, whatever the setting). A key that goes quiet could be hiding
 * uses; the anchors are what would prove it, so their absence is news.
 *
 * NO AUTOMATIC SYNC (spec): anchors are written only inside a sync the person
 * approves with a press; this only tells them it is due.
 *
 * The clock for each paired key starts at the later of: the last anchor this
 * key wrote for it (its copy's anchors), and when it was paired here. A key
 * this phone has never seen anchored or paired starts its clock the first time
 * the watcher looks. Each stage is posted once per clock start.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {fromHex} from 'node-onlykey-lib/bytes';
import {loadMirror} from './edgeStore';
import {siblingNames} from './edgeSiblingNames';
import NativeEdgeAlert from '../specs/NativeEdgeAlert';

const HOURS_KEY = 'okrn.edge.siblingAlarmHours';
const SINCE_KEY = 'okrn.edge.siblingSince';
const POSTED_KEY = 'okrn.edge.siblingAlarmed';
export const ALARM_HOURS = [12, 24, 48, 72] as const;
export const DEFAULT_ALARM_HOURS = 24;
const HOUR = 3600_000;
/* the notification id range for these (apart from links and Bluetooth alarms) */
const SEQ_BASE = 1_200_000_000;

export async function alarmHours(): Promise<number> {
  const h = Number(await AsyncStorage.getItem(HOURS_KEY).catch(() => null));
  return (ALARM_HOURS as readonly number[]).includes(h) ? h : DEFAULT_ALARM_HOURS;
}
export async function setAlarmHours(h: number): Promise<void> {
  if ((ALARM_HOURS as readonly number[]).includes(h)) await AsyncStorage.setItem(HOURS_KEY, String(h));
}

/** A pairing completed here: its clock starts now (called by the sibling sheet's handler). */
export async function markPaired(key: string, now = Date.now()): Promise<void> {
  const all = JSON.parse((await AsyncStorage.getItem(SINCE_KEY)) ?? '{}');
  all[key.toLowerCase()] = now;
  await AsyncStorage.setItem(SINCE_KEY, JSON.stringify(all));
}

/** The reminder comes 4 h before the alarm (20 h of 24), never before half the time. */
export function reminderHours(hours: number): number {
  return Math.max(hours / 2, hours - 4);
}

/** 0 quiet · 1 reminder · 2 alarm, for a key last synced `ageMs` ago. Pure: tested. */
export function stageOf(ageMs: number, hours: number): 0 | 1 | 2 {
  if (ageMs >= hours * HOUR) return 2;
  if (ageMs >= reminderHours(hours) * HOUR) return 1;
  return 0;
}

/** When this phone last anchored the paired key (its copy's newest anchor), or null. */
export async function lastAnchoredAt(deviceId: string): Promise<number | null> {
  const m = await loadMirror(fromHex(deviceId));
  const at = (m.anchors ?? []).map(a => a.at).filter(Boolean);
  return at.length ? Math.max(...at) : null;
}

const ago = (ms: number) => (ms < HOUR ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.floor(ms / HOUR)} h`);
const idOf = (key: string) => SEQ_BASE + (parseInt(key.slice(0, 6), 16) % 1_000_000);

/**
 * The watcher's check (useEdgeBackgroundSync), for the keys this key is paired
 * with: posts the reminder, then the alarm, once each per clock start.
 */
export async function raiseSiblingAlarms(siblings: {key: string; deviceId: string}[], now = Date.now()): Promise<void> {
  if (!siblings.length || !NativeEdgeAlert) return;
  const hours = await alarmHours();
  const names = await siblingNames();
  const since: Record<string, number> = JSON.parse((await AsyncStorage.getItem(SINCE_KEY)) ?? '{}');
  const posted: Record<string, {from: number; stage: number}> = JSON.parse((await AsyncStorage.getItem(POSTED_KEY)) ?? '{}');
  let changed = false;
  for (const s of siblings) {
    const key = s.key.toLowerCase();
    const anchored = await lastAnchoredAt(s.deviceId).catch(() => null);
    let from = Math.max(anchored ?? 0, since[key] ?? 0);
    if (!from) {
      since[key] = now; /* never seen anchored or paired here: the clock starts at this first look */
      changed = true;
      continue;
    }
    const stage = stageOf(now - from, hours);
    const done = posted[key]?.from === from ? posted[key].stage : 0;
    if (stage <= done) continue;
    const name = names[key] ?? `the key ${key.slice(0, 8)}…`;
    const when = new Date(from).toLocaleString([], {weekday: 'short', hour: 'numeric', minute: '2-digit'});
    if (stage === 2) {
      NativeEdgeAlert.post(idOf(key), `Edge: ${name} has not synced for ${hours} h`,
        `This key last anchored ${name} ${ago(now - from)} ago (${when}). A key that stops syncing could be hiding uses - sync them now (okedge sync --with), or find out why.`,
        'Edge alarm · a paired key went quiet', false);
    } else {
      NativeEdgeAlert.post(idOf(key), `Edge: sync with ${name} soon`,
        `This key last anchored ${name} ${ago(now - from)} ago (${when}). At ${hours} h it becomes an alarm. Nothing syncs on its own: run okedge sync --with, then Anchor on both phones.`,
        'Edge · a sync is due', true);
    }
    posted[key] = {from, stage};
    changed = true;
  }
  if (changed) {
    await AsyncStorage.setItem(SINCE_KEY, JSON.stringify(since));
    await AsyncStorage.setItem(POSTED_KEY, JSON.stringify(posted));
  }
}
