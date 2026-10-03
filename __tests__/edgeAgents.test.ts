/**
 * R15c (onlykey-edge firmware.md, 2026-10-03): ok-rn accepts an agent only if
 * its AGENT_ADD link - made at a press - is in the VERIFIED copy of the chain.
 * An agent planted in the app's storage without that press is refused, unread:
 * its request gets no answer and never reaches the sheet or the key.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const {request: requestLib, grants, codes} = jest.requireActual('node-onlykey-lib/edge');

const mockAnswerAgent = jest.fn(async () => ({ok: false, refusal: 'declined'}));
let mockRows: unknown[] = [];

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
  sync: async () => ({view: {rows: mockRows}}),
}));

import {handleEdgeMessage} from '../src/edgeAgents';

const AGENT = requestLib.signerFromSecret(new Uint8Array(32).fill(21));
const KEY = Array.from(AGENT.publicKey as Uint8Array, b => b.toString(16).padStart(2, '0')).join('');

async function ask() {
  return requestLib.build({signer: AGENT, reason: 'push', scopes: [{op: 'sign', slot: 222, cap: 1, identity: 'ssh://agent@nitro16'}], lifetime: 10});
}

beforeEach(async () => {
  await AsyncStorage.clear();
  mockAnswerAgent.mockClear();
  /* PLANTED: in the app's storage - even with a seq - but no press ever made a link for it */
  await AsyncStorage.setItem('okrn.edge.agents', JSON.stringify([{key: KEY, name: 'planted agent', registered: Date.now(), seq: 90}]));
});

test('an agent in storage without its agent-add link in the verified copy: no answer, never asked, never sent to the key', async () => {
  mockRows = [];
  expect(await handleEdgeMessage(await ask(), 'AA:BB:CC:DD:EE:01')).toBeNull();
  expect(mockAnswerAgent).not.toHaveBeenCalled();
});

test('a link the copy does NOT verify does not count either', async () => {
  mockRows = [{verified: false, fields: {seq: 90, op: codes.OP.AGENT_ADD, flags: codes.FLAG.PRESS_OBSERVED, subject: grants.agentSubject(AGENT.publicKey)}}];
  expect(await handleEdgeMessage(await ask(), 'AA:BB:CC:DD:EE:01')).toBeNull();
  expect(mockAnswerAgent).not.toHaveBeenCalled();
});

test('with its pressed link in the verified copy, the request goes on to the sheet', async () => {
  mockRows = [{verified: true, fields: {seq: 90, op: codes.OP.AGENT_ADD, flags: codes.FLAG.PRESS_OBSERVED, subject: grants.agentSubject(AGENT.publicKey)}}];
  expect(await handleEdgeMessage(await ask(), 'AA:BB:CC:DD:EE:01')).toEqual({ok: false, refusal: 'declined'});
  expect(mockAnswerAgent).toHaveBeenCalledTimes(1);
});
