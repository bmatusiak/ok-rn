/*
 * THE CLEAN START ON THE PHONE (Brad, 2026-10-07: "we change all the schemas to V1,
 * because we are doing a reset"): the first launch of the v1 build removes every Edge
 * record of the old chain, once, and keeps everything that is not Edge's.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {resetEdgeStoreOnce, EDGE_V1_MARK} from '../src/edgeV1';
import {loadMirror} from '../src/edgeStore';

test('once: every Edge record goes (live and testnet), the Key Chain list and other settings stay', async () => {
  await AsyncStorage.removeItem(EDGE_V1_MARK);
  const edge = ['okrn.edge.mirror.aa', 'okrn.edge.budgets.aa.7', 'okrn.edge.agents', 'okrn.edge.test.mirror.bb', 'edge.siblingNames', 'okrn.keychain.test.list'];
  const keep = ['okrn.keychain.list', 'okt.btpair.v1', 'okrn.someSetting'];
  for (const k of [...edge, ...keep]) await AsyncStorage.setItem(k, 'x');
  expect(await resetEdgeStoreOnce()).toEqual({removed: edge.length});
  for (const k of edge) expect(await AsyncStorage.getItem(k)).toBeNull();
  for (const k of keep) expect(await AsyncStorage.getItem(k)).toBe('x');
  await AsyncStorage.setItem('okrn.edge.mirror.cc', 'a new chain\'s');
  expect(await resetEdgeStoreOnce()).toBeNull(); /* done once */
  expect(await AsyncStorage.getItem('okrn.edge.mirror.cc')).toBe('a new chain\'s');
});

test('a stored copy without v: 1 (the old chain\'s) is not read', async () => {
  const id = new Uint8Array(16).fill(0xab);
  const hex = Array.from(id, b => b.toString(16).padStart(2, '0')).join('');
  await AsyncStorage.setItem('okrn.edge.mirror.' + hex, JSON.stringify({deviceId: hex, links: [{link: '00'.repeat(64), head: '00'.repeat(32)}], messages: {}, lastSeen: null, lastSync: null}));
  expect((await loadMirror(id)).links).toHaveLength(0);
});
