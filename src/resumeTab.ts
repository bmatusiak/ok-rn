import AsyncStorage from '@react-native-async-storage/async-storage';

/*
 * BACK TO THE TAB YOU LEFT, after a restart you asked for (owner, 2026-10-01).
 *
 * Every in-app restart - "Log out", and the "Restart the app" a config-mode
 * change ends with - relaunches the process (the soft key's firmware only
 * re-reads its state at boot; see the Log out note in App.tsx). Without this
 * the app came back on This Key, so finishing a PIN change or a Key Chain
 * write meant finding your way back every time.
 *
 * So the restart remembers the tab (OkEmu.restartApp runs the hook), and the
 * next LOGIN opens it - once, and only within five minutes of the restart.
 * Later than that it is a new visit and starts on This Key, as does any start
 * that was not a deliberate restart (a crash, a cold start), because nothing
 * was written for those.
 *
 * Only the tab's name is stored: nothing about the key.
 */

const KEY = 'okrn.resumeTab';
export const RESUME_WINDOW_MS = 5 * 60 * 1000;

/** Remember the tab for the next login. Awaited before the process goes. */
export async function rememberTab(tab: string, now: number = Date.now()): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify({tab, at: now}));
  } catch {
    /* Remembering is a convenience; a restart must still happen. */
  }
}

/**
 * The decision, kept pure for the tests: the stored record, the tabs that
 * exist now, and the clock.
 */
export function pickResumeTab(raw: string | null, valid: readonly string[], now: number): string | null {
  if (!raw) return null;
  try {
    const {tab, at} = JSON.parse(raw) as {tab?: unknown; at?: unknown};
    if (typeof tab !== 'string' || typeof at !== 'number') return null;
    if (now - at < 0 || now - at > RESUME_WINDOW_MS) return null;
    return valid.includes(tab) ? tab : null;
  } catch {
    return null;
  }
}

/** Read AND forget the remembered tab: it is used once, at the first login. */
export async function takeResumeTab(valid: readonly string[], now: number = Date.now()): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    await AsyncStorage.removeItem(KEY);
    return pickResumeTab(raw, valid, now);
  } catch {
    return null;
  }
}
