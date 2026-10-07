/**
 * B7: which new links become phone notifications, and only once.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {chain, codes} from 'node-onlykey-lib/edge';
import NativeEdgeAlert from '../specs/NativeEdgeAlert';
import {alarmsAfter, raiseAlarms, raiseWatchAlarms} from '../src/edgeAlerts';
import type {EdgeRow, EdgeView, Mirror} from '../src/edgeStore';

const {OP, DECISION, FLAG} = codes;
const row = (seq: number, decision: number, flags: number, grantId = 0): EdgeRow => ({
  seq,
  fields: chain.decodeLink(chain.encodeLink({seq, op: OP.SIGN, decision, slot: 221, flags, subject: new Uint8Array(32), grantId, grantStep: grantId ? 1 : 0})),
  weld: '',
  verified: true,
});
/* newest first, as the store gives them */
const view = (rows: EdgeRow[]): EdgeView => ({verdict: {kind: 'verified', through: rows[0].seq}, headSeq: rows[0].seq, lastSync: 0, rows});
const rows = [
  row(14, DECISION.APPROVE, FLAG.STARTED | FLAG.OWES_TICKET | FLAG.PRESS_OBSERVED),
  row(13, DECISION.APPROVE, FLAG.OWES_TICKET | FLAG.PRESS_OBSERVED),
  row(12, DECISION.SELF_PRESS, FLAG.BUDGET_SPENT, 9),
  row(11, DECISION.APPROVE, FLAG.PRESS_OBSERVED),
];
const mirror = {deviceId: new Uint8Array([1, 2, 3])} as unknown as Mirror;

beforeEach(async () => {
  await AsyncStorage.clear();
  (NativeEdgeAlert!.post as jest.Mock).mockClear();
});

test('an old link mismatched TX start is an alarm; a press under a live budget is not any more (2026-10-06), nor a self-press or a plain press', () => {
  expect(alarmsAfter(view(rows), 10).map(a => [a.seq, a.title])).toEqual([[14, 'Edge: TX start did not match']]);
  expect(alarmsAfter(view(rows), 13).map(a => a.seq)).toEqual([14]);
});

test('the first sync on a phone only records where the chain is; later syncs post each alarm once', async () => {
  await raiseAlarms(mirror, view(rows.slice(2)));
  expect(NativeEdgeAlert!.post).not.toHaveBeenCalled();
  await raiseAlarms(mirror, view(rows));
  expect((NativeEdgeAlert!.post as jest.Mock).mock.calls.map(c => c[0])).toEqual([14]);
  await raiseAlarms(mirror, view(rows));
  expect(NativeEdgeAlert!.post).toHaveBeenCalledTimes(1);
});

test('the watcher: refused TX starts rising (once), a ticket owed over 10 min (once), a used-up budget (quiet, not on a first look)', async () => {
  const post = NativeEdgeAlert!.post as jest.Mock;
  const now = 1_000_000_000;
  const waiting: EdgeRow = {...rows[2], seenAt: now - 11 * 60 * 1000, ticket: {seq: 12, status: 'waiting'} as any};
  const v = view([rows[0], rows[1], waiting]);
  const past1 = [{grantId: 9, endedHow: 'used up', uses: 1, used: 1}];
  await raiseWatchAlarms(mirror, v, {refusedTx: 0, live: [], past: past1}, now);
  expect(post.mock.calls.map(c => c[1])).toEqual(['Edge: a ticket is owed too long']);
  await raiseWatchAlarms(mirror, v, {refusedTx: 2, live: [5], past: [...past1, {grantId: 20, endedHow: 'used up', uses: 3, used: 3}]}, now);
  expect(post.mock.calls.slice(1).map(c => [c[1], c[3], c[4]])).toEqual([
    ['Edge: the key refused a TX start', 'budget 5', false],
    ['Edge: budget 20 spent', 'budget 20', true],
  ]);
  post.mockClear();
  await raiseWatchAlarms(mirror, v, {refusedTx: 0, live: [5], past: past1}, now); /* a restart: the count starts again */
  await raiseWatchAlarms(mirror, v, {refusedTx: 0, live: [5], past: past1}, now);
  expect(post).not.toHaveBeenCalled();
});
