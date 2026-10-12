/*
 * RECIPIENT SOURCES: the core app plugin through which a feature plugin offers people's public keys
 * to the screens that take one (Messages' recipient box), and takes a key a screen found to keep.
 * Guest Book is the first (GUEST-BOOK-SPEC.md: "Add from Guest Book", "Save to Guest Book").
 *
 * Core screens ask this list and never name a plugin: with Guest Book removed the list is empty
 * and its buttons simply are not drawn.
 */

export type RecipientKey = {
  /* the contact's name, and which of their keys */
  contact: string;
  label: string;
  /* the armored public key block (only public keys travel here) */
  text: string;
  /* the person compared the fingerprint out of band (spec: unverified ones say so plainly) */
  verified: boolean;
};

export type RecipientSource = {
  name: string;
  /** Every contact's PGP public key. */
  pgpKeys(): Promise<RecipientKey[]>;
  /** Keep a key a screen found (a look-up result) - adds a contact, or the key onto one. */
  save?(armored: string, label: string, from: {kind: string; handle: string}): Promise<string>;
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
