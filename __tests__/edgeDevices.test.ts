/**
 * Your devices, this phone's nametag and the held logs (src/edgeDevices.ts; Brad,
 * 2026-10-08: "we should hold these blocks in the app until approved and merged"; "if it
 * has the private ecc key to sign the block, then i want the log"; nametags). Against the
 * lib's fake keys: one is "this phone", the others are your other devices or a stranger.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import NativeEdgeAlert from '../specs/NativeEdgeAlert';
import {
  approveHeld, approveKeychain, declineHeld, holdKeychain, holdLog, loadDevices, nametagOf, notMine, ownStatement, ownerKey, reviewHeld, setNametag, waitingCount,
} from '../src/edgeDevices';
import {loadMirror} from '../src/edgeStore';
import {fromHex, toHex} from 'node-onlykey-lib/bytes';

/* eslint-disable @typescript-eslint/no-var-requires */
const {p256} = require('../node_modules/node-onlykey-lib/src/vendor/exports/@noble/curves/nist.js');
const {fakeKey, edgeOver} = require('../node_modules/node-onlykey-lib/edge/test/helpers/fake-edge-key');

async function device({ownerSecret, links = 2}: {ownerSecret?: Uint8Array; links?: number} = {}) {
  const t = fakeKey({secret: p256.utils.randomSecretKey(), ...(ownerSecret ? {ownerSecret} : {})});
  const e = edgeOver(t);
  for (let i = 0; i < links; i += 1) t.edgeRecord();
  return {t, e};
}
async function offer(d: {e: any}, nametag: string, from = 'NITRO16') {
  const {publicKey, deviceId} = await d.e.publicKey();
  const h = await d.e.head();
  return holdLog({deviceId, publicKey, records: await d.e.pickup(0, h.seq + 1), checkpoint: await d.e.checkpoint(), statement: await d.e.statement(nametag), from});
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

test('a Key Chain list that would change this phone\'s waits in the same sheet and counts on the banner', async () => {
  await holdKeychain({from: 'NITRO16', at: 1, merged: [{name: 'k'}], in: 1, out: 0});
  expect(await waitingCount()).toBe(1);
  const kept: any[] = [];
  expect(await approveKeychain(async m => { kept.push(...m); })).toBe(1);
  expect(kept).toEqual([{name: 'k'}]);
  expect(await waitingCount()).toBe(0);
});
