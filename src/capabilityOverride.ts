import {useCallback, useRef, useState} from 'react';
import type {FirmwareFeature} from './firmwareFeatures';

/**
 * Forcing a capability on, for a key whose firmware this app did not build.
 *
 * ## Why this is only for hard keys
 *
 * The soft key needs nothing like this. Its firmware is staged by this build,
 * so the app already knows whether the sources were a pinned release or the
 * working tree - stage.js writes `unreleased` into the build info and
 * capabilities() takes it. A working-tree build simply HAS its features on,
 * with nothing to switch.
 *
 * A hard key is the case that cannot be answered that way. It arrives with
 * whatever firmware somebody flashed onto it, and if that is an unsigned
 * working-tree build it reports the same version string as the release it is
 * ahead of. Nothing on the wire distinguishes them, so the only honest source
 * left is a person saying "I know what I put on this key".
 *
 * FIRMWARE-SPEC-okgetbuild.md asks the firmware to report its own build, which
 * would remove even this. Until then it is a lever, and a lever is at least
 * honest about being pulled.
 *
 * ## It is built to be deleted
 *
 * Set ALLOW_OVERRIDE to false and the panel and every override path become
 * dead code. Delete this file and the Advanced section to remove it outright:
 * `supports()` ignores an override it is not given.
 */
export const ALLOW_OVERRIDE = true;

export type Overrides = Partial<Record<FirmwareFeature, true>>;

/**
 * Overrides for the attached hard key. FORCE-ON ONLY.
 *
 * Forcing a feature off would hide one that works, which nothing needs, and
 * every extra direction is another state to explain on screen.
 *
 * ## Never persisted, and that is the safety property
 *
 * A hard key can be unplugged and a DIFFERENT one plugged in. An override that
 * outlived the first would quietly tell the app that an unrelated device
 * supports something it does not - worse than the faded section it was set to
 * fix, because the failure then happens at the key with no explanation.
 *
 * So this lives in memory and `clear()` is wired to the moments useHardKey
 * already forgets the key's capabilities (useHardKey.ts:146,159 - detach and
 * disconnect). It is re-armed after the next unlock, which is when the app
 * knows which key it is talking to again.
 */
export function useCapabilityOverrides() {
  const [overrides, setOverrides] = useState<Overrides>({});

  /* Read by callbacks created before the latest value existed. */
  const current = useRef<Overrides>({});
  current.current = overrides;

  const setOverride = useCallback((feature: FirmwareFeature, on: boolean) => {
    if (!ALLOW_OVERRIDE) return;
    const next = {...current.current};
    if (on) next[feature] = true;
    else delete next[feature];
    setOverrides(next);
  }, []);

  /** Forget everything. Called wherever the key goes away. */
  const clear = useCallback(() => {
    if (Object.keys(current.current).length === 0) return;
    setOverrides({});
  }, []);

  return {overrides: ALLOW_OVERRIDE ? overrides : {}, setOverride, clear};
}
