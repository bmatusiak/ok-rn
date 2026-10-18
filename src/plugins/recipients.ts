/*
 * RECIPIENT SOURCES: the core app plugin through which a feature plugin offers the people whose
 * public keys a screen can use (Encrypt / Decrypt: who to encrypt to, who signed a message).
 * Guest Book is the one (Brad, 2026-10-18: "guestbook will be how we get and store pubkey, and
 * encrypt/decrypt uses guestbook" - people trade keys in Guest Book, then use them here).
 *
 * Core screens ask this list and never name a plugin: with Guest Book removed the list is empty
 * and Encrypt / Decrypt says there is nobody to pick.
 */

export type RecipientKey = {
  /* which of the person's keys (its label in their Guest Book entry) */
  label: string;
  /* the armored public key block (only public keys travel here) */
  text: string;
  /* the person compared its fingerprint out of band (unverified ones say so plainly) */
  verified: boolean;
  /* a composite (+PQC) PGP key: post-quantum and classic halves together */
  composite: boolean;
};

export type RecipientContact = {
  id: string;
  name: string;
  /* their usable PGP keys - a revoked one is never offered */
  keys: RecipientKey[];
};

export type RecipientSource = {
  name: string;
  /**
   * YOU, as a person to pick (Brad, 2026-10-18: "we should be able to encrypt or decrypt for our
   * self, our own ME keys"): your own PGP public keys, so a message can be encrypted to you and
   * opened with your key, and your own signature is named. null when you have none.
   */
  me(): Promise<RecipientContact | null>;
  /** Every person with at least one usable PGP public key, sorted by name. */
  pgpContacts(): Promise<RecipientContact[]>;
  /**
   * Check ONE person's keys at their sources, now (Brad, 2026-10-18: refresh "only ... on a
   * single contact, with a button press, or if i select the contact to use to encrypt or
   * decrypt"). Returns the change lines; a changed key waits for approval in the source.
   */
  refresh(contactId: string): Promise<string[]>;
};

export type RecipientsService = {
  add(source: RecipientSource): void;
  list(): readonly RecipientSource[];
};

export default function setup(_imports: unknown, register: (err: Error | null, services: {recipients: RecipientsService}) => void) {
  const sources: RecipientSource[] = [];
  register(null, {
    recipients: {
      add(source) {
        if (sources.some(s => s.name === source.name)) throw new Error(`app plugins: two recipient sources named ${source.name}`);
        sources.push(source);
      },
      list: () => sources.slice(),
    },
  });
}
setup.consumes = [] as string[];
setup.provides = ['recipients'];
