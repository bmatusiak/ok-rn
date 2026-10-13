import {formats} from 'node-onlykey-lib/guestbook';
import {readKeyChainList} from '../../keyChainRecorder';
import {CONTACT_LABEL} from './swapLink';

/* the lib's Key Chain plugin, as the Key Chain tab loads it */
const keychain = require('node-onlykey-lib/keychain');

/*
 * MY CARD (GUEST-BOOK-SPEC.md, "My keys, one tap away"; Brad, 2026-10-12: "like in android/ios it
 * shows your contact info at the top before any other contacts, so you can quickly share from
 * there"): your PUBLIC keys, read from Key Chain's public-only list on this net, each in the forms
 * people paste - the PGP certificate, an authorized_keys line, an age recipient.
 *
 * Key Chain's list holds no private key by construction (keychain/src/list.js refuses one), and
 * every form shown here passes Guest Book's guard once more before it is shown - public only.
 */

export type MyKey = {id: string; title: string; format: 'PGP' | 'SSH' | 'age'; text: string};

/** A Key Chain entry's name, for the row: its label, its slot, or its key type. */
function nameOf(e: any): string {
  /* a composite key is a PGP identity: its user id names it better than its slot */
  if (e.kind === 'slot') return e.type === 'composite' && e.name ? e.name : `slot ${e.slot}`;
  return e.label || e.name || e.type;
}

export async function readMyCard(): Promise<MyKey[]> {
  const entries: any[] = await readKeyChainList();
  const out: MyKey[] = [];
  for (const e of entries) {
    /*
     * A derive the recorder saw without its label (keyChainRecorder: "hash:<labelHash>") is a key
     * a website or tool made for itself - nobody shares those, and dozens would bury the card.
     */
    if (!e.name && String(e.label || '').startsWith('hash:')) continue;
    /* the swap's own identity: the other phone learns it in the handshake, it is not a key to give (Brad, 2026-10-12: hide it) */
    if (e.kind === 'derived' && e.label === CONTACT_LABEL) continue;
    const name = nameOf(e);
    /* X-Wing and the composite PGP key resist a quantum computer (Key Chain's quantum-safe keys): said in the title */
    const pq = e.type === 'xwing' || e.type === 'composite' ? ' (quantum-safe)' : '';
    if (e.pgp) out.push({id: `${e.id}:pgp`, title: `${name} - PGP${pq}`, format: 'PGP', text: e.pgp});
    let forms: any = null;
    try {
      forms = e.publicKey ? keychain.artifacts.forKey({type: e.type, publicKey: e.publicKey, comment: name}) : null;
    } catch {
      forms = null; /* a key type with no shareable form (raw only) */
    }
    if (forms?.ssh) out.push({id: `${e.id}:ssh`, title: `${name} - SSH`, format: 'SSH', text: forms.ssh});
    if (forms?.age) out.push({id: `${e.id}:age`, title: `${name} - age${pq}`, format: 'age', text: forms.age});
  }
  /* public only, checked here too: a form that somehow carries private text is not shown */
  return out.filter(k => {
    try {
      formats.refusePublicOnly(k.text);
      return true;
    } catch {
      return false;
    }
  });
}
