import type {RecipientContact} from './plugins/recipients';

/*
 * WHO SIGNED A MESSAGE, named from Guest Book (Brad, 2026-10-18: encrypt / decrypt "uses
 * guestbook"). Decrypt and Verify check a signature against everyone's PGP keys and name the
 * person whose key made it - nobody types or pastes the signer's key any more.
 */

/* who a signature's key belongs to, by key id (lower-case hex) */
export type Signer = {id: string; name: string; verified: boolean};

/* every key id (primary and subkeys) of everyone's PGP keys -> who holds it */
export async function indexSigners(openpgp: any, people: RecipientContact[]): Promise<Map<string, Signer>> {
  const out = new Map<string, Signer>();
  for (const p of people) {
    for (const k of p.keys) {
      try {
        const key = await openpgp.readKey({armoredKey: k.text});
        for (const id of key.getKeyIDs()) out.set(String(id.toHex()).toLowerCase(), {id: p.id, name: p.name, verified: k.verified});
      } catch {
        /* a key the fork cannot read names nobody */
      }
    }
  }
  return out;
}

/*
 * WHO SIGNED IT, by the signature's key id. A signature from someone in Guest Book names them (and
 * says when their key is not verified); one from a key nobody in Guest Book holds says so - its
 * maker is unknown here, not proven wrong. '' when there is no signature at all.
 */
export function signedBy(signatures: Array<{keyID: string; valid: boolean; error: string | null}>, signers: Map<string, Signer>): string {
  if (!signatures || !signatures.length) return '';
  return signatures
    .map(s => {
      const who = signers.get(String(s.keyID).toLowerCase());
      if (!who) return `Signed by a key that is not in your Guest Book (key id ${String(s.keyID).toUpperCase()}).`;
      if (!s.valid) return `The signature from ${who.name} is NOT valid${s.error ? `: ${s.error}` : ''}.`;
      return who.verified ? `Signed by ${who.name} ✓.` : `Signed by ${who.name} - their key is not verified in Guest Book.`;
    })
    .join(' ');
}


/* the person who made the first GOOD signature, or null (unsigned, a bad signature, or a key nobody in Guest Book holds) - where Cryptobox files an imported message */
export function signerOf(signatures: Array<{keyID: string; valid: boolean}>, signers: Map<string, Signer>): Signer | null {
  for (const s of signatures || []) {
    const who = signers.get(String(s.keyID).toLowerCase());
    if (who && s.valid) return who;
  }
  return null;
}
