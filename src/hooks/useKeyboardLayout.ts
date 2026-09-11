import {useCallback, useEffect, useState} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {device as okdevice} from 'node-onlykey-lib';

import {useBackend} from './KeyContext';
import type {Backend} from './keySession';

/**
 * Which keyboard layout the ACTIVE key types in, so what it types can be
 * decoded.
 *
 * THE KEY DOES NOT SAY. The layout is a preference written TO the device
 * (field KBDLAYOUT) and never readable back - OnlyKey has no "get
 * preferences". So the only way the app can decode a slot the key typed is to
 * remember what it last wrote, per key: the soft key and a hard key are
 * different devices with different settings, and one setting shared between
 * them would decode one of them wrongly the moment they differed.
 *
 * ## Why this mattered
 *
 * Nothing passed a layout to readSlot() or captureBackup(), so everything was
 * decoded as US English while the Preferences screen let you write any other
 * layout to the key. Harmless on the soft key, where the build compiles in two
 * tables and US is the default. On a HARD key every layout is compiled in, so
 * a key set to German typed German and the app read it back as confidently
 * wrong characters. See
 * FINDING-the-decode-layout-was-written-and-never-read.md.
 *
 * ## What is remembered
 *
 * The layout NAME the library uses for its decode tables (USA_ENGLISH, ...),
 * not the numeric id the firmware takes. The name is what createDecoder
 * wants, and the id is derivable from it; the reverse needs a table lookup
 * that would otherwise have to happen on every read.
 *
 * Unknown until the first look, and the firmware's default until told
 * otherwise: a key that was never written is typing US English.
 */
const STORAGE_PREFIX = 'ok-rn/keyboard-layout/';

/** The firmware's default, from the library's tables. */
export const DEFAULT_LAYOUT_NAME = 'USA_ENGLISH';

function storageKey(backend: Backend): string {
  return STORAGE_PREFIX + backend;
}

/** The library's layout name for a firmware layout id, or null. */
export function layoutNameForId(id: number): string | null {
  const hit = okdevice.keystrokes.layouts().find(l => l.id === id);
  return hit ? hit.name : null;
}

/** Remember which layout a key was just told to type in. */
export async function rememberLayout(backend: Backend, name: string): Promise<void> {
  await AsyncStorage.setItem(storageKey(backend), name);
}

export function useKeyboardLayout(): {
  /** The layout name for the decoder. Never null: the default stands in. */
  layout: string;
  /** False until the stored value has been read. */
  known: boolean;
  setLayout: (name: string) => Promise<void>;
} {
  const backend = useBackend();
  const [layout, setLayoutState] = useState(DEFAULT_LAYOUT_NAME);
  const [known, setKnown] = useState(false);

  useEffect(() => {
    let alive = true;
    setKnown(false);
    AsyncStorage.getItem(storageKey(backend))
      .then(stored => {
        if (!alive) return;
        setLayoutState(stored || DEFAULT_LAYOUT_NAME);
        setKnown(true);
      })
      .catch(() => {
        if (alive) setKnown(true);
      });
    return () => {
      alive = false;
    };
  }, [backend]);

  const setLayout = useCallback(
    async (name: string) => {
      setLayoutState(name);
      await rememberLayout(backend, name);
    },
    [backend],
  );

  return {layout, known, setLayout};
}
