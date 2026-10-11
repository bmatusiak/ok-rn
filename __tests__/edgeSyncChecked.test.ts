/**
 * SYNC TAKES ONLY WHAT IS CHECKED, FROM A PAIRED COMPUTER (Brad, 2026-10-11: "checking every
 * field in a token means nothing if we never check the signature").
 *  - A sync message's signature is checked against a key the message itself carries, so it says
 *    nothing about who sent it: the PAIRED computer behind the Bluetooth link does - no pairing,
 *    no answer - and the banner names that pairing, not the name the message gives itself.
 *  - A COMMIT of this phone's own links keeps only links that verify in the copy they land in;
 *    one that cannot be checked (inside a gap) means nothing is taken.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const {chain, request: requestLib, sync: syncLib} = jest.requireActual('node-onlykey-lib/edge');

const DEV = Uint8Array.from({length: 16}, (_, i) => i + 1);
let mockPaired: Record<string, {id: string; name: string}> = {};
let mockView: any = null;
const mockKeep = jest.fn(async (_id: any, _added: any) => undefined);
const mockHold = jest.fn(async (_o: any) => ({held: true, count: 0}));

jest.mock('../src/edgeSoftKey', () => ({
  SoftKeyEdge: {open: async () => ({deviceId: Uint8Array.from({length: 16}, (_, i) => i + 1)})},
}));
jest.mock('../src/edgeStore', () => ({
  mergeOffered: async (_s: any, offered: any[]) => ({added: offered, conflicts: [], view: mockView}),
  keepOffered: (id: any, added: any) => mockKeep(id, added),
  sync: async () => ({mirror: {links: []}, view: {rows: []}}),
  loadMirror: async () => ({links: []}),
  addNote: async () => undefined,
}));
jest.mock('../src/edgeDevices', () => ({
  loadHeld: async () => [],
  holdLog: (o: any) => mockHold(o),
  ensureNametag: async () => null,
}));
jest.mock('../src/btTransit', () => ({
  btTransit: {computer: async (address: string) => mockPaired[address] ?? null},
}));

import {handleEdgeMessage} from '../src/edgeAgents';

const PAIRED = 'AA:BB:CC:DD:EE:01';
const STRANGER = 'AA:BB:CC:DD:EE:02';
const signer = requestLib.peerSignerFromSecret(Uint8Array.from({length: 32}, (_, i) => (i * 7 + 3) & 0xff));
/* one link of this phone's own chain at #5 (its bytes only - the store is mocked) */
const record = {link: chain.encodeLink({seq: 5, op: 1, decision: 1, subject: new Uint8Array(32).fill(9)}), head: new Uint8Array(32).fill(4)};

async function commitOne(address: string) {
  const parts = await syncLib.buildLinks({signer, deviceId: DEV, records: [record]});
  for (const m of parts) await handleEdgeMessage(m, address);
  return handleEdgeMessage(await syncLib.buildCommit({signer, deviceId: DEV, sid: parts[0].payload.sid, linkParts: parts.length}), address);
}

beforeEach(async () => {
  await AsyncStorage.clear();
  mockKeep.mockClear();
  mockHold.mockClear();
  mockPaired = {[PAIRED]: {id: 'pair-1', name: 'NITRO16'}};
});

test('a sync from a link that is not a paired computer: no answer', async () => {
  expect(await handleEdgeMessage(await syncLib.buildHave({signer, deviceId: DEV, name: 'nitro16'}), STRANGER)).toBeNull();
});

test('a COMMIT whose link cannot be checked (a gap): nothing taken', async () => {
  mockView = {verdict: {kind: 'gap', through: 3, from: 4, to: 6}, rows: [{seq: 5, verified: false}]};
  expect(await commitOne(PAIRED)).toMatchObject({ok: false, refusal: 'copy_unverified'});
  expect(mockKeep).not.toHaveBeenCalled();
});

test('a COMMIT whose links verify in the copy: taken', async () => {
  mockView = {verdict: {kind: 'verified', through: 5}, rows: [{seq: 5, verified: true}]};
  expect(await commitOne(PAIRED)).toMatchObject({ok: true, count: 1});
  expect(mockKeep).toHaveBeenCalledTimes(1);
});

test("an OFFER is held under the pairing's name, not the name the HAVE gave itself", async () => {
  const other = Uint8Array.from({length: 16}, () => 0xee);
  await handleEdgeMessage(await syncLib.buildHave({signer, deviceId: DEV, name: 'someone-else', chain: other}), PAIRED);
  const parts = await syncLib.buildLinks({signer, deviceId: DEV, records: [record], chain: other});
  for (const m of parts) await handleEdgeMessage(m, PAIRED);
  /* shapes only (holdLog is mocked; its own tests check the signatures) */
  const b = (n: number) => new Uint8Array(n);
  const cp = {seq: 5, head: b(32), signature: b(64), signaturePq: b(3309)};
  const statement = {publicKey: b(64), publicKeyPq: b(1952), seq: 5, nametag: 'x', signature: b(64), signaturePq: b(3309)};
  const offerAnswer = await handleEdgeMessage(await syncLib.buildOffer({signer, deviceId: DEV, sid: parts[0].payload.sid, chain: other, linkParts: parts.length, checkpoint: cp, statement}), PAIRED);
  expect(offerAnswer).toMatchObject({ok: true});
  expect(mockHold).toHaveBeenCalledTimes(1);
  expect(mockHold.mock.calls[0][0].from).toBe('NITRO16');
});
