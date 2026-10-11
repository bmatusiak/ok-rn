/**
 * APPROVE RUNS THE LIBRARY'S STRICT CHECK (Brad, 2026-10-11: "checking every field in a token
 * means nothing if we never check the signature"). The one chain state welds the links and
 * checks the key's checkpoint, but not a budget opening's own signature: a stored opening edited
 * on the phone still passed it. The gate before a budget opens or resumes (SoftKeyEdge
 * strictHead) now also runs lib grants.check - against the lib's fake key, which signs like the
 * firmware (both halves).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {receipts} from 'node-onlykey-lib/edge';
import {toHex} from 'node-onlykey-lib/bytes';
import {SoftKeyEdge, budgetRecordKey} from '../src/edgeSoftKey';
import {forgetVerified, sync} from '../src/edgeStore';

/* eslint-disable @typescript-eslint/no-var-requires */
const {fakeKey, edgeOver} = require('../node_modules/node-onlykey-lib/edge/test/helpers/fake-edge-key');

async function openOne(reason: string) {
  const e = edgeOver(fakeKey());
  const {deviceId} = await e.publicKey();
  const k: any = new (SoftKeyEdge as any)(e, deviceId);
  await e.settle();
  const h = await e.head();
  const copy = {links: h.seq === null ? [] : await e.pickup(0, h.seq + 1), openings: {}};
  const scopes = [{op: 1, slot: 2, cap: 2}];
  const g = await e.grants.create({copy, scopes, reasonHash: receipts.messageHash(reason)});
  /* lifetime as the budget was opened (none here): it is part of what the key signed */
  await k.keepOpening(g, {reason, scopes, from: 'test', lifetime: 0});
  return {k, g, deviceId, e};
}

beforeEach(async () => {
  await AsyncStorage.clear();
  forgetVerified();
});

test('an untouched copy passes the strict check at the head the chain state verified', async () => {
  const {k} = await openOne('strict: untouched');
  await sync(k);
  /* the gate Approve and resume use (verifiedHead): a head, not a refusal */
  await expect(k.verifiedHead()).resolves.toBeInstanceOf(Uint8Array);
}, 60000);

test('a stored opening edited on the phone, then a restart: the strict check refuses Approve', async () => {
  const {g, deviceId, e} = await openOne('strict: the real reason');
  const key = budgetRecordKey(toHex(deviceId), g.grantId);
  const kept = JSON.parse((await AsyncStorage.getItem(key)) as string);
  await AsyncStorage.setItem(key, JSON.stringify({...kept, reason: 'strict: an edited reason'}));
  /* a restart: storage is read once a session, so the edit is read by a fresh app */
  let fresh: any;
  jest.isolateModules(() => {
    fresh = {soft: require('../src/edgeSoftKey'), store: require('../src/edgeStore')};
  });
  const k2: any = new (fresh.soft.SoftKeyEdge as any)(e, deviceId);
  await fresh.store.sync(k2);
  /* the gate Approve and resume use (verifiedHead) refuses, naming the opening */
  await expect(k2.verifiedHead()).rejects.toThrow(/strict check: budget-opening/);
}, 60000);
