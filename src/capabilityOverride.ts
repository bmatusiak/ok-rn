import {useCallback, useEffect, useRef, useState} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {FirmwareFeature} from './firmwareFeatures';

/**
 * Forcing a capability on, because detection cannot see an unsigned build.
 *
 * ## Why this exists
 *
 * The firmware's version macros have read 3/0/4 since 2022, so a working-tree
 * build and released v3.0.4 report the same status string. The library told
 * them apart by the build KEYWORD - `-test` is the development line, `-prod` a
 * release - and building the working tree as production defeats that:
 * `v3.0.4-prodc` is byte-identical to the release while carrying post-quantum
 * work no release has. The screens then fade features the firmware does have.
 *
 * The real fix is for the firmware to report its own provenance, which is
 * asked for in FIRMWARE-SPEC-okgetbuild.md and is the maintainer's decision.
 * This is the lever until then: it lets unsigned firmware be used by telling
 * the app what the wire cannot.
 *
 * It does NOT fix detection. The default stays wrong and every section stays
 * faded until somebody switches it on by hand. That is the trade - a lever is
 * honest about being pulled, where a guess is not.
 *
 * ## It is built to be deleted
 *
 * Set ALLOW_OVERRIDE to false and the panel, the store and every override path
 * become dead code. Delete this file and the Advanced section to remove it
 * outright. Nothing else depends on it: `supports()` ignores an override it is
 * not given.
 */
export const ALLOW_OVERRIDE = true;

/** Which key the overrides belong to. They are never shared between them. */
export type OverrideScope = 'soft' | 'hard';

export type Overrides = Partial<Record<FirmwareFeature, true>>;

/**
 * FORCE-ON ONLY. There is deliberately no force-off.
 *
 * Forcing a feature off would hide one that works, which nothing here needs,
 * and every extra direction is another state that has to be explained on
 * screen and reasoned about when something behaves oddly.
 */
const KEY = 'ok-rn/caps/soft';

/**
 * Overrides for one key.
 *
 * ## The soft key remembers; a hard key does not
 *
 * The soft key's firmware is staged by this build. It cannot be swapped
 * underneath us, so an override that survives a restart still describes the
 * thing it was set for - and a restart is how this app logs out, so losing it
 * every time would make the switch useless.
 *
 * A HARD key is a physical object that can be unplugged and replaced by a
 * DIFFERENT one. An override that survived that would quietly tell the app
 * that an unrelated device supports something it does not, which is worse than
 * the faded section it was set to fix. So a hard key's overrides live in
 * memory and are dropped by `clear()` - which the caller wires to the same
 * moments useHardKey already forgets the key's capabilities.
 */
export function useCapabilityOverrides(scope: OverrideScope) {
  const [overrides, setOverrides] = useState<Overrides>({});

  /* Reads the live value from callbacks that were created before it changed. */
  const current = useRef<Overrides>({});
  current.current = overrides;

  useEffect(() => {
    /*
     * RESET FIRST, on every scope change. Switching from the soft key to a
     * hard one must not carry the soft key's overrides across - they describe
     * a different device, which is the whole reason a hard key does not
     * persist them.
     */
    setOverrides({});
    if (!ALLOW_OVERRIDE || scope !== 'soft') return;
    let alive = true;
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(KEY);
        if (alive && raw) setOverrides(JSON.parse(raw) as Overrides);
      } catch {
        /* Unreadable or absent is simply no override. */
      }
    })();
    return () => {
      alive = false;
    };
  }, [scope]);

  const persist = useCallback(
    (next: Overrides) => {
      setOverrides(next);
      if (scope !== 'soft') return;
      void AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {});
    },
    [scope],
  );

  const setOverride = useCallback(
    (feature: FirmwareFeature, on: boolean) => {
      if (!ALLOW_OVERRIDE) return;
      const next = {...current.current};
      if (on) next[feature] = true;
      else delete next[feature];
      persist(next);
    },
    [persist],
  );

  /** Forget everything. For a hard key, called wherever the key goes away. */
  const clear = useCallback(() => {
    if (Object.keys(current.current).length === 0) return;
    persist({});
  }, [persist]);

  return {overrides: ALLOW_OVERRIDE ? overrides : {}, setOverride, clear};
}
