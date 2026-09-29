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


import {list, compatibilityOf} from 'node-onlykey-lib/versions';

/** The capabilities object the library returns, or null before a reading. */
type Capabilities =
  | {postQuantum?: boolean; hmacSha1?: boolean; deviceVault?: boolean}
  | null
  | undefined;

export type FirmwareFeature = 'postQuantum' | 'hmacSha1' | 'deviceVault';


/**
 * The oldest release that carries a feature - from node-onlykey-lib's
 * compatibility table, not written here.
 *
 * The table (node-onlykey-lib/versions) is the one record of what each release
 * supports: its rows are generated from the library's capabilities() and a lib
 * test fails if they drift. Writing "firmware 3.0.5 or newer" by hand in this
 * file was a second copy of that answer, and it went stale - it said no release
 * had post-quantum keys after the table gained 3.1.0, and named 3.0.5 after it
 * was dropped. Now a new row, or a dropped one, changes these sentences by
 * itself. v3.1.0 is the proposed release, treated there like a signed one.
 */
function oldestReleaseWith(feature: FirmwareFeature): string | null {
  for (const version of [...list()].reverse()) {      // oldest first
    const row = compatibilityOf(version);
    if (row && row.capabilities && row.capabilities[feature] === true) {
      return version.replace(/^v/, '');
    }
  }
  return null;
}

/** "firmware X or newer", or - if no release in the table has it - say so. */
function needsFirmware(feature: FirmwareFeature): string {
  const version = oldestReleaseWith(feature);
  return version ? `firmware ${version} or newer` : 'no released firmware has this yet';
}

/**
 * What each feature is called on screen, and the firmware that carries it
 * (from the table - see oldestReleaseWith).
 */
/* `is` or `are`: "The vault is", "Post-quantum keys are" - the sentences below name one. */
const FEATURES: Record<FirmwareFeature, {what: string; is: 'is' | 'are'; needs: string}> = {
  postQuantum: {
    what: 'Post-quantum keys',
    is: 'are',
    needs: needsFirmware('postQuantum'),
  },
  hmacSha1: {
    what: 'HMAC-SHA1 slot keys',
    is: 'are',
    needs: needsFirmware('hmacSha1'),
  },
  /*
   * NOT a limit of the firmware, unlike the two above, and the note says so
   * rather than implying an old key is incapable. A v3.0.4 key derives fine -
   * measured on a production build of the last signed release. What changed at
   * 3.0.5 is HOW a key is derived from a label, so anything sealed on older
   * firmware stops opening after an upgrade, silently and unrecoverably by the
   * obvious route. Offering it on older firmware would create data that a
   * later update strands, for a feature no released app has carried.
   */
  deviceVault: {
    what: 'The vault',
    is: 'is',
    needs:
      `${needsFirmware('deviceVault')} — older firmware can derive, but it ` +
      'derives differently, so anything sealed before would stop opening after ' +
      'the update',
  },
};

/**
 * Should this section work? True while nothing is known - see the header.
 *
 * There used to be a way to force one on (src/capabilityOverride.ts), for a
 * hard key whose working-tree build reported the same version as the release
 * it was ahead of. The working tree declares its own version (3.1.0 now), and the library
 * decides these by that version, so the lever was deleted.
 */
export function supports(caps: Capabilities, feature: FirmwareFeature): boolean {
  if (!caps) return true;
  return caps[feature] !== false;
}

/** The sentence a faded section shows, naming the feature and what it needs. */
export function missingNote(feature: FirmwareFeature): string {
  const {what, is, needs} = FEATURES[feature];
  return `${what} ${is} not on this key: ${needs}. Everything here is switched off.`;
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
  const {what, is} = FEATURES[feature];
  return (
    `${what} ${is} switched on because this key was told it has them, not ` +
    'because it said so. If the firmware does not, these will fail at the key. ' +
    'Advanced -> Capabilities turns it back off.'
  );
}
