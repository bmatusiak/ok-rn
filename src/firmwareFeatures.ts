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

/** Should this section work? True while nothing is known - see the header. */
export function supports(caps: Capabilities, feature: FirmwareFeature): boolean {
  if (!caps) return true;
  return caps[feature] !== false;
}

/** The sentence a faded section shows, naming the feature and what it needs. */
export function missingNote(feature: FirmwareFeature): string {
  const {what, needs} = FEATURES[feature];
  return `${what} are not on this key: ${needs}. Everything here is switched off.`;
}
