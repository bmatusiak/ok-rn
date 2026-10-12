/*
 * The Password Manager's hooks: usePasswordManager for the Passwords screen, usePasswordWatch for
 * the part that must run while the tab is off screen. The rules live in stores.ts; this file is
 * when they run.
 *
 * One stores object for the whole app (module scope), so a store opened on the tab stays open
 * when the person switches tabs and comes back - the session is the key's, not the screen's.
 * Because it outlives the screen, closing it cannot be the screen's job either: usePasswordWatch
 * is mounted with the app and closes a key's store the moment that key stops being unlocked
 * (each key on its own - a hard key unplugged does not close the soft key's store), and runs the
 * reaper every 30 s and when the app comes back to the front, as CryptoScreen does for its vault.
 */

import {useCallback, useEffect, useRef, useState} from 'react';
import {AppState} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {getOnlyKey} from '../../onlykey';
import {createStores, LABEL, type Backend, type Manager, type Okcrypto, type OpenWhy} from './stores';

declare const crypto: {getRandomValues<T extends Uint8Array>(array: T): T};

const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export const stores = createStores({storage: AsyncStorage, randomBytes});

const REAP_MS = 30_000;
const BACKENDS: Backend[] = ['embedded', 'usb'];

/** The old vault's two calls the import uses (okcrypto.deviceVault). */
export type OldVault = {
  list(): Promise<{serviceId: string}[]>;
  load(serviceId: string, opts?: object): Promise<string | null>;
};

/** The derive a phrase needs (okcrypto.deriveSharedSecretFor). */
export type PhraseOkcrypto = {deriveSharedSecretFor(label: string, opts: object): Promise<Uint8Array>};

/** The parts of the capabilities reading this needs; null before one. */
export type PasswordCaps = {deviceVault?: boolean; touchFreeDerive?: string} | null | undefined;

const okcryptoOf = async (backend: Backend): Promise<Okcrypto> => (await getOnlyKey(backend)).okcrypto as Okcrypto;

/** Each key's cached okcrypto, for the synchronous lock and reap calls. */
const known = new Map<Backend, Okcrypto>();
async function remember(backend: Backend): Promise<Okcrypto> {
  const o = await okcryptoOf(backend);
  known.set(backend, o);
  return o;
}

/**
 * Mounted once, with the app. `unlocked`: each key's "is it unlocked and running" right now.
 */
export function usePasswordWatch(unlocked: Record<Backend, boolean>): void {
  const {embedded, usb} = unlocked;
  useEffect(() => {
    const before = stores.openCount();
    for (const b of BACKENDS) {
      if (!(b === 'embedded' ? embedded : usb)) {
        try {
          known.get(b)?.deviceVault.lock(LABEL);
        } catch {}
        stores.close(b);
      }
    }
    if (stores.openCount() !== before) notify();
  }, [embedded, usb]);

  useEffect(() => {
    /* only a store that actually closed is news: a screen showing the button must not re-run its
       * touch-free try every 30 s */
    const reap = () => {
      const before = stores.openCount();
      for (const [b, o] of known) {
        try {
          stores.reap(b, o);
        } catch {}
      }
      if (stores.openCount() !== before) notify();
    };
    const timer = setInterval(reap, REAP_MS);
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') reap();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, []);
}

/* screens listening for a store opening or closing elsewhere (a lock, the reaper, the other key) */
const listeners = new Set<() => void>();
/** A store's entries changed elsewhere (the Autofill sheet saved one): redraw the tab. */
export function storesChanged() {
  notify();
}
function notify() {
  for (const l of listeners) l();
}

export type ManagerView =
  | {state: 'unsupported'}
  | {state: 'locked-key'}
  | {state: 'checking'}
  | {state: 'button'; storeId: string; isNew: boolean}
  | {state: 'pressing'; storeId: string}
  | {state: 'open'; storeId: string; manager: Manager; why: OpenWhy}
  | {state: 'error'; message: string};

/**
 * The store of the ACTIVE key. On mount (the tab opens) it opens by itself when that needs no
 * press; otherwise it shows the button. `openWithKey` is the button. `pressAsked` is true while a
 * hard key waits for its press (the soft key's press shows on the app's own sheet).
 */
export function usePasswordManager({
  backend,
  unlocked,
  caps,
}: {
  backend: Backend;
  unlocked: boolean;
  caps: PasswordCaps;
}) {
  const [view, setView] = useState<ManagerView>({state: 'checking'});
  const [pressAsked, setPressAsked] = useState(false);
  const [rev, setRev] = useState(0);
  const busy = useRef(false);
  /* Lock now holds the store shut until the tab is opened again - a touch-free store would
   * otherwise open again on the spot, and Lock would do nothing */
  const held = useRef<string | null>(null);

  const supported = !caps || caps.deviceVault !== false;
  const touchFree = (caps?.touchFreeDerive ?? 'preference') as 'always' | 'preference' | 'broken';

  /* follow stores opened or closed elsewhere */
  useEffect(() => {
    const l = () => setRev(n => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);

  useEffect(() => {
    if (!supported) return setView({state: 'unsupported'});
    if (!unlocked) return setView({state: 'locked-key'});
    if (busy.current) return;
    const open = stores.current(backend);
    if (held.current && !open) return setView({state: 'button', storeId: held.current, isNew: false});
    if (open) {
      /*
       * Opened elsewhere (the Autofill sheet, the other key's tab): this screen still needs the
       * key's okcrypto for touch() - without it every tap on the list was refused, silently (the
       * Pixel, 2026-10-11, after a save from Chrome).
       */
      if (!known.has(backend)) void remember(backend).then(() => setRev(n => n + 1));
      setView(v => (v.state === 'open' && v.manager === open ? v : {state: 'open', storeId: stores.idFor(backend) ?? '', manager: open, why: 'session'}));
      return;
    }
    let live = true;
    busy.current = true;
    setView({state: 'checking'});
    (async () => {
      const o = await remember(backend);
      const storeId = await stores.identify(backend, o);
      const r = await stores.tryOpen(backend, o, {onKeepAlive: () => live && setPressAsked(true)});
      if (!live) return;
      if (r) setView({state: 'open', storeId, manager: r.manager, why: r.why});
      else setView({state: 'button', storeId, isNew: !(await stores.readMeta(storeId))});
    })()
      .catch(err => live && setView({state: 'error', message: String(err?.message ?? err)}))
      .finally(() => {
        busy.current = false;
        if (live) setPressAsked(false);
      });
    return () => {
      live = false;
    };
  }, [backend, unlocked, supported, touchFree, rev]);

  const openWithKey = useCallback(async () => {
    if (view.state !== 'button' || busy.current) return;
    busy.current = true;
    held.current = null;
    setView({state: 'pressing', storeId: view.storeId});
    try {
      const o = await remember(backend);
      const r = await stores.openWithKey(backend, o, {touchFree, onKeepAlive: () => setPressAsked(true)});
      setView({state: 'open', storeId: view.storeId, manager: r.manager, why: r.why});
      notify();
    } catch (err: any) {
      setView({state: 'error', message: String(err?.message ?? err)});
    } finally {
      busy.current = false;
      setPressAsked(false);
    }
  }, [backend, view, touchFree]);

  /** Call before each action on the open store: slides the session, false when it ran out. */
  const touch = useCallback((): boolean => {
    const o = known.get(backend);
    const ok = !!o && stores.touch(backend, o);
    if (!ok) notify();
    return ok;
  }, [backend]);

  const lockNow = useCallback(() => {
    held.current = stores.idFor(backend) ?? '';
    stores.lockNow(backend, b => known.get(b) ?? null);
    notify();
  }, [backend]);

  const retry = useCallback(() => setRev(n => n + 1), []);

  /** The old single-password vault of this key (CryptoScreen's), for the import. */
  const oldVault = useCallback(async () => (await remember(backend)).deviceVault as unknown as OldVault, [backend]);

  /*
   * For a derived phrase: this key's okcrypto, and the press flag its store was made with - a
   * phrase is derived with the same flag, so it opens wherever the store does (mnemonic.js).
   */
  const phraseKey = useCallback(async () => {
    const okcrypto = await remember(backend);
    const meta = await stores.readMeta(await stores.identify(backend, okcrypto));
    return {okcrypto: okcrypto as unknown as PhraseOkcrypto, press: meta ? meta.press : true};
  }, [backend]);

  return {view, pressAsked, openWithKey, touch, lockNow, retry, oldVault, phraseKey};
}
