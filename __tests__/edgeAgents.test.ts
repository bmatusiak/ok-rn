/**
 * WHO ASKS IS THE PAIRING (Brad, 2026-10-08: "so the claude key thing is overkill"; "lets cut
 * it out"): no agent key, no registration, no agent-add link. A budget request or a note is
 * taken only from a link that is a PAIRED computer (btTransit.computer) - the vendor bridge has
 * already dropped anything not inside that pairing's encrypted session. Anything else gets no
 * answer and never reaches the sheet or the key.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const {request: requestLib, note: noteLib} = jest.requireActual('node-onlykey-lib/edge');

const mockAnswerAgent = jest.fn(async (_msg: any, _o: any) => ({ok: false, refusal: 'declined'}));
const mockAddNote = jest.fn(async (_id: any, _n: any) => undefined);
let mockPaired: Record<string, {id: string; name: string}> = {};

jest.mock('../src/edgeSoftKey', () => ({
  SoftKeyEdge: {
    open: async () => ({
      deviceId: new Uint8Array(32),
      check: async () => ({ok: true}),
      loadAgentBudgets: async () => undefined,
      answerAgent: mockAnswerAgent,
    }),
  },
}));
jest.mock('../src/edgeStore', () => ({
  sync: async () => ({view: {rows: []}}),
  addNote: (id: any, n: any) => mockAddNote(id, n),
}));
jest.mock('../src/btTransit', () => ({
  btTransit: {computer: async (address: string) => mockPaired[address] ?? null},
}));

import {handleEdgeMessage} from '../src/edgeAgents';

const PAIRED = 'AA:BB:CC:DD:EE:01';
const STRANGER = 'AA:BB:CC:DD:EE:02';
const ask = () => requestLib.build({reason: 'push', scopes: [{op: 'sign', slot: 222, cap: 1, identity: 'ssh://agent@nitro16'}], lifetime: 10});

beforeEach(async () => {
  await AsyncStorage.clear();
  mockAnswerAgent.mockClear();
  mockAddNote.mockClear();
  mockPaired = {[PAIRED]: {id: 'pair-1', name: 'NITRO16'}};
});

test('a link that is not a paired computer: no answer, never asked, never sent to the key', async () => {
  expect(await handleEdgeMessage(await ask(), STRANGER)).toBeNull();
  expect(mockAnswerAgent).not.toHaveBeenCalled();
});

test('a paired computer: the request goes on to the sheet, named by its pairing, its id kept for a continue', async () => {
  expect(await handleEdgeMessage(await ask(), PAIRED)).toEqual({ok: false, refusal: 'declined'});
  expect(mockAnswerAgent).toHaveBeenCalledTimes(1);
  expect(mockAnswerAgent.mock.calls[0][1]).toMatchObject({from: 'NITRO16', computer: 'pair-1'});
});

test('the Requests switch off: refused unread, even from a paired computer', async () => {
  await AsyncStorage.setItem('okrn.edge.agentRequests', 'off');
  expect(await handleEdgeMessage(await ask(), PAIRED)).toBeNull();
  expect(mockAnswerAgent).not.toHaveBeenCalled();
});

test('a note: kept with the paired computer\'s id; from a stranger, dropped', async () => {
  const n = await noteLib.build({seq: 3, reason: 'git push'});
  expect(await handleEdgeMessage(n, STRANGER)).toBeNull();
  expect(await handleEdgeMessage(await noteLib.build({seq: 3, reason: 'git push'}), PAIRED)).toEqual({ok: true});
  await new Promise<void>(r => setTimeout(r, 0));
  expect(mockAddNote).toHaveBeenCalledTimes(1);
  expect(mockAddNote.mock.calls[0][1]).toMatchObject({computer: 'pair-1', seq: 3, reason: 'git push'});
});
