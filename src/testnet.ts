/**
 * CLEAR THE TESTNET (BLOCKS.md §5; Brad, 2026-10-07: "everthing for test is
 * throwaway"): the testnet's soft key (its own storage slot - flash, EEPROM, keys,
 * Edge chain) and every record the phone kept for it. The live chain is never
 * touched: the slot delete is refused natively for any slot that is not the
 * testnet's, and only keys under the testnet's own prefixes are removed.
 *
 * The firmware cannot run on a folder being deleted, and the Testing tab is only
 * reached through Enter testing mode - which runs the testnet. So the button there
 * SCHEDULES the clear and restarts the app; the next launch clears it before any
 * firmware starts (clearIfScheduled, called once at app start).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import OkEmu from './transport/OkEmu';
import NativeOkEmu from '../specs/NativeOkEmu';
import {currentNet, TEST_PREFIX} from './net';

/* every phone record that belongs to the testnet: Edge (net.ts edgeKey) and its Key Chain list */
const TEST_KEYS = (k: string) => k.startsWith(TEST_PREFIX) || k === 'okrn.keychain.test.list';
/* not under the testnet's prefix, or clearing would remove its own mark mid-way */
const SCHEDULED = 'okrn.testnetClearNext';

/** Clear now - only while no firmware runs on the testnet. */
export async function clearTestnet(): Promise<{removed: number}> {
  if (currentNet() !== 'live' || (OkEmu.isRunning() && currentNet() === 'test')) {
    throw new Error('the soft key is on the testnet - Clear testnet restarts the app to clear it');
  }
  await OkEmu.deleteTestSlot();
  const keys = (await AsyncStorage.getAllKeys()).filter(TEST_KEYS);
  for (const k of keys) await AsyncStorage.removeItem(k);
  return {removed: keys.length};
}

/** From the testnet: mark the clear for the next launch and restart the app (never returns). */
export async function scheduleClearAndRestart(): Promise<void> {
  await AsyncStorage.setItem(SCHEDULED, '1');
  await NativeOkEmu.restartApp();
}

/** At app start, before any firmware starts: a scheduled clear is done now. -> what was cleared, or null */
export async function clearIfScheduled(): Promise<{removed: number} | null> {
  if ((await AsyncStorage.getItem(SCHEDULED)) !== '1') return null;
  if (OkEmu.isRunning()) return null; /* a JS reload: the firmware still runs - the mark stays for the next real launch */
  await AsyncStorage.removeItem(SCHEDULED);
  const r = await clearTestnet();
  console.log(`[testnet] cleared at launch: its soft key and ${r.removed} record(s)`);
  return r;
}
