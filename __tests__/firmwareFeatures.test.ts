/**
 * Fading a section is a claim about someone's hardware, so it has to be right
 * in both directions.
 *
 * Saying "your firmware is too old" to a key that simply has not finished
 * connecting is a lie the person cannot check. Leaving a section bright on a
 * key that genuinely lacks the feature is worse: the buttons work, and the
 * failure arrives from the device as a refusal or as silence.
 *
 * The library decides WHAT the firmware has, from the version it announced,
 * and its own tests pin that against the firmware sources. These tests pin
 * the other half - when a screen is entitled to act on that answer.
 */
import {supports, missingNote} from '../src/firmwareFeatures';
import {device as deviceLib} from 'node-onlykey-lib';

describe('supports', () => {
  it('treats a key that has not spoken as capable, not as old', () => {
    /*
     * The library answers false for unknown, deliberately: it is asked "may I
     * send this" and silence means no. A screen asks a different question and
     * must not answer it from the same silence.
     */
    expect(supports(null, 'postQuantum')).toBe(true);
    expect(supports(undefined, 'postQuantum')).toBe(true);
  });

  it('fades only on an explicit no', () => {
    expect(supports({postQuantum: false}, 'postQuantum')).toBe(false);
    expect(supports({postQuantum: true}, 'postQuantum')).toBe(true);
    /* A capabilities object from an older library that lacks the key at all. */
    expect(supports({}, 'postQuantum')).toBe(true);
  });

  it('reads the real capabilities object the library builds', () => {
    /*
     * Not a hand-made shape: the actual answer for the two versions that
     * matter. v3.0.2 is the newest RELEASE and has no post-quantum support at
     * all, so a person with a key from a box sees the faded section.
     */
    const shipped = deviceLib.version.capabilities('UNLOCKEDv3.0.2c');
    const bench = deviceLib.version.capabilities('UNLOCKEDv3.0.4-testc');

    expect(supports(shipped, 'postQuantum')).toBe(false);
    expect(supports(bench, 'postQuantum')).toBe(true);

    /* HMAC-SHA1 is the older boundary, and v3.0.2 is past it. */
    expect(supports(shipped, 'hmacSha1')).toBe(true);
    expect(supports(deviceLib.version.capabilities('UNLOCKEDv2.1.1c'), 'hmacSha1')).toBe(false);
  });
});

describe('missingNote', () => {
  it('names the feature and what it needs, without blaming the user', () => {
    const note = missingNote('postQuantum');
    expect(note).toContain('Post-quantum keys');
    expect(note).toContain('no released firmware');
    /* It says what the state of the section is, so a faded box is not a puzzle. */
    expect(note).toContain('switched off');
  });

  it('gives a version for a feature that has one', () => {
    expect(missingNote('hmacSha1')).toContain('3.0.0');
  });
});
