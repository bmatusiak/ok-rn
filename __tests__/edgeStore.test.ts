/**
 * Edge tab data layer, with no key: the fake key's chain is synced into the
 * phone's mirror and verified by the library (spec okrn-edge-tab.md phase 2).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {FakeEdgeKey} from '../src/edgeFake';
import {addNote, evaluate, forgetVerified, keepOffered, lastCheckPath, loadMirror, saveMirror, sync, tamper} from '../src/edgeStore';

beforeEach(async () => {
  await AsyncStorage.clear();
  forgetVerified(); /* as a restart: nothing verified carries over */
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

/*
 * B7 stage 2: EDGE_NOTE reaches the copy. The soft key gives no ticket messages
 * (they never reach the key): the agent's note does, and it shows only when it
 * hashes to the ticket. A reason is kept on its seq.
 */
test('a note\'s reason lands on its row; its ticket message shows only when it hashes to the ticket', async () => {
  const k = new FakeEdgeKey();
  const seq = k.use('commit 1');
  k.ticket(0x00, 'pushed ok-rn');
  k.messages = async () => ({}); /* as the soft key: no messages from the key */
  await sync(k);
  await addNote(k.deviceId, {agent: 'AB'.repeat(32), seq, reason: 'git push origin master'});
  await addNote(k.deviceId, {agent: 'ab'.repeat(32), seq: 999, txRefused: 'ticket_owed'});
  let {view} = await sync(k);
  let row = view.rows.find(r => r.seq === seq)!;
  expect(row.note).toMatchObject({agent: 'ab'.repeat(32), text: 'git push origin master'});
  expect(row.ticket?.messageStatus).toBe('none');
  expect(view.refusals).toMatchObject([{seq: 999, status: 'ticket_owed'}]);
  await addNote(k.deviceId, {agent: 'ab'.repeat(32), seq, ticketMsg: 'not what was ticketed'});
  row = (await sync(k)).view.rows.find(r => r.seq === seq)!;
  expect(row.ticket?.messageStatus).toBe('mismatch');
  await addNote(k.deviceId, {agent: 'ab'.repeat(32), seq, ticketMsg: 'pushed ok-rn'});
  row = (await sync(k)).view.rows.find(r => r.seq === seq)!;
  expect(row.ticket).toMatchObject({messageStatus: 'match', message: 'pushed ok-rn'});
});

/*
 * okedge sync phase 2, found on the Pixel (2026-10-05): links a place offered and
 * the person approved were saved OUTSIDE the sync queue; the background copy sync,
 * which had loaded the copy while the sheet was up, saved it afterwards and the
 * approved links were gone. Kept through the queue, they survive a sync that is
 * already running.
 */
test('links kept from a sync offer survive a copy sync already running (one queue)', async () => {
  const k = new FakeEdgeKey();
  k.use('commit 1');
  k.use('commit 2');
  k.use('commit 3');
  await sync(k);
  const full = await loadMirror(k.deviceId);
  const offered = full.links.slice(1, 3);
  /* this phone's copy lost #1-#2; the key's ring holds only its newest, so a sync cannot refill them */
  await saveMirror({...full, links: [full.links[0], ...full.links.slice(3)]});
  let release: () => void = () => {};
  const gate = new Promise<void>(r => { release = r; });
  const slow: any = Object.create(k);
  slow.head = async () => { await gate; const h = await k.head(); return {...h, ringFrom: h.seq}; };
  const running = sync(slow);
  const kept = keepOffered(k.deviceId, offered);
  release();
  await Promise.all([running, kept]);
  const seqs = (await loadMirror(k.deviceId)).links.map(r => r.link[0] | (r.link[1] << 8));
  expect(seqs).toEqual(full.links.map(r => r.link[0] | (r.link[1] << 8)));
});

/*
 * WHAT THIS SESSION VERIFIED STAYS IN MEMORY (Brad, 2026-10-05): a pull-down with
 * nothing new does no check; new links are checked from the verified head; an
 * edit to the stored copy under the same head is a full check, and red; a
 * restart checks in full.
 */
test('verification: start is full, a pull-down with no change skips, new links only, a restart is full again', async () => {
  const k = FakeEdgeKey.demo();
  await sync(k);
  expect(lastCheckPath()).toBe('full');
  const again = await sync(k);
  expect(lastCheckPath()).toBe('skipped');
  expect(again.view.verdict).toEqual({kind: 'verified', through: (await k.head()).seq});
  k.use('commit 1000');
  k.ticket(0x00, 'done');
  const grown = await sync(k);
  expect(lastCheckPath()).toBe('new-links');
  expect(grown.view.verdict).toEqual({kind: 'verified', through: (await k.head()).seq});
  forgetVerified();
  await sync(k);
  expect(lastCheckPath()).toBe('full');
});

test('verification: an edited stored link under the same head is a full check and red', async () => {
  const k = FakeEdgeKey.demo();
  await sync(k);
  await sync(k);
  expect(lastCheckPath()).toBe('skipped');
  await tamper(k.deviceId, 'flip');
  const v = await verifyOnly(k);
  expect(lastCheckPath()).toBe('full');
  expect(v.verdict).toMatchObject({kind: 'tampered'});
});

test('verification: an edited OLD link is caught even when the head moved', async () => {
  const k = FakeEdgeKey.demo();
  await sync(k);
  await tamper(k.deviceId, 'flip');
  k.use('commit 1001');
  k.ticket(0x00, 'done');
  const {view} = await sync(k);
  expect(lastCheckPath()).toBe('full');
  expect(view.verdict.kind).not.toBe('verified');
});

/*
 * SEALED BLOCKS (BLOCKS.md §2a; Brad, 2026-10-07: "we only need to verify the new
 * stuff", "checkpoints can happen on a budget grant end"). A key that SIGNS: its
 * device id comes from its public key, as a real key's does, and copyKey() gives a
 * checkpoint over its live head each session.
 */
import {chain as edgeChain} from 'node-onlykey-lib/edge';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {p256} = require('node-onlykey-lib/vendor/@noble/curves/nist.js');

class SignedFake extends FakeEdgeKey {
  private readonly sk: Uint8Array = (p256.utils.randomSecretKey ?? p256.utils.randomPrivateKey)();
  readonly pub: Uint8Array = p256.getPublicKey(this.sk, false).subarray(1);
  constructor() {
    super();
    (this as unknown as {deviceId: Uint8Array}).deviceId = edgeChain.deviceIdOf(this.pub);
  }
  async copyKey() {
    const h = await this.head();
    return {publicKey: this.pub, openings: {}, checkpoint: {seq: h.seq, head: h.head, signature: edgeChain.signCheckpoint({deviceId: this.deviceId, seq: h.seq, head: h.head}, this.sk)}};
  }
}
const signedDemo = () => FakeEdgeKey.demo(new SignedFake()) as SignedFake;
const endOne = async (k: FakeEdgeKey) => { const b = (await k.budgets())[0]; if (b) await k.revoke(b.grantId); };

test('sealed: a budget end seals the block, and a restart starts from the seal, not from genesis', async () => {
  const k = signedDemo();
  await sync(k);
  expect(lastCheckPath()).toBe('full');
  await endOne(k);
  const sealedAt = await sync(k);
  expect(sealedAt.mirror.seals?.length).toBe(1);
  expect(sealedAt.mirror.seals![0].seq).toBe((await k.head()).seq);
  k.use('commit 2000');
  k.ticket(0x00, 'done');
  forgetVerified(); /* a restart */
  const {view} = await sync(k);
  expect(lastCheckPath()).toBe('sealed');
  expect(view.verdict).toEqual({kind: 'verified', through: (await k.head()).seq});
});

test('sealed: an edited link inside a sealed block is still caught after a restart', async () => {
  const k = signedDemo();
  await sync(k);
  await endOne(k);
  await sync(k);
  await tamper(k.deviceId, 'flip');
  forgetVerified();
  const {view} = await sync(k);
  expect(lastCheckPath()).toBe('full');
  expect(view.verdict.kind).not.toBe('verified');
});

test('sealed: a seal whose signature does not verify is ignored - the full check runs', async () => {
  const k = signedDemo();
  await sync(k);
  await endOne(k);
  await sync(k);
  const m = await loadMirror(k.deviceId);
  m.seals![0].signature = m.seals![0].signature.map((b, i) => (i === 3 ? b ^ 1 : b));
  await saveMirror(m);
  forgetVerified();
  const {view} = await sync(k);
  expect(lastCheckPath()).toBe('full');
  expect(view.verdict.kind).toBe('verified');
});

test('sealed: no budget ended since the last seal -> no new seal', async () => {
  const k = signedDemo();
  await sync(k);
  await endOne(k);
  await sync(k);
  k.use('commit 2001');
  k.ticket(0x00, 'done');
  const {mirror} = await sync(k);
  expect(mirror.seals?.length).toBe(1);
});

/*
 * ONE CHAIN STATE (okrn-edge-tab.md S3a; Brad, 2026-10-07: "1 complete check, both
 * bluetooth and ui or anything else can just ask for validity"; "watch events on it").
 */
import {chainState} from '../src/edgeStore';

test('chain state: two askers at once share ONE check', async () => {
  const k = FakeEdgeKey.demo();
  const checked: unknown[] = [];
  const off = chainState.on('checked', a => checked.push(a));
  const [a, b] = await Promise.all([chainState.validity(k), chainState.validity(k)]);
  off();
  expect(a).toBe(b);
  expect(checked).toHaveLength(1);
  expect(a.ok).toBe(true);
  expect(a.head?.seq).toBe((await k.head()).seq);
});

test('chain state: nothing changed -> the answer from memory, no check, no event', async () => {
  const k = FakeEdgeKey.demo();
  await chainState.validity(k);
  const checked: unknown[] = [];
  const off = chainState.on('checked', a => checked.push(a));
  const again = await chainState.validity(k);
  off();
  expect(again.path).toBe('skipped');
  expect(again.ok).toBe(true);
  expect(checked).toHaveLength(0);
});

test('chain state: new links -> one check of the new links only, and \'checked\' says so', async () => {
  const k = FakeEdgeKey.demo();
  await chainState.validity(k);
  k.use('commit 3000');
  k.ticket(0x00, 'done');
  const seen: string[] = [];
  const off = chainState.on('checked', a => seen.push(String(a.path)));
  const a = await chainState.validity(k);
  off();
  expect(seen).toEqual(['new-links']);
  expect(a.head?.seq).toBe((await k.head()).seq);
});

test('chain state: a tampered copy flips the verdict - \'changed\' fires, no verified head', async () => {
  const k = FakeEdgeKey.demo();
  await chainState.validity(k);
  await tamper(k.deviceId, 'flip');
  const changed: string[] = [];
  const off = chainState.on('changed', a => changed.push(a.view.verdict.kind));
  const a = await chainState.validity(k);
  off();
  expect(a.ok).toBe(false);
  expect(a.head).toBeNull();
  expect(changed).toEqual([a.view.verdict.kind]);
  expect(changed[0]).not.toBe('verified');
});

test('chain state: a budget end seals a block - \'sealed\' fires', async () => {
  const k = signedDemo();
  await chainState.validity(k);
  const sealed: number[] = [];
  const off = chainState.on('sealed', a => sealed.push(a.head!.seq));
  await endOne(k);
  await chainState.validity(k);
  off();
  expect(sealed).toEqual([(await k.head()).seq]);
});
