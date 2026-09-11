import React, {createContext, useCallback, useContext, useMemo} from 'react';

import {getOnlyKey, type OnlyKeyApp} from '../onlykey';
import {BACKEND_NAME, type Backend} from './keySession';

/**
 * WHICH KEY THE REST OF THE APP IS TALKING TO.
 *
 * `getOnlyKey(backend)` takes the backend as a defaulted argument, which was the
 * right shape for the library seam - a call site cannot silently get the wrong
 * device, and the default kept every existing caller meaning what it meant.
 *
 * What that left behind was a screen problem. Around twenty call sites across a
 * dozen files call `getOnlyKey()` with no argument, so they all default to the
 * soft key - and once the app could SELECT a key, the header would say Hard Key
 * while the Slots screen read the soft one's slots and the Crypto screen derived
 * the soft one's secrets. Not an ambiguous label: a confidently wrong answer,
 * and derived secrets differ per key, so a vault sealed under the wrong header
 * is sealed to the wrong device.
 *
 * ## Why a context rather than a module-level setter
 *
 * A setter makes correctness depend on call ordering across a React tree, and
 * getting it wrong hands a caller the soft key answering questions about the
 * hard one. That objection was the reason `getOnlyKey` takes an argument in the
 * first place.
 *
 * A context does not have it: the provider WRAPS the tree, so anything that can
 * read it is already inside a render where the value is settled. And unlike
 * threading a parameter through twenty call sites, a screen that forgets to use
 * it is a screen that still says `getOnlyKey()` - which is greppable, rather
 * than a missing argument that silently defaults.
 */
const KeyBackendContext = createContext<Backend>('embedded');

export function KeyBackendProvider({
  backend,
  children,
}: {
  backend: Backend;
  children: React.ReactNode;
}) {
  return (
    <KeyBackendContext.Provider value={backend}>
      {children}
    </KeyBackendContext.Provider>
  );
}

/** Which key is active. For a component that needs to SAY so. */
export function useBackend(): Backend {
  return useContext(KeyBackendContext);
}

/**
 * The active key's NAME, for a panel title.
 *
 * A PANEL DESCRIBING DEVICE STATE MUST NAME THE DEVICE. "12 slots, 3
 * configured" is a different fact about each key, and the header that says
 * which one is active scrolls away. The naming pass found this on the
 * Testing tab first; this is the one place the name comes from, so a panel
 * cannot spell it differently from the header.
 */
export function useKeyName(): string {
  return BACKEND_NAME[useContext(KeyBackendContext)];
}

/**
 * The library app for the ACTIVE key.
 *
 * Use this instead of importing `getOnlyKey` in a screen. It is a function
 * rather than the app itself because building one is asynchronous and most
 * callers want it inside an event handler, not during render.
 *
 * The identity changes when the backend does, so a `useCallback` that closes
 * over it and lists it as a dependency re-binds to the new key rather than
 * holding the old one - which is the failure this exists to prevent, arriving
 * one level down.
 */
export function useActiveKey(): () => Promise<OnlyKeyApp> {
  const backend = useContext(KeyBackendContext);
  return useCallback(() => getOnlyKey(backend), [backend]);
}

/**
 * Both, for the rare caller that needs to name the key it is about to use.
 *
 * Returned together so a screen cannot read one and act on the other.
 */
export function useActiveKeyWithBackend(): {
  backend: Backend;
  getKey: () => Promise<OnlyKeyApp>;
} {
  const backend = useContext(KeyBackendContext);
  const getKey = useCallback(() => getOnlyKey(backend), [backend]);
  return useMemo(() => ({backend, getKey}), [backend, getKey]);
}
