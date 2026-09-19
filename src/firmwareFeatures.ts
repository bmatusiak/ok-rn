/**
 * What the attached key's firmware can actually do, for the screens.
 *
 * The library measures this - `device.version.capabilities()` reads the
 * version the key announced and answers per feature, with the evidence for
 * each flag written beside it. This file is the thin layer between that and a
 * screen: it decides when to FADE, and it writes the one sentence that says
 * why, so two screens cannot end up explaining the same absence differently.
 *
 * ## Unknown is not the same as absent
 *
 * The library's flags answer false when the key has not said what it is,
 * which is the right default there: it is asked "may I send this", and the
 * safe answer with nothing known is no.
 *
 * A screen is asking something else - "should I grey this out and tell the
 * person their firmware is too old" - and answering that from silence is a
 * lie. A key that has not connected yet, or is locked and announcing
 * INITIALIZED with no version at all, is not an old key. So `supports()`
 * returns true while nothing is known, and the section stays normal until
 * there is a reading to fade it on.
 */

import {ALLOW_OVERRIDE, type Overrides} from './capabilityOverride';

/** The capabilities object the library returns, or null before a reading. */
type Capabilities = {postQuantum?: boolean; hmacSha1?: boolean} | null | undefined;

export type FirmwareFeature = 'postQuantum' | 'hmacSha1';


/**
 * What each feature is called on screen, and the firmware that carries it.
 *
 * The post-quantum line is the one worth reading twice. Every post-quantum
 * path - composite PGP keys, X-Wing age identities, ML-KEM keys in a slot -
 * was measured absent from EVERY released firmware, up to and including
 * v3.0.2: okpqc.cpp does not exist at any pinned release, and neither
 * KEYTYPE_MLKEM768 nor KEYTYPE_XWING is in okcore.h at any of them. So this
 * is not an old-firmware warning that a few people will see. Anyone holding a
 * key that came in a box sees it, and will until a release ships with it.
 */
const FEATURES: Record<FirmwareFeature, {what: string; needs: string}> = {
  postQuantum: {
    what: 'Post-quantum keys',
    needs:
      'no released firmware has them yet — they are in the development line ' +
      'the bench keys run',
  },
  hmacSha1: {
    what: 'HMAC-SHA1 slot keys',
    needs: 'firmware 3.0.0 or newer',
  },
};

/**
 * Should this section work? True while nothing is known - see the header.
 *
 * `overrides` is the one place a forced capability is honoured, so every
 * screen gets the same answer without any of them knowing the override exists.
 * Omitting it is the same as having none - the e2e suites and any caller that
 * does not care are unaffected. See src/capabilityOverride.ts.
 */
export function supports(
  caps: Capabilities,
  feature: FirmwareFeature,
  overrides?: Overrides,
): boolean {
  if (ALLOW_OVERRIDE && overrides?.[feature]) return true;
  if (!caps) return true;
  return caps[feature] !== false;
}

/** Whether this section is open because somebody forced it, not because it was detected. */
export function isForced(
  caps: Capabilities,
  feature: FirmwareFeature,
  overrides?: Overrides,
): boolean {
  if (!ALLOW_OVERRIDE || !overrides?.[feature]) return false;
  /* Only "forced" when detection actually said no. */
  return Boolean(caps) && caps![feature] === false;
}

/** The sentence a faded section shows, naming the feature and what it needs. */
export function missingNote(feature: FirmwareFeature): string {
  const {what, needs} = FEATURES[feature];
  return `${what} are not on this key: ${needs}. Everything here is switched off.`;
}

/**
 * The sentence a section shows when it is open only because it was FORCED.
 *
 * A forced section must not look like a detected one. If the firmware really
 * does lack the feature, the operation fails at the device - so the screen
 * says where the answer came from, rather than letting a silent refusal later
 * be the first hint.
 */
export function forcedNote(feature: FirmwareFeature): string {
  const {what} = FEATURES[feature];
  return (
    `${what} are switched on because this key was told it has them, not ` +
    'because it said so. If the firmware does not, these will fail at the key. ' +
    'Advanced -> Capabilities turns it back off.'
  );
}
