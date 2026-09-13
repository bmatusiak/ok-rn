import AsyncStorage from '@react-native-async-storage/async-storage';
import {useCallback, useEffect, useState} from 'react';

/**
 * What Bluetooth starts by itself, remembered across launches.
 *
 * Three separate answers because they are three separate risks. Turning the
 * radio on is nearly free; publishing a keyboard announces this phone as an
 * input device to anything ever bonded with it; advertising the FIDO service
 * offers it as a security key. Somebody may well want the first without the
 * second, and the app should not decide that for them.
 *
 * ## Why this is a hook and not state on the Bluetooth screen
 *
 * Because it was, and it did not work. The preferences and the effect that
 * acted on them both lived in `BluetoothScreen`, which is mounted only while
 * that tab is on top - so "start on app start" started nothing until you
 * opened the tab, at which point it started and looked like it had worked all
 * along. The screen was the last place it could live: it is the one component
 * guaranteed to be absent at the moment the preference is about.
 *
 * So the preferences live here, and the acting-on-them lives in the status
 * icons in the top bar, which are mounted for as long as the app is.
 */
export type BtAutos = {
  start: boolean;
  keyboard: boolean;
  authenticator: boolean;
};

const KEYS = {
  start: 'ok-rn/bt/auto-start',
  keyboard: 'ok-rn/bt/auto-keyboard',
  authenticator: 'ok-rn/bt/auto-authenticator',
} as const;

export type BtAuto = ReturnType<typeof useBtAuto>;

export function useBtAuto() {
  const [autos, setAutos] = useState<BtAutos>({
    start: false,
    keyboard: false,
    authenticator: false,
  });

  /**
   * False until storage has been read.
   *
   * Nothing auto-starts and nothing is saved before this: the defaults above
   * are all `false`, and acting on them would turn everything off on every
   * launch and then write that back.
   */
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      AsyncStorage.getItem(KEYS.start),
      AsyncStorage.getItem(KEYS.keyboard),
      AsyncStorage.getItem(KEYS.authenticator),
    ])
      .then(([start, keyboard, authenticator]) => {
        if (cancelled) return;
        setAutos({
          start: start === '1',
          keyboard: keyboard === '1',
          authenticator: authenticator === '1',
        });
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setAuto = useCallback((which: keyof BtAutos, value: boolean) => {
    setAutos(prev => ({...prev, [which]: value}));
    void AsyncStorage.setItem(KEYS[which], value ? '1' : '0');
  }, []);

  return {autos, setAuto, ready};
}
