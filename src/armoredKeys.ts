/**
 * Several public keys in one box.
 *
 * The web app encrypts to a LIST of recipients — its encrypt page has a
 * tokeniser and you add people to it (onlykey.github.io encrypt.js) — and
 * this screen took one key. The library never had that limit:
 * `pgp_messages.readPublicKeys` accepts an array and has since it was
 * written. What was missing was the split, which is this file.
 *
 * Blocks are found by their armour headers rather than by splitting on
 * blank lines, because an armoured key contains plenty of those and a
 * person pasting two keys will not separate them the way a parser would
 * like.
 */

const BLOCK =
  /-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]*?-----END PGP PUBLIC KEY BLOCK-----/g;

/**
 * Every armoured public key in a string, in the order they appear.
 *
 * Returns [] for a box with none, which the caller reports rather than
 * sending nothing to the device.
 */
export function splitPublicKeys(text: string): string[] {
  return String(text || '').match(BLOCK) ?? [];
}

/** What a key says it is, for a person to check before using it. */
export type KeySummary = {
  /** Every user id on the key, "Name <mail>" as written. */
  users: string[];
  /** Uppercase hex, grouped in fours the way every PGP client prints it. */
  fingerprint: string;
  /** The primary key's algorithm, as openpgp names it. */
  algorithm: string;
  created: string;
};

/** Space a fingerprint into fours: 40 hex characters is unreadable in one run. */
function groupFingerprint(hex: string): string {
  return (hex.toUpperCase().match(/.{1,4}/g) ?? []).join(' ');
}

/**
 * Read what a key claims about itself.
 *
 * This is the panel the web app's search page shows beside a result — user
 * id, key id, fingerprint, type (search.js:137-196) — and the reason it
 * matters more here than there: a key fetched from Keybase or a URL by
 * pressing one button has had nothing verify it. The fingerprint is what a
 * person compares against the one they were given by some other route, and
 * a box of base64 cannot be compared with anything.
 *
 * `openpgp` is passed in because the fork is 1.2 MB and every screen that
 * needs it requires it lazily; this file must not drag it into a bundle by
 * importing it at the top.
 */
export async function summarizeKey(openpgp: any, armored: string): Promise<KeySummary> {
  const key = await openpgp.readKey({armoredKey: armored});
  const users: string[] = (key.users ?? [])
    .map((u: any) => String(u?.userID?.userID ?? '').trim())
    .filter(Boolean);
  const created = key.getCreationTime?.();
  return {
    users,
    fingerprint: groupFingerprint(key.getFingerprint()),
    algorithm: key.getAlgorithmInfo?.()?.algorithm ?? 'unknown',
    created: created ? new Date(created).toISOString().slice(0, 10) : '',
  };
}
