/**
 * Your devices, this phone's nametag and the held logs (src/edgeDevices.ts; Brad,
 * 2026-10-08: "we should hold these blocks in the app until approved and merged"; "if it
 * has the private ecc key to sign the block, then i want the log"; nametags). Against the
 * lib's fake keys: one is "this phone", the others are your other devices or a stranger.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import NativeEdgeAlert from '../specs/NativeEdgeAlert';
import {
  approveHeld, bannerLine, declineHeld, ensureNametag, holdLog, loadDevices, nametagOf, notMine, ownStatement, ownerKey, reviewHeld, setNametag, waitingCount,
} from '../src/edgeDevices';
import {loadMirror} from '../src/edgeStore';
import {edgeKey} from '../src/net';
import {fromHex, toHex} from 'node-onlykey-lib/bytes';

/* eslint-disable @typescript-eslint/no-var-requires */
const {p256} = require('../node_modules/node-onlykey-lib/src/vendor/exports/@noble/curves/nist.js');
/* the lib's fake key: hybrid, as the soft key (PUBKEY_PQ; both halves on checkpoints and statements) */
const {fakeKey, edgeOver} = require('../node_modules/node-onlykey-lib/edge/test/helpers/fake-edge-key');

/* the fake starts with one use owing its result (#0); a complete device files it, with a message (2026-10-09) */
const DONE0 = 'done #0';
const {receipts} = require('../node_modules/node-onlykey-lib/edge/src');
async function device({ownerSecret, links = 2, result = true}: {ownerSecret?: Uint8Array; links?: number; result?: boolean} = {}) {
  const t = fakeKey({secret: p256.utils.randomSecretKey(), ...(ownerSecret ? {ownerSecret} : {})});
  const e = edgeOver(t);
  if (result) await e.receipt(0, 0, receipts.messageHash(DONE0));
  for (let i = 0; i < links; i += 1) t.edgeRecord();
  return {t, e};
}
async function offer(d: {e: any}, nametag: string, from = 'NITRO16') {
  return holdLog({...(await offered(d, nametag, from)), notes: {messages: {0: DONE0}}});
}
/* what a computer offers of a device: its links, its newest checkpoint (both halves), its statement (fully hybrid) */
async function offered(d: {e: any}, nametag: string, from = 'NITRO16') {
  const {publicKey, deviceId} = await d.e.publicKey();
  const publicKeyPq = await d.e.publicKeyPq('checkpoint');
  const h = await d.e.head();
  return {deviceId, publicKey, publicKeyPq, records: await d.e.pickup(0, h.seq + 1), checkpoint: await d.e.checkpoint(), statement: await d.e.statement(nametag), from};
}
const hex = (b: Uint8Array) => toHex(b);

beforeEach(async () => {
  await AsyncStorage.clear();
  (NativeEdgeAlert!.post as jest.Mock).mockClear();
});

test('this phone\'s nametag: the key signs it with its owner key, the phone keeps the statement', async () => {
  const me = await device();
  expect(await ownStatement()).toBeNull();
  const s = await setNametag(me.e, '  A13 ');
  expect(s.nametag).toBe('A13');
  const owner = await ownerKey();
  expect(owner?.ownerKey.length).toBe(64);
  expect(owner?.ownerKeyPq.length).toBe(1952); /* the owner key's ML-DSA-65 twin, from the same statement */
  expect((await ownStatement())?.nametag).toBe('A13');
});

test('a log made with your OnlyKey from a new device is HELD: the banner counts it, nothing merges until "is it yours?" Yes', async () => {
  const me = await device();
  await setNametag(me.e, 'A13');
  const hard = await device({links: 3});
  expect((await offer(hard, 'hard key')).held).toBe(true);
  expect(await waitingCount()).toBe(1);
  const [v] = await reviewHeld();
  expect([v.class, v.nametag, v.checkOk, v.from]).toEqual(['mine-new', 'hard key', true, 'NITRO16']);
  const id = hex((await hard.e.publicKey()).deviceId);
  expect((await loadMirror(fromHex(id))).links).toHaveLength(0);
  await expect(approveHeld(id)).rejects.toThrow(/whether this device is yours/);
  expect((await approveHeld(id, {isMine: true})).merged).toBeGreaterThan(0);
  expect(await waitingCount()).toBe(0);
  expect((await loadMirror(fromHex(id))).links.length).toBeGreaterThan(0);
  const [d] = await loadDevices();
  expect(d.deviceId).toBe(id);
  expect(await nametagOf(d)).toEqual({nametag: 'hard key', previously: []});
});

test('a device you know comes back renamed: mine-known, Approve merges, the newest nametag wins and the old one is "previously"', async () => {
  const me = await device();
  await setNametag(me.e, 'A13');
  const pixel = await device();
  await offer(pixel, 'phone');
  const id = hex((await pixel.e.publicKey()).deviceId);
  await approveHeld(id, {isMine: true});
  pixel.t.edgeRecord();
  await offer(pixel, 'Pixel');
  const [v] = await reviewHeld();
  expect(v.class).toBe('mine-known');
  await approveHeld(id);
  expect(await nametagOf((await loadDevices())[0])).toEqual({nametag: 'Pixel', previously: ['phone']});
  /* one ML-DSA anchor per copy: the newest merge point keeps its pq half, the older one drops it */
  const merged = (await loadMirror(fromHex(id))).merged!;
  expect(merged).toHaveLength(2);
  expect(merged[0].signaturePq).toBeUndefined();
  expect(merged[1].signaturePq?.length).toBe(3309);
  expect((await loadMirror(fromHex(id))).publicKeyPq?.length).toBe(1952);
});

/*
 * HYBRID STATEMENTS (Brad, 2026-10-10): a device is "mine" only when its statement verifies with
 * BOTH owner signatures and names the ML-DSA-65 checkpoint key its log is checked with.
 */
test.each([
  ['its ML-DSA-65 signature is missing', (st: any) => ({...st, signaturePq: new Uint8Array(0)})],
  ['its ML-DSA-65 signature is wrong', (st: any) => ({...st, signaturePq: st.signaturePq.map((b: number, i: number) => (i === 7 ? b ^ 1 : b))})],
  ['it names another ML-DSA-65 checkpoint key', (st: any) => ({...st, publicKeyPq: st.publicKeyPq.map((b: number, i: number) => (i === 0 ? b ^ 1 : b))})],
])('a statement whose pq half does not hold does not make a device "mine": %s', async (_why, edit) => {
  const me = await device();
  await setNametag(me.e, 'A13');
  const other = await device();
  const o = await offered(other, 'Pixel');
  await holdLog({...o, statement: edit(o.statement), notes: {messages: {0: DONE0}}});
  const [v] = await reviewHeld();
  expect(v.class).toBe('forged');
  expect(v.nametag).toBeNull();
  await expect(approveHeld(v.deviceId, {isMine: true})).rejects.toThrow(/not made with your OnlyKey/);
});

test('a held log whose newest checkpoint lacks its ML-DSA-65 half does not check - never merged', async () => {
  const me = await device();
  await setNametag(me.e, 'A13');
  const other = await device();
  const o = await offered(other, 'Pixel');
  await holdLog({...o, checkpoint: {...o.checkpoint, signaturePq: new Uint8Array(0)}, notes: {messages: {0: DONE0}}});
  const [v] = await reviewHeld();
  expect(v.class).toBe('mine-new'); /* the statement is good: it is yours */
  expect(v.checkOk).toBe(false);
  await expect(approveHeld(v.deviceId, {isMine: true})).rejects.toThrow(/does not check/);
});

test('a log NOT made with your OnlyKey is forged: never merged, kept as evidence', async () => {
  const me = await device();
  await setNametag(me.e, 'A13');
  const stranger = await device({ownerSecret: p256.utils.randomSecretKey()});
  await offer(stranger, 'A13 (really)');
  const [v] = await reviewHeld();
  expect(v.class).toBe('forged');
  expect(v.nametag).toBeNull();
  await expect(approveHeld(v.deviceId, {isMine: true})).rejects.toThrow(/not made with your OnlyKey/);
  await declineHeld(v.deviceId);
  expect(await waitingCount()).toBe(0);
  expect((await reviewHeld())[0].declined).toBe(true);
});

test('"is it yours?" No: someone else holds your OnlyKey - the red alarm, the log kept', async () => {
  const me = await device();
  await setNametag(me.e, 'A13');
  const thief = await device();
  await offer(thief, 'my phone');
  const id = hex((await thief.e.publicKey()).deviceId);
  await notMine(id);
  expect(NativeEdgeAlert!.post).toHaveBeenCalledTimes(1);
  expect((NativeEdgeAlert!.post as jest.Mock).mock.calls[0][1]).toMatch(/someone else holds your OnlyKey/);
  expect(await waitingCount()).toBe(0);
  expect((await reviewHeld())[0].leak).toBe(true);
});

test('an older offer never replaces a newer held one', async () => {
  const me = await device();
  await setNametag(me.e, 'A13');
  const d = await device({links: 3});
  const oldOffer = await offered(d, 'x');
  d.t.edgeRecord();
  await offer(d, 'x');
  expect((await holdLog(oldOffer)).held).toBe(false);
});

test('the device name is the nametag until one is set by hand (Brad, 2026-10-08)', async () => {
  const NativeBtKeyboard = require('../specs/NativeBtKeyboard').default;
  (NativeBtKeyboard.localName as jest.Mock).mockResolvedValueOnce("Bradley's A13");
  const me = await device();
  expect((await ensureNametag(me.e))?.nametag).toBe("Bradley's A13");
  await setNametag(me.e, 'work phone');
  (NativeBtKeyboard.localName as jest.Mock).mockResolvedValueOnce("Bradley's A13");
  expect((await ensureNametag(me.e))?.nametag).toBe('work phone');
  expect(await ensureNametag(null)).not.toBeNull();
});

test('the banner names the computer and the device (Brad, 2026-10-08: "nitro16 wants to merge a unknown backup device Pixel")', async () => {
  const me = await device();
  await setNametag(me.e, 'A13');
  expect(await bannerLine()).toBeNull();
  await offer(await device(), 'Pixel', 'nitro16');
  expect(await bannerLine()).toBe('nitro16 wants to merge a unknown backup device Pixel');
});

test('after a key reset (a new device id) the old statement is signed again, the nametag kept (2026-10-08)', async () => {
  const before = await device();
  await setNametag(before.e, 'work phone');
  const after = await device(); /* the same key after its Edge reset: a new device id */
  const {deviceId} = await after.e.publicKey();
  const s = await ensureNametag({statement: (n: string) => after.e.statement(n), deviceId});
  expect(s?.nametag).toBe('work phone');
  expect(s?.deviceId).toBe(hex(deviceId));
  expect((await ownStatement())?.deviceId).toBe(hex(deviceId));
});

test('a statement without its ML-DSA half is signed again, both halves and the nametag kept (2026-10-10)', async () => {
  const me = await device();
  await setNametag(me.e, 'work phone');
  const {deviceId} = await me.e.publicKey();
  /* a statement signed before the hybrid signatures: no publicKeyPq, no signaturePq */
  const old = {...(await ownStatement())!, publicKeyPq: '', signaturePq: ''};
  await AsyncStorage.setItem(edgeKey('ownStatement'), JSON.stringify(old));
  const s = await ensureNametag({statement: (n: string) => me.e.statement(n), deviceId});
  expect(s?.nametag).toBe('work phone');
  expect(s?.publicKeyPq.length).toBeGreaterThan(0);
  expect(s?.signaturePq.length).toBeGreaterThan(0);
  expect((await ownStatement())?.signaturePq.length).toBeGreaterThan(0);
});

/*
 * COMPLETE BEFORE IT IS MERGED (Brad, 2026-10-09: "a data store must contain all info about the
 * usage of the credental, including the result"): a log with a use still waiting for its result
 * is held, the sheet says what is missing, and the merge refuses it.
 */
test('a log missing a use\'s result is not merged - the sheet says what is missing', async () => {
  const me = await device();
  await setNametag(me.e, 'A13');
  const waiting = await device({links: 1, result: false});
  await offer(waiting, 'hard key');
  const [v] = await reviewHeld();
  expect(v.complete).toBe(false);
  expect(v.missing.join(' ')).toMatch(/#0: no result/);
  await expect(approveHeld(v.deviceId, {isMine: true})).rejects.toThrow(/not complete - nothing merged/);
});

/*
 * Two-phone testnet walk (2026-10-11): the computer offers every log it holds at every sync.
 * The same log offered again must not undo an answer - a declined log stays declined, a merged
 * one is not held again - and only a newer checkpoint asks again.
 */
test('the same log offered again changes nothing: declined stays declined, merged is not held; a newer one asks again', async () => {
  const me = await device();
  await setNametag(me.e, 'A13');
  const old = await device();
  await offer(old, 'old phone');
  const oldId = hex((await old.e.publicKey()).deviceId);
  await declineHeld(oldId);
  expect((await offer(old, 'old phone')).held).toBe(false);
  expect(await waitingCount()).toBe(0);
  expect((await reviewHeld()).find(v => v.deviceId === oldId)?.declined).toBe(true);

  const pixel = await device();
  await offer(pixel, 'Pixel');
  const id = hex((await pixel.e.publicKey()).deviceId);
  await approveHeld(id, {isMine: true});
  expect((await offer(pixel, 'Pixel')).held).toBe(false);
  expect(await waitingCount()).toBe(0);

  pixel.t.edgeRecord();
  expect((await offer(pixel, 'Pixel')).held).toBe(true);
  expect(await waitingCount()).toBe(1);
}, 30000);

/*
 * Live A13 (2026-10-11): the Pixel's log came failing a check (a bug of that build), "Keep as
 * evidence" was the only answer, and the same checkpoint never asked again. A log declined while
 * it did not check out is judged again when it comes back; a good log declined keeps its answer.
 */
test('a log kept only because it failed a check asks again when it comes back checking out', async () => {
  const me = await device();
  await setNametag(me.e, 'A13');
  const pixel = await device();
  const id = hex((await pixel.e.publicKey()).deviceId);
  /* first offer without the receipt's message: not complete, so Decline is the only answer */
  expect((await holdLog({...(await offered(pixel, 'Pixel')), notes: null})).held).toBe(true);
  expect((await reviewHeld())[0].complete).toBe(false);
  await declineHeld(id);
  expect(await waitingCount()).toBe(0);
  /* the same checkpoint, now complete: held again, waiting for an answer */
  expect((await offer(pixel, 'Pixel')).held).toBe(true);
  expect(await waitingCount()).toBe(1);
  const [v] = await reviewHeld();
  expect([v.complete, v.checkOk, v.declined]).toEqual([true, true, false]);
  /* a good log declined keeps its answer */
  await declineHeld(id);
  expect((await offer(pixel, 'Pixel')).held).toBe(false);
  expect(await waitingCount()).toBe(0);
}, 30000);
