/**
 * THE AGENT IDENTITY THE PHONE KEEPS (SPEC H7; Brad, 2026-10-20: "computer sets, phone keeps",
 * shown in Edge Management). Only a paired computer is answered; a SET is kept only when the
 * person approves it on the Edge sheet; a GET reads back exactly what was kept; a replay and a
 * bad record are refused; the Requests switch stops a SET but not a GET.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const {identity: identityLib} = jest.requireActual('node-onlykey-lib/edge');

let mockPaired: Record<string, {id: string; name: string}> = {};
jest.mock('../src/edgeSoftKey', () => ({SoftKeyEdge: {open: async () => null}}));
jest.mock('../src/edgeStore', () => ({sync: async () => ({view: {rows: []}}), addNote: async () => undefined}));
jest.mock('../src/btTransit', () => ({
  btTransit: {computer: async (address: string) => mockPaired[address] ?? null},
}));

import {answerSheet, closeSheet, handleEdgeMessage, onSheet, type SheetState} from '../src/edgeAgents';
import {loadKept} from '../src/edgeIdentity';

const PAIRED = 'AA:BB:CC:DD:EE:01';
const STRANGER = 'AA:BB:CC:DD:EE:02';
const RECORD = {
  ssh: 'ssh://claude@nitro16',
  gpgUid: 'Claude (nitro16) <bmatusiak+agent@gmail.com>',
  committer: {name: 'Claude (nitro16)', email: 'bmatusiak+agent@gmail.com'},
  expires: 31536000,
  cert: {
    armored: '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nxjMEZ\n-----END PGP PUBLIC KEY BLOCK-----\n',
    fingerprint: '7FBF276C85DD192794B46CC4F75A92949D5603CA', created: 1791085347, expires: 31536000, signPublic: 'ab'.repeat(32),
  },
};

/*
 * The person at the phone: waits for the sheet to ask, then answers it - once. It stops
 * listening the moment the sheet is done (on a timer it outlived its test and answered the
 * next test's sheet).
 */
function personAnswers(a: 'approve' | 'decline'): Promise<SheetState> {
  return new Promise(resolve => {
    let finished = false;
    let off: () => void = () => undefined;
    off = onSheet(s => {
      if (finished) return;
      if (s?.phase === 'ask') setTimeout(() => answerSheet(a), 0);
      if (s?.phase === 'done') { finished = true; off(); resolve(s); }
    });
  });
}
const get = () => handleEdgeMessage(identityLib.buildGet(), PAIRED) as Promise<any>;

beforeEach(async () => {
  closeSheet();
  await AsyncStorage.clear();
  mockPaired = {[PAIRED]: {id: 'pair-1', name: 'NITRO16'}};
});

test('nothing kept yet: a GET answers no record', async () => {
  expect(await get()).toEqual({ok: true, record: null});
});

test('a stranger (not a paired computer): no answer, nothing asked, nothing kept', async () => {
  expect(await handleEdgeMessage(identityLib.buildSet({record: RECORD}), STRANGER)).toBeNull();
  expect(await handleEdgeMessage(identityLib.buildGet(), STRANGER)).toBeNull();
  expect((await get()).record).toBeNull();
});

test('approved on the sheet: kept, read back exactly, shown as set from that computer', async () => {
  const sheet = personAnswers('approve');
  expect(await handleEdgeMessage(identityLib.buildSet({record: RECORD}), PAIRED)).toEqual({ok: true});
  const done = await sheet;
  expect(done.ask.kind).toBe('identity');
  expect(done.phase === 'done' && done.result.ok).toBe(true);
  expect((await get()).record).toEqual(identityLib.clean(RECORD));
  const kept = await loadKept();
  expect(kept?.setBy?.computer).toBe('NITRO16');
  expect(identityLib.rows(kept?.record)[3]).toEqual(['certificate', '7FBF 276C 85DD 1927 94B4 6CC4 F75A 9294 9D56 03CA']);
});

test('declined on the sheet: nothing kept, the computer told "declined"', async () => {
  const sheet = personAnswers('decline');
  expect(await handleEdgeMessage(identityLib.buildSet({record: RECORD}), PAIRED)).toEqual({ok: false, refusal: 'declined'});
  await sheet;
  expect((await get()).record).toBeNull();
});

test('a replayed SET is dropped; a bad record is refused with the field named, never asked', async () => {
  const msg = identityLib.buildSet({record: RECORD});
  const sheet = personAnswers('approve');
  expect(await handleEdgeMessage(msg, PAIRED)).toEqual({ok: true});
  await sheet;
  closeSheet();
  expect(await handleEdgeMessage(msg, PAIRED)).toBeNull();
  const bad = {...identityLib.buildGet(), type: identityLib.SET_TYPE, record: {...RECORD, ssh: 'nope'}};
  const r: any = await handleEdgeMessage(bad, PAIRED);
  expect(r).toMatchObject({ok: false, refusal: 'invalid'});
  expect(r.detail).toMatch(/ssh/);
});

test('the Requests switch off: a SET is refused unread, a GET still answers', async () => {
  await AsyncStorage.setItem('okrn.edge.agentRequests', 'off');
  expect(await handleEdgeMessage(identityLib.buildSet({record: RECORD}), PAIRED)).toBeNull();
  expect(await get()).toEqual({ok: true, record: null});
});
