import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {theme} from '../../ui/theme';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const keychain = require('node-onlykey-lib/keychain');

/*
 * KEY CHAIN'S SHARED WORDS AND TABLES - one copy, used by the Key Chain
 * screen's "+ Add" panel and by its Wizard, so the two never describe the
 * same key or slot differently.
 */

export type Probe = {slot: number; kind: string; bits?: number; publicKey?: Uint8Array; label: string};
export type Entry = {
  id: string;
  kind: 'slot' | 'derived' | 'external';
  type: string;
  label?: string;
  name?: string;
  scheme?: string;
  slot?: number;
  publicKey: Uint8Array;
  artifacts: {hex: string; base64: string; ssh?: string; age?: string};
  /* an armored PGP public key block, when the entry is a PGP key */
  pgp?: string;
  /* the OnlyKey slots this entry stands for (a key made or loaded there) - what the remove Wizard wipes */
  slots?: number[];
};
/*
 * pgp: on the SIGNING key of a "PGP inside the Key" pair - the user id its
 * certificate is built for after the restart (KeyChainScreen buildPgp). Public
 * data only, like the rest of a job.
 */
/*
 * op 'wipe': destroy the key in the slot instead of making one (the remove
 * Wizard, KeyChainRemove). type/tag then describe what is there now. When the
 * wipe is written, removeEntry / removeCopies leave the App with it - not
 * before, so a wipe that is never written takes nothing with it.
 */
export type Job = {
  slot: number;
  type: DeviceType | 'rsa';
  tag: string | null;
  /* on the signing key of a PGP pair: who it is for, and which slot holds its decryption key */
  pgp?: {userId: string; ecdhSlot?: number};
  op?: 'wipe';
  removeEntry?: string | null;
  removeCopies?: string[];
};

/* What the remove Wizard is removing: the App's entry, the OnlyKey's slots it stands for, its encrypted copies. */
export type RemoveTarget = {
  title: string;
  entryId: string | null;
  derived: boolean;
  /* the label tag's kind (pgp, ssh, age, sig...) - decides what the Wizard says breaks */
  kind: string | null;
  slots: {slot: number; kind: string; label: string}[];
  copies: {id: string; title: string}[];
};
export type DeviceType = 'ed25519' | 'p256' | 'secp256k1' | 'x25519' | 'xwing' | 'mlkem768';
export type HostType = 'ed25519' | 'p256' | 'secp256k1' | 'x25519' | 'rsa';

export const SLOTS = [1, 2, 3, 4, ...Array.from({length: 16}, (_, i) => 101 + i)];
export const slotName = (n: number) => (n <= 4 ? `RSA${n}` : `ECC${n - 100}`);
/* What the OnlyKey can make, how it is written, and what it is usually for. */
export const DEVICE_TYPES: {type: DeviceType; title: string; ecc?: number; pq?: number; use?: string; kinds: string[]}[] = [
  {type: 'ed25519', title: 'Ed25519', ecc: 1, use: 'signature', kinds: ['ssh', 'sig']},
  {type: 'p256', title: 'P-256', ecc: 2, use: 'signature', kinds: ['ssh', 'sig']},
  {type: 'secp256k1', title: 'secp256k1', ecc: 3, use: 'signature', kinds: ['sig']},
  {type: 'x25519', title: 'X25519', ecc: 4, use: 'decryption', kinds: ['age', 'enc']},
  {type: 'xwing', title: 'X-Wing', pq: 6, kinds: ['xwg']},
  {type: 'mlkem768', title: 'ML-KEM', pq: 5, kinds: ['mlk']},
];
export const KIND_TITLE: Record<string, string> = {
  ssh: 'SSH', sig: 'Signing', age: 'age', enc: 'Encryption', xwg: 'age (post-quantum)', mlk: 'ML-KEM',
};

/*
 * WHAT EACH CHOICE MEANS, said under it (owner: "the buttons are just buttons
 * with no explanation"). One table for the panel and the Wizard, so the two
 * never describe the same key differently.
 */
export const TYPE_INFO: Record<string, string> = {
  ed25519: 'Ed25519 — a modern signing key: SSH logins and signatures. Small and fast.',
  p256: 'P-256 (NIST, ECDSA) — a signing key for systems that require the NIST curve.',
  secp256k1: 'secp256k1 — the signing curve Bitcoin and Ethereum use.',
  x25519: 'X25519 — an encryption key: others encrypt to it (age files); only the key can open them.',
  xwing: 'X-Wing — post-quantum encryption (ML-KEM + X25519): files sent to it stay safe against future quantum computers.',
  mlkem768: 'ML-KEM-768 — a bare post-quantum encryption key, for tools that use ML-KEM directly.',
  rsa: 'RSA — the classic key: PGP, older SSH servers, signing Android apps. The key cannot make RSA, so the App does.',
};
export const KIND_INFO: Record<string, string> = {
  ssh: 'SSH — you get a line to paste into a server\'s authorized_keys.',
  sig: 'Signing — a plain signing key, for tools that ask for one.',
  age: 'age — you get an age1… recipient: anyone can encrypt a file to it.',
  enc: 'Encryption — a plain encryption key.',
  xwg: 'age, post-quantum — you get an age1onlykey… recipient.',
  mlk: 'ML-KEM — the raw public key, for tools that use it.',
};
export const SCHEME_INFO: Record<string, string> = {
  Label: 'From any label, e.g. a website: the same label always gives the same key. Used for per-site keys and the vault.',
  SSH: 'The key an SSH login through this OnlyKey uses for user@host — paste it into the server\'s authorized_keys.',
  GPG: 'The key GPG through this OnlyKey uses for a user ID, e.g. "Alice <alice@example.org>".',
};
/*
 * WHAT A SLOT IS ALREADY USED FOR by the other OnlyKey apps (owner asked:
 * "is a slot limited to certain functions?"). The firmware does not limit
 * slots - a key's own use flags do (okcrypto.cpp:202/525) - but the web app,
 * the desktop App and the lib's loadPgpKey decrypt PGP with slot 1 and sign
 * with slot 2 (ECC1/ECC2 for an ECC PGP key; crypto/classic_pgp.js). A key put
 * there for anything else gets picked up by those PGP pages, so the slot says
 * so and goes to the end of the list for anything that is not PGP.
 * (The device's backup key is a slot too, but no command reports which, so it
 * is not shown rather than guessed.)
 */
/* A key label as people read it: a tag "sig:apk" is "apk · Signing"; anything else as written. */
export const labelText = (label: string) => {
  const tag = keychain.tag.parseTag(label);
  return tag ? `${tag.name} · ${KIND_TITLE[tag.kind] || tag.kind}` : label;
};

/* The PGP pages' slots: decrypt with 1 (ECC1), sign with 2 (ECC2). */
export const PGP_ROLE: Record<number, 'decrypt' | 'sign'> = {1: 'decrypt', 2: 'sign', 101: 'decrypt', 102: 'sign'};

/*
 * What happens to THIS key in THAT slot, in one sentence - the owner's rule
 * for the Wizard: help the user understand what will happen if it is placed
 * there. `use` is the key's own use flag (the firmware refuses anything
 * else): signing for SSH / signing / RSA keys, decryption for X25519, X-Wing
 * and ML-KEM.
 */
export function slotOutcome(n: number, use: 'signature' | 'decryption'): {text: string; warn: boolean} {
  const role = PGP_ROLE[n];
  if (!role) return {text: 'Only used when you ask for this key — nothing else picks it up.', warn: false};
  if (role === 'decrypt') {
    return use === 'decryption'
      ? {text: 'PGP pages (web app, desktop App) will decrypt your PGP messages with this key.', warn: true}
      : {text: 'PGP pages will try to DECRYPT with this key and it will refuse — it is a signing key. Pick another slot.', warn: true};
  }
  return use === 'signature'
    ? {text: 'PGP pages (web app, desktop App) will SIGN your PGP messages with this key — it becomes your PGP signing key.', warn: true}
    : {text: 'PGP pages will try to SIGN with this key and it will refuse — it is an encryption key. Pick another slot.', warn: true};
}
/* Slots nothing else uses first, then the PGP slots, then slots that hold a key. */
export const slotOrder = (n: number, taken: (n: number) => boolean) => (taken(n) ? 2 : PGP_ROLE[n] ? 1 : 0);

/* One choice in the Wizard: what it is, and a sentence on what it means. */
export function Choice({
  title,
  info,
  selected,
  onPress,
  outcome,
}: {
  title: string;
  info: string;
  selected: boolean;
  onPress: () => void;
  outcome?: {text: string; warn: boolean};
}) {
  return (
    <Pressable onPress={onPress} style={[styles.choice, selected ? styles.choiceOn : null]}>
      <Text style={styles.choiceTitle}>{title}</Text>
      <Text style={styles.note}>{info}</Text>
      {outcome ? <Text style={outcome.warn ? styles.outcomeWarn : styles.outcomeOk}>{outcome.text}</Text> : null}
    </Pressable>
  );
}


/*
 * WHAT IS HAPPENING, step by step (owner: "is it possible to get progress
 * bar feedback?"). Done steps ticked, the current one with a bar when it can
 * say how far it has got (the copy's passphrase stretching can), the rest
 * still to come.
 */
export type Progress = {stages: string[]; at: number; pct: number | null};

export function ProgressList({progress}: {progress: Progress}) {
  return (
    <View style={styles.progress}>
      {progress.stages.map((stage, i) => {
        const done = i < progress.at;
        const now = i === progress.at;
        return (
          <View key={stage} style={styles.stage}>
            <Text style={done ? styles.stageDone : now ? styles.stageNow : styles.stageLater}>
              {done ? '✓' : now ? '◐' : '○'}  {stage}{now && progress.pct !== null ? `  ${Math.round(progress.pct * 100)}%` : now ? '…' : ''}
            </Text>
            {now && progress.pct !== null ? (
              <View style={styles.barTrack}>
                <View style={[styles.barFill, {width: `${Math.max(2, Math.round(progress.pct * 100))}%`}]} />
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  progress: {gap: 8, paddingVertical: 4},
  stage: {gap: 6},
  stageDone: {color: theme.ok, fontSize: 14},
  stageNow: {color: theme.text, fontSize: 14, fontWeight: '600'},
  stageLater: {color: theme.textDim, fontSize: 14},
  barTrack: {height: 6, borderRadius: 3, backgroundColor: theme.surfaceAlt, overflow: 'hidden'},
  barFill: {height: 6, borderRadius: 3, backgroundColor: theme.accent},
  note: {color: theme.textDim, fontSize: 12, lineHeight: 18},
  choice: {borderWidth: 1, borderColor: theme.border, borderRadius: theme.radius, padding: 12, gap: 4},
  choiceOn: {borderColor: theme.accent, backgroundColor: theme.surfaceAlt},
  choiceTitle: {color: theme.text, fontSize: 15, fontWeight: '600'},
  outcomeOk: {color: theme.ok, fontSize: 12, lineHeight: 18},
  outcomeWarn: {color: theme.warn, fontSize: 12, lineHeight: 18},
});
