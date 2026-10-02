/**
 * Edge tab data layer, with no key: the fake key's chain is synced into the
 * phone's mirror and verified by the library (spec okrn-edge-tab.md phase 2).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {FakeEdgeKey} from '../src/edgeFake';
import {evaluate, loadMirror, sync, tamper} from '../src/edgeStore';

beforeEach(async () => {
  await AsyncStorage.clear();
});

const verifyOnly = async (k: FakeEdgeKey) => evaluate(await loadMirror(k.deviceId), await k.head());

test('a first sync stores every link and verifies through the key\'s head', async () => {
  const k = FakeEdgeKey.demo();
  const {view, mirror} = await sync(k, 1000);
  const head = await k.head();
  expect(view.verdict).toEqual({kind: 'verified', through: head.seq});
  expect(mirror.links).toHaveLength(head.seq + 1);
  expect(mirror.lastSeen?.seq).toBe(head.seq);
  expect(view.lastSync).toBe(1000);
});

test('the chain rows carry every ticket state the tab draws', async () => {
  const {view} = await sync(FakeEdgeKey.demo());
  const uses = view.rows.filter(r => r.ticket).map(r => [r.seq, r.ticket!.status, r.ticket!.ticket?.name ?? null]);
  expect(uses).toEqual([
    [9, 'alarm', null], // 0x42: not a v1 code - fails closed
    [7, 'alarm', 'SUSPECTED_INJECTION'],
    [6, 'no-ticket-owed', null], // denied
    [5, 'missing', null], // the empty hook
    [3, 'ticketed', 'OK_UNCONFIRMED'],
    [1, 'ticketed', 'OK'],
  ]);
  expect(view.rows.find(r => r.seq === 1)!.ticket!.message).toMatch(/push was accepted/);
});

test('a later sync reads only the new links and still verifies', async () => {
  const k = FakeEdgeKey.demo();
  await sync(k);
  k.use('commit 999');
  k.ticket(0x00, 'done');
  const {view, mirror} = await sync(k);
  expect(view.verdict).toEqual({kind: 'verified', through: (await k.head()).seq});
  expect(mirror.links).toHaveLength((await k.head()).seq + 1);
});

test('tampering with the phone\'s copy turns the verdict red, with the reason', async () => {
  const k = FakeEdgeKey.demo();
  await sync(k);
  await tamper(k.deviceId, 'flip');
  expect((await verifyOnly(k)).verdict).toMatchObject({kind: 'tampered', reason: 'hash-mismatch'});

  await sync(FakeEdgeKey.demo()); // same device id: a fresh, true copy
  await tamper(k.deviceId, 'swap');
  expect((await verifyOnly(k)).verdict).toMatchObject({kind: 'tampered', reason: 'seq-reorder'});
});

test('links cut from the copy that the key still holds: red on Verify, healed by Sync', async () => {
  const k = FakeEdgeKey.demo();
  await sync(k);
  await tamper(k.deviceId, 'truncate');
  expect((await verifyOnly(k)).verdict).toMatchObject({kind: 'tampered', reason: 'seq-gap'});
  expect((await sync(k)).view.verdict.kind).toBe('verified');
});

test('links already gone from the key\'s ring are an amber gap, not tampering', async () => {
  const k = FakeEdgeKey.demo();
  k.ring = 4; // the key keeps only its last four links
  const {view} = await sync(k);
  const head = await k.head();
  expect(view.verdict).toMatchObject({kind: 'gap', from: 0, to: head.seq - 4 + 1});
});

test('a key whose head went back since the last verified sync is a rollback', async () => {
  const k = FakeEdgeKey.demo();
  await sync(k);
  const older = new FakeEdgeKey(); // same device id, shorter history
  older.use('commit 1');
  expect((await sync(older)).view.verdict).toMatchObject({kind: 'tampered', reason: 'rollback'});
});

test('never synced: not-synced, and nothing claimed', async () => {
  const k = FakeEdgeKey.demo();
  expect(evaluate(await loadMirror(k.deviceId), null).verdict).toEqual({kind: 'not-synced'});
});
