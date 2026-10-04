/**
 * B7: which new links become phone notifications, and only once.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {chain, codes} from 'node-onlykey-lib/edge';
import NativeEdgeAlert from '../specs/NativeEdgeAlert';
import {alarmsAfter, raiseAlarms} from '../src/edgeAlerts';
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
  row(14, DECISION.APPROVE, FLAG.ARMED | FLAG.OWES_TICKET | FLAG.PRESS_OBSERVED),
  row(13, DECISION.APPROVE, FLAG.OWES_TICKET | FLAG.PRESS_OBSERVED),
  row(12, DECISION.SELF_PRESS, FLAG.BUDGET_SPENT, 9),
  row(11, DECISION.APPROVE, FLAG.PRESS_OBSERVED),
];
const mirror = {deviceId: new Uint8Array([1, 2, 3])} as unknown as Mirror;

beforeEach(async () => {
  await AsyncStorage.clear();
  (NativeEdgeAlert!.post as jest.Mock).mockClear();
});

test('a mismatched ARM and a press under a live budget are alarms; a self-press and a plain press are not', () => {
  expect(alarmsAfter(view(rows), 10).map(a => [a.seq, a.title])).toEqual([
    [13, 'Edge: Press during a live budget'],
    [14, 'Edge: ARM did not match'],
  ]);
  expect(alarmsAfter(view(rows), 13).map(a => a.seq)).toEqual([14]);
});

test('the first sync on a phone only records where the chain is; later syncs post each alarm once', async () => {
  await raiseAlarms(mirror, view(rows.slice(2)));
  expect(NativeEdgeAlert!.post).not.toHaveBeenCalled();
  await raiseAlarms(mirror, view(rows));
  expect((NativeEdgeAlert!.post as jest.Mock).mock.calls.map(c => c[0])).toEqual([13, 14]);
  await raiseAlarms(mirror, view(rows));
  expect(NativeEdgeAlert!.post).toHaveBeenCalledTimes(2);
});
