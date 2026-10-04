/**
 * Edge tab data layer, with no key: the fake key's chain is synced into the
 * phone's mirror and verified by the library (spec okrn-edge-tab.md phase 2).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {FakeEdgeKey} from '../src/edgeFake';
import {evaluate, loadMirror, saveMirror, sync, tamper} from '../src/edgeStore';

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
    [15, 'alarm', null], // 0x42: not a v1 code - fails closed
    [13, 'alarm', 'SUSPECTED_INJECTION'],
    [12, 'no-ticket-owed', null], // denied
    [11, 'waiting', null], // unpaid, and still on the key's list of 4 (the list does not refill, lib tickets.keyDebts)
    [9, 'ticketed', 'OK'],
    [7, 'ticketed', 'OK'],
    [5, 'ticketed', 'OK_UNCONFIRMED'],
    [3, 'ticketed', 'OK'],
  ]);
  expect(view.rows.find(r => r.seq === 3)!.ticket!.message).toMatch(/push was accepted/);
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
  /* the key still holds its last four: the first of them is its own word, not part of the gap (spec 4.3) */
  expect(view.verdict).toMatchObject({kind: 'gap', from: 0, to: head.seq - 4});
});

test('a key whose head went back since the last verified sync is a rollback', async () => {
  const k = FakeEdgeKey.demo();
  await sync(k);
  const older = new FakeEdgeKey(); // same device id, shorter history
  older.use('commit 1');
  expect((await sync(older)).view.verdict).toMatchObject({kind: 'tampered', reason: 'rollback'});
});

test('three budgets are live at once, each spending its own steps', async () => {
  const k = FakeEdgeKey.demo();
  const live = await k.budgets();
  expect(live.map(b => [b.reason, b.used, b.uses])).toEqual([
    ['Sign release commits for ok-rn 0.0.6', 3, 3],
    ['Decrypt the CI deploy secrets', 1, 5],
    ['Publish the docs site', 2, 4],
  ]);
  expect(JSON.stringify(live)).not.toMatch(/seed/); // the key never gives a seed out
  k.revoke(live[1].grantId);
  expect((await k.budgets()).map(b => b.grantId)).toEqual([live[0].grantId, live[2].grantId]);
  k.lock();
  expect(await k.budgets()).toEqual([]);
  expect((await sync(k)).view.verdict.kind).toBe('verified');
});

test('never synced: not-synced, and nothing claimed', async () => {
  const k = FakeEdgeKey.demo();
  expect(evaluate(await loadMirror(k.deviceId), null).verdict).toEqual({kind: 'not-synced'});
});

/*
 * The A13 (2026-10-04): a signature meant for a computer on the Bluetooth bridge
 * was stored as link #447194052. Above the key's head it read as a rollback, and
 * Sync - starting past it - read nothing. The next sync sets it aside and catches up.
 */
test('a stored record that is not a link, past the key\'s head, is set aside and the copy catches up', async () => {
  const k = new FakeEdgeKey();
  k.use('commit 1');
  k.use('commit 2');
  await sync(k);
  const m = await loadMirror(k.deviceId);
  const junk = Uint8Array.from({length: 64}, (_, i) => (i * 37 + 11) & 0xff); /* seq far past the head, bytes 47-63 not zero */
  m.links.push({link: junk, head: new Uint8Array(32).fill(7), reveal: null});
  await saveMirror(m);
  expect((await verifyOnly(k)).verdict).toMatchObject({kind: 'tampered', reason: 'rollback'});
  k.use('commit 3');
  const {view, mirror} = await sync(k);
  const head = await k.head();
  expect(view.verdict).toEqual({kind: 'verified', through: head.seq});
  expect(mirror.links).toHaveLength(head.seq + 1);
  expect(mirror.setAside).toHaveLength(1);
  expect(mirror.setAside[0].link).toEqual(junk);
  expect((await loadMirror(k.deviceId)).setAside).toHaveLength(1);
});

test('real links past the key\'s head are not set aside: the copy still reads as a rollback', async () => {
  const k = FakeEdgeKey.demo();
  await sync(k);
  const m = await loadMirror(k.deviceId);
  m.lastSeen = null; /* the copy alone says it is ahead, not a remembered head */
  await saveMirror(m);
  const older = new FakeEdgeKey();
  older.use('commit 1');
  const {view, mirror} = await sync(older);
  expect(view.verdict).toMatchObject({kind: 'tampered', reason: 'rollback'});
  expect(mirror.setAside).toHaveLength(0);
});

/*
 * The A13's exact record, decoded from its storage: a PICKUP read one report out
 * of step, so a head report (32 bytes, then 32 zeros - reserved bytes zero) was
 * stored as a link, with the next real link's first 32 bytes as its head.
 */
test('a head report stored as a link (reserved bytes zero, seq jump) is set aside, and the copy catches up', async () => {
  const k = new FakeEdgeKey();
  k.use('commit 1');
  k.use('commit 2');
  await sync(k);
  const m = await loadMirror(k.deviceId);
  const nextLink = (await k.read(0, 1))[0].link;
  const junk = new Uint8Array(64);
  junk.set([0xc4, 0xa3, 0xa7, 0x1a, 0x4e, 0x2d, 0x7f, 0xc8], 0); /* seq 447194052, op 78 */
  m.links.push({link: junk, head: nextLink.slice(0, 32), reveal: nextLink.slice(32, 64)});
  await saveMirror(m);
  expect((await verifyOnly(k)).verdict).toMatchObject({kind: 'tampered', reason: 'rollback'});
  k.use('commit 3');
  const {view, mirror} = await sync(k);
  const head = await k.head();
  expect(view.verdict).toEqual({kind: 'verified', through: head.seq});
  expect(mirror.setAside.map(x => x.link)).toEqual([junk]);
  expect(view.setAside).toEqual([{seq: 447194052, at: expect.any(Number)}]);
});
