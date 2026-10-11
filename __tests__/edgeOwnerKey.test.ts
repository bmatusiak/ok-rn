/**
 * KEYS READ BACK FROM STORAGE ARE TIED TO THE KEY (Brad, 2026-10-11: "checking every field in a
 * token means nothing if we never check the signature").
 *  - The owner key every held log is judged against comes from this phone's stored statement;
 *    after a restart it is used only once the soft key signs a statement with the same key.
 *  - Another device's view checks its stored public key against the device id it is filed under.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {toHex} from 'node-onlykey-lib/bytes';
import {edgeKey} from '../src/net';

/* eslint-disable @typescript-eslint/no-var-requires */
const {p256} = require('../node_modules/node-onlykey-lib/src/vendor/exports/@noble/curves/nist.js');
const {fakeKey, edgeOver} = require('../node_modules/node-onlykey-lib/edge/test/helpers/fake-edge-key');

const keyOf = (ownerSecret?: Uint8Array) => edgeOver(fakeKey({secret: p256.utils.randomSecretKey(), ...(ownerSecret ? {ownerSecret} : {})}));

/* a fresh app (a restart) whose soft key is `e` */
function freshApp(e: any) {
  let mods: any;
  jest.isolateModules(() => {
    jest.doMock('../src/edgeSoftKey', () => ({SoftKeyEdge: {open: async () => e}}));
    mods = {devices: require('../src/edgeDevices')};
  });
  return mods;
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

test('after a restart the stored owner key is used once the soft key signs with the same key', async () => {
  const me = keyOf();
  await freshApp(me).devices.setNametag(me, 'A13');
  const owner = await freshApp(me).devices.ownerKey();
  expect(owner?.ownerKey.length).toBe(64);
});

test('a stored owner key swapped for another: not used after a restart', async () => {
  const me = keyOf();
  const thief = keyOf(p256.utils.randomSecretKey());
  await freshApp(me).devices.setNametag(me, 'A13');
  /* storage edited: this phone's statement replaced by one the thief's key signed (same storage) */
  await freshApp(thief).devices.setNametag(thief, 'A13');
  expect(JSON.parse((await AsyncStorage.getItem(edgeKey('ownStatement'))) as string).ownerKey).not.toBe(undefined);
  expect(await freshApp(me).devices.ownerKey()).toBeNull();
});

test("another device's view whose stored key is not that device's: red, not verified", async () => {
  const {SoftKeyEdge} = jest.requireActual('../src/edgeSoftKey');
  const {saveMirror} = jest.requireActual('../src/edgeStore');
  const a = keyOf();
  const b = keyOf();
  const idA = (await a.publicKey()).deviceId as Uint8Array;
  const pubB = (await b.publicKey()).publicKey as Uint8Array;
  await saveMirror({deviceId: idA, links: [], messages: {}, lastSeen: null, lastSync: null, setAside: [], seen: {}, reasons: {}, refusals: [], publicKey: pubB, publicKeyPq: null, merged: []});
  const soft: any = new (SoftKeyEdge as any)(a, idA);
  const v = await soft.deviceView(toHex(idA));
  expect(v.verdict).toMatchObject({kind: 'tampered'});
});
