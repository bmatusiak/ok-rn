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
import {fromHex, toHex} from 'node-onlykey-lib/bytes';

/* eslint-disable @typescript-eslint/no-var-requires */
const {p256} = require('../node_modules/node-onlykey-lib/src/vendor/exports/@noble/curves/nist.js');
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
  const {publicKey, deviceId} = await d.e.publicKey();
  const h = await d.e.head();
  return holdLog({deviceId, publicKey, records: await d.e.pickup(0, h.seq + 1), checkpoint: await d.e.checkpoint(), statement: await d.e.statement(nametag), from, notes: {messages: {0: DONE0}}});
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
  expect(await ownerKey()).not.toBeNull();
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
  const {publicKey, deviceId} = await d.e.publicKey();
  const h = await d.e.head();
  const oldOffer = {deviceId, publicKey, records: await d.e.pickup(0, h.seq + 1), checkpoint: await d.e.checkpoint(), statement: await d.e.statement('x'), from: 'NITRO16'};
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
