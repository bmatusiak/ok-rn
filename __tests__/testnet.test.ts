/*
 * THE TESTNET (BLOCKS.md §5; Brad, 2026-10-07: "--test-mode where edge blockchain
 * files are seperated from live and test (like how bitcoin does it)"; "technically
 * we change the storageSlot then for testnet"; "everthing for test is throwaway").
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {OkEmu} from '../src/transport/OkEmu';
import {storageSlot, testStorageSlot} from '../src/buildInfo';
import {currentNet, edgeKey, netOfStorageDir, setNet} from '../src/net';
import {clearTestnet} from '../src/testnet';

const NativeOkEmu = require('../specs/NativeOkEmu').default;

afterEach(() => {
  setNet('live');
  jest.clearAllMocks();
});

test('the testnet slot is this build\'s slot plus -test, a plain name of its own', () => {
  expect(testStorageSlot).toBe(storageSlot ? `${storageSlot}-test` : 'test');
  expect(testStorageSlot).not.toBe(storageSlot);
  expect(testStorageSlot).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
});

test('firmware.start(testmode ? testStorageSlot : storageSlot): the net follows the folder it runs on', async () => {
  await OkEmu.start('test');
  expect(NativeOkEmu.start).toHaveBeenLastCalledWith(testStorageSlot);
  expect(currentNet()).toBe('test');
  await OkEmu.start();
  expect(NativeOkEmu.start).toHaveBeenLastCalledWith(storageSlot);
  expect(currentNet()).toBe('live');
  /* a JS reload: asked for live, but the firmware already runs on the testnet's folder - the folder wins */
  NativeOkEmu.start.mockResolvedValueOnce({started: false, message: 'already running', storageDir: `/data/files/okemu/${testStorageSlot}`});
  await OkEmu.start('live');
  expect(currentNet()).toBe('test');
  expect(netOfStorageDir(`/x/okemu/${storageSlot || 'okemu'}`)).toBe('live');
});

test('Edge storage keys are the net\'s own', () => {
  expect(edgeKey('mirror.ab')).toBe('okrn.edge.mirror.ab');
  setNet('test');
  expect(edgeKey('mirror.ab')).toBe('okrn.edge.test.mirror.ab');
});

test('clear testnet: only from live; deletes the testnet slot and only the testnet\'s records', async () => {
  await AsyncStorage.setItem('okrn.edge.mirror.aa', 'live copy');
  await AsyncStorage.setItem('okrn.edge.testIdentities', 'live, despite the name');
  await AsyncStorage.setItem('okrn.keychain.list', 'live list');
  await AsyncStorage.setItem('okrn.edge.test.mirror.bb', 'test copy');
  await AsyncStorage.setItem('okrn.keychain.test.list', 'test list');
  setNet('test');
  await expect(clearTestnet()).rejects.toThrow(/on the testnet/);
  expect(NativeOkEmu.deleteSlot).not.toHaveBeenCalled();
  setNet('live');
  expect(await clearTestnet()).toEqual({removed: 2});
  expect(NativeOkEmu.deleteSlot).toHaveBeenCalledWith(testStorageSlot);
  expect(await AsyncStorage.getItem('okrn.edge.test.mirror.bb')).toBeNull();
  expect(await AsyncStorage.getItem('okrn.keychain.test.list')).toBeNull();
  expect(await AsyncStorage.getItem('okrn.edge.mirror.aa')).toBe('live copy');
  expect(await AsyncStorage.getItem('okrn.edge.testIdentities')).toBe('live, despite the name');
  expect(await AsyncStorage.getItem('okrn.keychain.list')).toBe('live list');
});

test('clear from the testnet: marked and the app restarts; the next launch clears it before any soft key starts', async () => {
  const {scheduleClearAndRestart, clearIfScheduled} = require('../src/testnet');
  await AsyncStorage.setItem('okrn.edge.test.mirror.cc', 'test copy');
  await AsyncStorage.setItem('okrn.edge.mirror.dd', 'live copy');
  setNet('test');
  void scheduleClearAndRestart(); /* the restart never returns */
  await new Promise<void>(r => setImmediate(() => r()));
  expect(NativeOkEmu.restartApp).toHaveBeenCalled();
  expect(await AsyncStorage.getItem('okrn.testnetClearNext')).toBe('1');
  setNet('live'); /* the next launch: nothing started, the default net */
  NativeOkEmu.isRunning.mockReturnValue(false);
  expect(await clearIfScheduled()).toEqual({removed: 1});
  expect(NativeOkEmu.deleteSlot).toHaveBeenCalledWith(testStorageSlot);
  expect(await AsyncStorage.getItem('okrn.edge.test.mirror.cc')).toBeNull();
  expect(await AsyncStorage.getItem('okrn.edge.mirror.dd')).toBe('live copy');
  expect(await clearIfScheduled()).toBeNull(); /* done once */
  NativeOkEmu.isRunning.mockReturnValue(true);
});
