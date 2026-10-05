/*
 * R29 (okedge sync phase 2, P2b): the names the pairing sheets showed, by key.
 *
 * The KEY keeps only each sibling's public key (and derives its device id);
 * it has no room for names. The name came from the computer that asked for
 * the pairing - shown on the sheet, never trusted - and the phone keeps it so
 * "Your other keys" can say "Pixel 6a" instead of a fingerprint. Losing it
 * loses nothing that matters: the row falls back to the fingerprint.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'edge.siblingNames';

/** key (X || Y hex, lower case) -> the name the sheet showed */
export async function siblingNames(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const all = raw ? JSON.parse(raw) : {};
    return all && typeof all === 'object' ? all : {};
  } catch {
    return {};
  }
}

export async function rememberSiblingName(key: string, name: string): Promise<void> {
  const all = await siblingNames();
  all[key.toLowerCase()] = String(name).slice(0, 255);
  await AsyncStorage.setItem(KEY, JSON.stringify(all));
}
