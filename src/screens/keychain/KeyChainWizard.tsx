import React, {useEffect, useMemo, useRef, useState} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {StyleSheet, Text, TextInput, View} from 'react-native';
import {Btn, Section} from '../../ui/components';
import {theme} from '../../ui/theme';
import {
  type DeviceType, type HostType, type Job, type Probe, type Progress, Choice, ProgressList, SLOTS, labelText, slotName, slotOrder, slotOutcome,
} from './shared';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const keychain = require('node-onlykey-lib/keychain');

/*
 * THE KEY CHAIN WIZARD - "21 questions" (owner, 2026-10-01).
 *
 * Crypto is confusing; nobody should have to learn key types, use flags and
 * slot conventions to get a key. So this asks plain questions, one at a time,
 * starting with the one that matters most - does the private key ever need to
 * leave the OnlyKey? - and works the rest out: the key type, what it may do
 * (sign or decrypt), where it goes, whether it is made in the Key or in the
 * App. Every answer stays on screen as a trail; Back changes any of them; the
 * end says in plain words what will be made before anything is.
 *
 * The questions are a pure function of the answers so far (nextQuestion), so
 * the order can never drift from the rules, and the actions are the Key Chain
 * screen's own (one implementation each).
 */

type Answers = {
  leave?: 'no' | 'yes';
  unsure?: boolean;
  use?: 'ssh' | 'pgp' | 'files' | 'apps' | 'site' | 'other';
  sshP256?: boolean;
  pq?: boolean;
  pgpModern?: boolean;
  rsaOk?: 'wipe' | 'copy';
  otherType?: DeviceType | 'rsa';
  person?: string;
  email?: string;
  bits?: number;
  copyOk?: boolean;
  name?: string;
  label?: string;
  slot?: number;
  slotConfirmed?: boolean;
  /* "Will this replace a key you already have?" and which one */
  replace?: boolean;
  replaceUnsure?: boolean;
  replaceSlot?: number;
  pass?: string;
};

type Option = {label: string; info: string; set: Partial<Answers>; recommended?: boolean};
type Question =
  | {kind: 'choice'; id: string; ask: string; why?: string; list?: string[]; options: Option[]}
  | {kind: 'text'; id: string; ask: string; why?: string; fields: {key: 'person' | 'email' | 'name' | 'label'; placeholder: string; max?: number; optional?: boolean}[]}
  | {kind: 'slot'; id: string; ask: string}
  | {kind: 'pass'; id: string; ask: string; why: string}
  | {kind: 'review'; id: 'review'};

/* What the answers add up to. */
type Plan =
  | {act: 'jobs'; jobs: Job[]; what: string}
  | {act: 'host'; type: HostType; bits: number; slot: number | null; kind: string; copy: boolean; what: string}
  | {act: 'pgp-app'; ecc: boolean; bits: number; copy: boolean; what: string}
  | {act: 'derive'; scheme: string; type: string; what: string};

function planOf(a: Answers): Plan | null {
  const inside = a.leave === 'no';
  switch (a.use) {
    case 'ssh': {
      const t = a.sshP256 ? 'p256' : 'ed25519';
      return inside
        ? {act: 'jobs', jobs: [], what: `an SSH key (${t === 'p256' ? 'P-256' : 'Ed25519'}) made inside the OnlyKey`}
        : {act: 'host', type: t, bits: 0, slot: null, kind: 'ssh', copy: true, what: `an SSH key (${t}) made in the App, with an encrypted copy`};
    }
    case 'files':
      if (a.pq) return {act: 'jobs', jobs: [], what: 'a post-quantum (X-Wing) key for receiving encrypted files, made inside the OnlyKey'};
      return inside
        ? {act: 'jobs', jobs: [], what: 'a key for receiving encrypted files (X25519), made inside the OnlyKey'}
        : {act: 'host', type: 'x25519', bits: 0, slot: null, kind: 'age', copy: true, what: 'a key for receiving encrypted files (X25519), made in the App, with an encrypted copy'};
    case 'pgp':
      if (a.pgpModern && inside) return {act: 'jobs', jobs: [], what: 'a PGP key pair (Ed25519 to sign, X25519 to decrypt) made inside the OnlyKey'};
      return {
        act: 'pgp-app', ecc: Boolean(a.pgpModern), bits: a.bits || 3072,
        copy: a.pgpModern ? a.leave === 'yes' : a.rsaOk === 'copy',
        what: a.pgpModern ? 'a PGP key (ECC) made in the App, loaded onto the OnlyKey' : `an RSA PGP key (${a.bits || 3072} bits) made in the App, loaded onto the OnlyKey`,
      };
    case 'apps':
      return {act: 'host', type: 'rsa', bits: a.bits || 3072, slot: null, kind: 'sig', copy: Boolean(a.copyOk), what: `an RSA signing key (${a.bits || 3072} bits) for apps and code, made in the App`};
    case 'site':
      return {act: 'derive', scheme: 'label', type: 'p256', what: 'a key the OnlyKey re-creates from a name (nothing is stored)'};
    case 'other':
      if (!a.otherType) return null;
      if (a.otherType === 'rsa') return {act: 'host', type: 'rsa', bits: a.bits || 3072, slot: null, kind: 'sig', copy: !inside || Boolean(a.copyOk), what: 'an RSA key made in the App'};
      return inside || ['xwing', 'mlkem768'].includes(a.otherType)
        ? {act: 'jobs', jobs: [], what: `a ${a.otherType} key made inside the OnlyKey`}
        : {act: 'host', type: a.otherType as HostType, bits: 0, slot: null, kind: a.otherType === 'x25519' ? 'enc' : 'sig', copy: true, what: `a ${a.otherType} key made in the App, with an encrypted copy`};
  }
  return null;
}

/* The device type a "made inside" plan writes, and the tag kind. */
function insideType(a: Answers): [DeviceType, string] {
  if (a.use === 'ssh') return [a.sshP256 ? 'p256' : 'ed25519', 'ssh'];
  if (a.use === 'files') return a.pq ? ['xwing', 'xwg'] : ['x25519', 'age'];
  const t = (a.otherType || 'ed25519') as DeviceType;
  return [t, t === 'x25519' ? 'enc' : t === 'xwing' ? 'xwg' : t === 'mlkem768' ? 'mlk' : 'sig'];
}

function needsSlot(a: Answers, plan: Plan | null): boolean {
  if (!plan) return false;
  if (plan.act === 'jobs') return !(a.use === 'pgp'); // the PGP pair goes to ECC1/ECC2 by itself
  if (plan.act === 'host') return true;
  return false;
}

/* The next question, from the answers so far. */
/* A key already on the OnlyKey, as the Wizard shows it. */
type Existing = {slot: number; kind: string; bits?: number; label: string};

/*
 * A KEY IN PLAIN WORDS (owner: "In use: ECC10 (xwing)" is gibberish to a
 * normal user). What it is FOR, from its tag; otherwise what kind of key it
 * is. The slot is a detail, said after.
 */
function describeKey(e: Existing): string {
  const tag = keychain.tag.parseTag(e.label);
  const forTag: Record<string, string> = {
    ssh: 'your SSH login key', pgp: 'your PGP key', age: 'a key for receiving files', xwg: 'a post-quantum key for receiving files',
    mlk: 'a post-quantum key', sig: 'a signing key', enc: 'an encryption key', pqc: 'a post-quantum PGP key',
  };
  const forType: Record<string, string> = {
    ed25519: 'a signing key', p256: 'a signing key', secp256k1: 'a signing key', x25519: 'an encryption key',
    xwing: 'a post-quantum encryption key', mlkem768: 'a post-quantum encryption key', rsa: 'an RSA key', composite: 'a post-quantum PGP key',
  };
  const what = (tag && forTag[tag.kind]) || forType[e.kind] || 'a key';
  const name = tag ? tag.name : e.label;
  return name ? `${what} "${name}"` : `${what} (no name)`;
}

/* The overview: named keys one per line, unnamed ones counted together. */
function overview(keys: Existing[]): string[] {
  const lines: string[] = [];
  const unnamed: Record<string, number[]> = {};
  for (const e of keys) {
    const d = describeKey(e);
    if (d.endsWith('(no name)')) {
      const k = d.replace(' (no name)', '');
      (unnamed[k] = unnamed[k] || []).push(e.slot);
    } else {
      lines.push(`${d[0].toUpperCase()}${d.slice(1)}  ·  ${slotName(e.slot)}`);
    }
  }
  /* Unnamed ones counted together - with their slots, so you can find them (owner). */
  for (const [k, at] of Object.entries(unnamed)) {
    const where = at.map(slotName).join(', ');
    lines.push(at.length === 1
      ? `${k[0].toUpperCase()}${k.slice(1)} with no name  ·  ${where}`
      : `${at.length} ${k.replace(/^an? /, '')}s with no name  ·  ${where}`);
  }
  return lines;
}

/*
 * reserved: empty slots something in "Waiting to be written" will fill - not
 * free any more, though the OnlyKey does not know it yet (the count said "11
 * free" with two of them already queued for a PGP pair).
 */
function nextQuestion(a: Answers, existing: Existing[], reserved: number[] = []): Question {
  /*
   * WHAT IS IT FOR? FIRST (owner): the answer often decides the rest. A
   * website key is re-created from its address and never stored; a
   * code-signing key is RSA, which only the App can make; a PGP key is a pair
   * in the PGP slots. Only where it is a real choice (SSH, files, modern PGP,
   * something else) does the Wizard ask whether the private key may leave
   * the OnlyKey.
   */
  if (!a.use) {
    return {kind: 'choice', id: 'use', ask: 'What\'s this key for?', options: [
      {label: 'Logging in to servers (SSH)', info: 'Instead of a password: the server knows your public key, the OnlyKey proves it is you.', set: {use: 'ssh'}},
      {label: 'Encrypted email (PGP)', info: 'People send you encrypted email and you sign yours.', set: {use: 'pgp'}},
      {label: 'Receiving encrypted files (age)', info: 'People encrypt files to you; only your OnlyKey can open them.', set: {use: 'files'}},
      {label: 'Signing Android apps or code', info: 'Proves an app or file came from you.', set: {use: 'apps'}},
      {label: 'A website (or any name)', info: 'A key for one website. The OnlyKey re-creates it from the address whenever it is needed - nothing is stored anywhere.', set: {use: 'site'}},
      {label: 'Something else', info: 'Choose the key type yourself.', set: {use: 'other'}},
    ]};
  }
  if (a.use === 'pgp' && a.pgpModern === undefined) {
    return {kind: 'choice', id: 'pgpModern', ask: 'Does your email or PGP software handle modern (ECC) keys?',
      why: 'Thunderbird, GnuPG 2.2 or newer, and the OnlyKey web app all do. Some old software only understands RSA keys.',
      options: [
        {label: 'Yes, or I don\'t know', info: 'Use a modern key pair (Ed25519 + X25519).', set: {pgpModern: true}, recommended: true},
        {label: 'No — it needs RSA', info: 'Use RSA. The OnlyKey cannot make RSA itself; the App makes it.', set: {pgpModern: false}},
      ]};
  }
  const leaveMatters = a.use === 'ssh' || a.use === 'files' || a.use === 'other' || (a.use === 'pgp' && a.pgpModern === true);
  if (leaveMatters) {
    if (!a.leave) {
      if (a.unsure) {
        return {kind: 'choice', id: 'unsure', ask: 'If your OnlyKey were lost, would you need this exact key back?',
          why: 'Some keys can simply be replaced (a new SSH login, a new email key). Others cannot - the key that signs an Android app must stay the same forever, or the app can never be updated.',
          options: [
            {label: 'No — I could make a new one', info: 'Then it can stay locked inside the OnlyKey.', set: {leave: 'no'}, recommended: true},
            {label: 'Yes — I would need it back', info: 'Then the App makes it and you keep an encrypted copy.', set: {leave: 'yes'}},
          ]};
      }
      return {kind: 'choice', id: 'leave', ask: 'Does the private key ever need to exist outside your OnlyKey?',
        why: 'Every key has a public half (safe to share) and a private half (the secret). This decides where the secret lives.',
        options: [
          {label: 'No — keep it locked inside the OnlyKey', info: 'Safest. It is created inside the Key and nobody can copy it, not even you. If the OnlyKey is lost, the key is gone with it.', set: {leave: 'no'}, recommended: true},
          {label: 'Yes — I need a copy I can keep', info: 'The App makes it and keeps only an encrypted copy (locked by a passphrase) - share it or save it as a file whenever you like.', set: {leave: 'yes'}},
          {label: 'I\'m not sure', info: 'One more question will tell.', set: {unsure: true}},
        ]};
    }
  }

  /* the follow-ups for each use */
  if (a.use === 'ssh' && a.sshP256 === undefined) {
    return {kind: 'choice', id: 'ssh', ask: 'Do any of your servers refuse Ed25519 keys?',
      why: 'Ed25519 is the modern default and almost every server accepts it. A few company systems only allow the older NIST P-256 curve.',
      options: [
        {label: 'No, or I don\'t know', info: 'Use Ed25519.', set: {sshP256: false}, recommended: true},
        {label: 'Yes, they need P-256', info: 'Use NIST P-256 (ECDSA).', set: {sshP256: true}},
      ]};
  }
  if (a.use === 'files' && a.pq === undefined) {
    return {kind: 'choice', id: 'pq', ask: 'Should files sent to you stay safe against future quantum computers?',
      why: 'Post-quantum keys (X-Wing) resist attacks from quantum computers that may exist one day. They need the OnlyKey age plugin; classic keys (X25519) work with plain age tools too.',
      options: a.leave === 'no'
        ? [
          {label: 'Yes — post-quantum', info: 'X-Wing, made inside the OnlyKey.', set: {pq: true}, recommended: true},
          {label: 'No — classic is fine', info: 'X25519, the standard age key.', set: {pq: false}},
        ]
        : [
          {label: 'No — classic is fine', info: 'X25519, made in the App with a copy you keep.', set: {pq: false}, recommended: true},
          {label: 'Yes — post-quantum', info: 'Post-quantum keys can only be made INSIDE the OnlyKey, so there would be no copy. Choosing this changes your earlier answer to "keep it inside".', set: {pq: true, leave: 'no'}},
        ]};
  }
  if (a.use === 'pgp' && a.pgpModern === false && !a.rsaOk) {
    return {kind: 'choice', id: 'rsaOk', ask: 'RSA PGP keys are made in the App (the OnlyKey cannot make RSA), loaded onto the OnlyKey, then wiped. Keep an encrypted copy?',
      why: 'For a short moment the key exists in the App\'s memory; nothing is saved unless you ask for a copy.',
      options: [
        {label: 'Yes — make it in the App and wipe it', info: 'No copy is kept: like a key made inside, it lives only on the OnlyKey.', set: {rsaOk: 'wipe'}, recommended: true},
        {label: 'Keep an encrypted copy after all', info: 'An encrypted copy is also kept in the App, to share or save as a file later.', set: {rsaOk: 'copy'}},
      ]};
  }
  if (a.use === 'other' && !a.otherType) {
    const types: [DeviceType | 'rsa', string][] = [
      ['ed25519', 'Ed25519 — a signing key'], ['p256', 'P-256 — a signing key on the NIST curve'], ['secp256k1', 'secp256k1 — the Bitcoin/Ethereum signing curve'],
      ['x25519', 'X25519 — an encryption key'], ['xwing', 'X-Wing — post-quantum encryption (inside the OnlyKey only)'],
      ['mlkem768', 'ML-KEM-768 — a bare post-quantum key (inside the OnlyKey only)'], ['rsa', 'RSA — made in the App (the OnlyKey cannot make it)'],
    ];
    return {kind: 'choice', id: 'other', ask: 'Which kind of key?', options: types.map(([t, info]) => ({label: info.split(' — ')[0], info: info.split(' — ')[1], set: {otherType: t}}))};
  }
  if (a.use === 'pgp' && (a.person === undefined)) {
    return {kind: 'text', id: 'who', ask: 'Who is this PGP key for?', why: 'This is what people see on your public key, so they know it is yours.',
      fields: [{key: 'person', placeholder: 'your name'}, {key: 'email', placeholder: 'your email (optional)', optional: true}]};
  }
  const needsBits = (a.use === 'apps' || (a.use === 'pgp' && !a.pgpModern) || a.otherType === 'rsa');
  if (needsBits && !a.bits) {
    return {kind: 'choice', id: 'bits', ask: 'How strong should the RSA key be?', why: 'Bigger is stronger, but slower to make and to use.',
      options: [
        {label: '2048 bits', info: 'The common minimum.', set: {bits: 2048}},
        {label: '3072 bits', info: 'Stronger; a good default today.', set: {bits: 3072}, recommended: true},
        {label: '4096 bits', info: 'The most cautious; slowest.', set: {bits: 4096}},
      ]};
  }
  if ((a.use === 'apps' || a.otherType === 'rsa') && a.copyOk === undefined) {
    return {kind: 'choice', id: 'copy', ask: a.use === 'apps' ? 'If you lose this key you can never publish an update to your app. Keep an encrypted copy?' : 'Keep an encrypted copy of this key?',
      why: 'The copy is kept in the App, locked by a passphrase. From "On this App" you can share it or save it as a file somewhere safe and offline.',
      options: [
        {label: 'Yes — keep a copy', info: 'You will choose a passphrase; the copy waits in "On this App".', set: {copyOk: true}, recommended: a.use === 'apps'},
        {label: 'No copy', info: 'It lives only on the OnlyKey.', set: {copyOk: false}},
      ]};
  }
  /*
   * "WILL THIS REPLACE A KEY?" (owner) - asked once the kind of key is known,
   * and only when there is something it could replace. A replacement takes
   * the old key's slot and name, so the slot and name questions are skipped,
   * and the review says in plain words what is destroyed.
   */
  const plan0 = planOf(a);
  const pgpInside = a.use === 'pgp' && a.pgpModern && a.leave === 'no';
  if (pgpInside && a.replace === undefined) {
    const held = existing.filter(e => e.slot === 101 || e.slot === 102);
    if (held.length) {
      return {kind: 'choice', id: 'pgpReplace',
        ask: `${held.map(e => slotName(e.slot)).join(' and ')} already ${held.length === 1 ? 'holds a key' : 'hold keys'}. Replace ${held.length === 1 ? 'it' : 'them'} with your new PGP keys?`,
        why: `${held.map(e => `${slotName(e.slot)}: ${e.label ? labelText(e.label) : e.kind}`).join(' · ')}. These are the slots PGP uses, so a PGP key made inside the OnlyKey always goes there. Press Back to choose differently.`,
        options: [{label: 'Yes — replace them', info: 'The keys there now are destroyed. Anyone who used them needs your new PGP public key.', set: {replace: true}}]};
    }
  }
  const family = plan0?.act === 'host' && plan0.type === 'rsa' ? 'rsa' : 'ecc';
  const replaceable = existing.filter(e => (family === 'rsa' ? e.slot <= 4 : e.slot >= 101));
  if (needsSlot(a, plan0) && a.replace === undefined && replaceable.length && a.replaceUnsure) {
    /* "I'm not sure" (owner): show what is used and what is free, then ask again. */
    const range = family === 'rsa' ? [1, 2, 3, 4] : SLOTS.filter(n => n >= 101);
    const free = range.filter(n => !replaceable.some(e => e.slot === n) && !reserved.includes(n)).map(slotName);
    const queued = range.filter(n => reserved.includes(n)).map(slotName);
    return {kind: 'choice', id: 'replaceSeen', ask: 'Here is what is already on your OnlyKey. Does the new key replace one of these?',
      list: [
        ...overview(replaceable),
        ...(queued.length ? [`${queued.join(', ')}: already waiting to be written`] : []),
        free.length ? `${free.length} free place${free.length === 1 ? '' : 's'} for a new key` : 'No free places - a new key has to replace one',
      ],
      options: [
        {label: 'No — it is an extra key', info: free.length ? `It goes in a free slot (${free.length} free).` : 'There is no free slot: you would have to replace one.', set: {replace: false}, recommended: free.length > 0},
        {label: 'Yes — it replaces one of these', info: 'Next: choose which.', set: {replace: true}},
      ]};
  }
  if (needsSlot(a, plan0) && a.replace === undefined && replaceable.length) {
    return {kind: 'choice', id: 'replace', ask: 'Will this replace a key you already have?',
      why: 'Replacing puts the new key in the old key\'s place and destroys the old one. Anything that used the old key - servers, people who encrypt to you, an app store - needs the new public key.',
      options: [
        {label: 'No — it is an extra key', info: 'It goes in a free slot; your other keys stay as they are.', set: {replace: false}, recommended: true},
        {label: 'Yes — it replaces one', info: 'Next: choose which.', set: {replace: true}},
        {label: 'I\'m not sure', info: 'See what is already on your OnlyKey and what is free.', set: {replaceUnsure: true}},
      ]};
  }
  if (a.replace && !pgpInside && a.replaceSlot === undefined) {
    const lost = (e: Existing) => {
      const tag = keychain.tag.parseTag(e.label);
      if (a.use === 'apps' || tag?.kind === 'sig') return 'destroyed - anything it signed for (an app, files) can no longer be updated or matched with the new key';
      if (tag?.kind === 'ssh') return 'destroyed - give your servers the new SSH line';
      if (tag && ['age', 'xwg', 'mlk', 'enc'].includes(tag.kind)) return 'destroyed - files already encrypted to it can no longer be opened; share the new recipient';
      return 'destroyed and replaced by the new key';
    };
    return {kind: 'choice', id: 'replaceWhich', ask: 'Which key does it replace?', why: 'The new key takes its slot and its name.',
      options: replaceable.map(e => ({
        label: describeKey(e).replace(/^./, c => c.toUpperCase()),
        info: `${lost(e)}  ·  ${slotName(e.slot)}`,
        set: {replaceSlot: e.slot, slot: e.slot, slotConfirmed: true, name: keychain.tag.parseTag(e.label)?.name ?? a.name ?? ''},
      }))};
  }

  if (a.use !== 'site' && a.use !== 'pgp' && a.name === undefined) {
    return {kind: 'text', id: 'name', ask: 'What should we call it?', why: 'Up to 12 letters - saved on the Key so every OnlyKey app shows it (e.g. "laptop", "backups", "myapp").',
      fields: [{key: 'name', placeholder: 'a short name', max: 12, optional: true}]};
  }
  if (a.use === 'site' && !a.label) {
    return {kind: 'text', id: 'label', ask: 'Which website or name is the key for?', why: 'The same name always gives the same key, on this OnlyKey. Use the site\'s address, e.g. example.com.',
      fields: [{key: 'label', placeholder: 'example.com'}]};
  }
  const plan = planOf(a);
  if (needsSlot(a, plan) && !a.slotConfirmed) return {kind: 'slot', id: 'slot', ask: 'Where on the OnlyKey should it go?'};
  const copying = plan && ((plan.act === 'host' && plan.copy) || (plan.act === 'pgp-app' && plan.copy));
  if (copying && !a.pass) {
    return {kind: 'pass', id: 'pass', ask: 'Choose a passphrase for the copy',
      why: 'At least 25 characters, typed twice. Without it the copy cannot be opened - write it down somewhere safe.'};
  }
  return {kind: 'review', id: 'review'};
}

/* Words for the trail of answers. */
function trail(a: Answers): string[] {
  const t: string[] = [];
  if (a.leave) t.push(a.leave === 'no' ? 'Stays inside the OnlyKey' : 'A copy is kept');
  const use: Record<string, string> = {ssh: 'SSH login', pgp: 'Encrypted email (PGP)', files: 'Receiving files', apps: 'Signing apps / code', site: 'Website key', other: 'Other'};
  if (a.use) t.push(use[a.use]);
  if (a.sshP256 !== undefined) t.push(a.sshP256 ? 'P-256' : 'Ed25519');
  if (a.pq !== undefined) t.push(a.pq ? 'Post-quantum' : 'Classic');
  if (a.pgpModern !== undefined) t.push(a.pgpModern ? 'Modern PGP' : 'RSA PGP');
  if (a.otherType) t.push(a.otherType);
  if (a.person) t.push(a.email ? `${a.person} <${a.email}>` : a.person);
  if (a.bits) t.push(`${a.bits} bits`);
  if (a.copyOk !== undefined) t.push(a.copyOk ? 'Copy kept' : 'No copy');
  if (a.name) t.push(`"${a.name}"`);
  if (a.label) t.push(a.label);
  if (a.replace === false) t.push('Extra key');
  if (a.replaceSlot !== undefined) t.push(`Replaces ${slotName(a.replaceSlot)}`);
  else if (a.slot !== undefined && a.slotConfirmed) t.push(slotName(a.slot));
  return t;
}

/*
 * THE ANSWERS SURVIVE CONFIG MODE. Entering it locks the key, the app shows
 * the PIN pad and this screen unmounts - so a Wizard that needs config mode
 * at its end would lose every answer on the way there. They are kept on the
 * phone (never the copy's passphrase) and the screen reopens a Wizard that
 * was under way; Cancel or finishing forgets them.
 */
export const WIZARD_SAVE_KEY = 'okrn.keychain.wizard';
const withoutSecret = ({pass: _pass, ...rest}: Answers): Answers => rest;

export function KeyChainWizard({
  onClose,
  slots,
  taken,
  inConfig,
  locked,
  busy,
  addJobs,
  makeHostWith,
  makePgpInApp,
  deriveWith,
  onQueued,
  configPanel,
  progress,
}: {
  onClose: () => void;
  slots: Probe[] | null;
  taken: (n: number) => boolean;
  inConfig: boolean;
  locked: boolean;
  busy: string | null;
  addJobs: (jobs: Job[]) => void;
  makeHostWith: (h: {type: HostType; bits: number; slot: number | null; kind: string; name: string; pass: string | null}) => Promise<boolean>;
  makePgpInApp: (g: {name: string; email: string; bits: number; pass: string | null; tagName: string; ecc: boolean}) => Promise<boolean>;
  deriveWith: (d: {scheme: string; type: string; label: string}) => Promise<boolean>;
  onQueued: () => void;
  /* The screen's config mode panel: the panels are hidden while the Wizard is open, so it comes along. */
  configPanel: React.ReactNode;
  /* The steps of a key being made, while it is (the screen's makeHostWith / makePgpInApp report them). */
  progress: Progress | null;
}) {
  const [answers, setAnswers] = useState<Answers>({});
  const [history, setHistory] = useState<Answers[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [replace, setReplace] = useState('');
  const [pickOther, setPickOther] = useState(false);
  const [pass2, setPass2] = useState('');

  const existing: Existing[] = (slots || []).filter(x => x.kind !== 'empty' || x.label);
  const loaded = useRef(false);
  useEffect(() => {
    AsyncStorage.getItem(WIZARD_SAVE_KEY)
      .then(raw => {
        if (raw) {
          const saved = JSON.parse(raw) as {answers: Answers; history: Answers[]};
          setAnswers(saved.answers || {});
          setHistory(saved.history || []);
        }
      })
      .catch(() => {})
      .finally(() => { loaded.current = true; });
  }, []);
  useEffect(() => {
    if (!loaded.current) return;
    AsyncStorage.setItem(WIZARD_SAVE_KEY, JSON.stringify({answers: withoutSecret(answers), history: history.map(withoutSecret)})).catch(() => {});
  }, [answers, history]);
  const close = () => {
    AsyncStorage.removeItem(WIZARD_SAVE_KEY).catch(() => {});
    onClose();
  };

  const reserved = SLOTS.filter(n => taken(n) && !existing.some(e => e.slot === n));
  const q = useMemo(() => nextQuestion(answers, existing, reserved), [answers, slots, reserved.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const plan = planOf(answers);
  const answer = (set: Partial<Answers>) => {
    setHistory(h => [...h, answers]);
    setAnswers(a => ({...a, ...set}));
    setDraft({});
    setReplace('');
    setPickOther(false);
    setPass2('');
  };
  const back = () => {
    if (!history.length) return close();
    setAnswers(history[history.length - 1]);
    setHistory(h => h.slice(0, -1));
  };

  /* The slot the plan suggests: free, of the right kind, nothing else using it. */
  const isRsa = plan?.act === 'host' && plan.type === 'rsa';
  const candidates = (isRsa ? [1, 2, 3, 4] : SLOTS.filter(n => n >= 101)).slice().sort((x, y) => slotOrder(x, taken) - slotOrder(y, taken));
  const suggested = candidates.find(n => slotOrder(n, taken) === 0) ?? candidates[0];
  const [insT] = insideType(answers);
  const use: 'signature' | 'decryption' = (plan?.act === 'host' ? plan.type === 'x25519' : ['x25519', 'xwing', 'mlkem768'].includes(insT))
    ? 'decryption' : 'signature';

  const finish = async () => {
    const a = answers;
    if (!plan) return;
    if (plan.act === 'derive') {
      if (await deriveWith({scheme: 'label', type: 'p256', label: a.label || ''})) close();
      return;
    }
    if (plan.act === 'pgp-app') {
      if (await makePgpInApp({name: a.person || '', email: a.email || '', bits: plan.bits, pass: plan.copy ? a.pass || '' : null, tagName: (a.person || '').split(' ')[0].slice(0, 12), ecc: plan.ecc})) close();
      return;
    }
    if (plan.act === 'host') {
      if (await makeHostWith({type: plan.type, bits: plan.bits, slot: a.slot ?? null, kind: plan.kind, name: a.name || '', pass: plan.copy ? a.pass || '' : null})) close();
      return;
    }
    /* made inside the Key: queued, written in one config-mode visit */
    /* A replacement takes the replaced key's name unless one was given (question "Which key does it replace?" says so). */
    const replaced = a.replaceSlot !== undefined ? existing.find(x => x.slot === a.replaceSlot)?.label || '' : '';
    const inherited = replaced ? keychain.tag.parseTag(replaced)?.name ?? replaced : '';
    const short = (a.use === 'pgp' ? (a.person || '').split(' ')[0] : a.name || inherited).replace(/[^\x20-\x39\x3b-\x7e]/g, '').slice(0, 12).trim();
    if (a.use === 'pgp') {
      const tag = short ? keychain.tag.formatTag('pgp', short) : null;
      const userId = a.email ? `${a.person || ''} <${a.email}>`.trim() : (a.person || '').trim();
      /* the signing job says where its decryption key goes, so the finish step never assumes ECC1 */
      addJobs([{slot: 101, type: 'x25519', tag}, {slot: 102, type: 'ed25519', tag, pgp: userId ? {userId, ecdhSlot: 101} : undefined}]);
    } else {
      const [t, kind] = insideType(a);
      addJobs([{slot: a.slot as number, type: t, tag: short ? keychain.tag.formatTag(kind, short) : null}]);
    }
    AsyncStorage.removeItem(WIZARD_SAVE_KEY).catch(() => {});
    onQueued();
  };

  return (
    <Section title={q.kind === 'review' ? 'Here is what I will make' : `Question ${history.length + 1}`}>
      {trail(answers).length ? <Text style={styles.trail}>{trail(answers).join('  ›  ')}</Text> : null}

      {q.kind === 'choice' ? (
        <>
          <Text style={styles.ask}>{q.ask}</Text>
          {q.why ? <Text style={styles.why}>{q.why}</Text> : null}
          {q.list ? q.list.map((l, i) => <Text key={i} style={styles.line}>•  {l}</Text>) : null}
          {q.options.map(o => (
            <Choice key={o.label} title={o.recommended ? `${o.label}  (recommended)` : o.label} info={o.info} selected={false} onPress={() => answer(o.set)} />
          ))}
        </>
      ) : null}

      {q.kind === 'text' ? (
        <>
          <Text style={styles.ask}>{q.ask}</Text>
          {q.why ? <Text style={styles.why}>{q.why}</Text> : null}
          {q.fields.map(f => (
            <TextInput key={f.key} value={draft[f.key] ?? ''} onChangeText={v => setDraft(d => ({...d, [f.key]: v}))}
              autoCapitalize={f.key === 'person' ? 'words' : 'none'} autoCorrect={false} maxLength={f.max}
              placeholder={f.placeholder} placeholderTextColor={theme.textDim} style={styles.input} />
          ))}
          {(() => {
            const missing = q.fields.some(f => !f.optional && !(draft[f.key] || '').trim());
            let bad: string | null = null;
            if (q.id === 'name' && (draft.name || '').trim()) {
              try { keychain.tag.formatTag('sig', draft.name.trim()); } catch (e) { bad = String((e as Error).message); }
            }
            return (
              <>
                {bad ? <Text style={styles.warn}>{bad}</Text> : null}
                <Btn title={q.fields.every(f => f.optional) && !q.fields.some(f => (draft[f.key] || '').trim()) ? 'Skip' : 'Next'}
                  tone={missing || bad ? 'default' : 'primary'} disabled={missing || Boolean(bad)}
                  onPress={() => answer(Object.fromEntries(q.fields.map(f => [f.key, (draft[f.key] || '').trim()])) as Partial<Answers>)} />
              </>
            );
          })()}
        </>
      ) : null}

      {q.kind === 'slot' ? (
        <>
          <Text style={styles.ask}>{pickOther ? q.ask : `I'll put it in ${slotName(suggested)}. OK?`}</Text>
          {!pickOther ? (
            <>
              <Text style={slotOutcome(suggested, use).warn ? styles.warn : styles.ok}>{slotOutcome(suggested, use).text}</Text>
              <Choice title={`Yes — use ${slotName(suggested)}`} info={taken(suggested) ? 'It holds a key, which will be destroyed.' : 'It is empty.'} selected={false}
                onPress={() => taken(suggested) ? setPickOther(true) : answer({slot: suggested, slotConfirmed: true})} />
              <Choice title="Choose another slot" info="See every slot and what would happen to this key in it." selected={false} onPress={() => setPickOther(true)} />
            </>
          ) : (
            <>
              {candidates.map(n => {
                const p = slots?.find(x => x.slot === n);
                const o = slotOutcome(n, use);
                return (
                  <Choice key={n} title={slotName(n)} selected={answers.slot === n}
                    info={taken(n) ? `holds ${p?.kind === 'rsa' ? `RSA ${p?.bits}` : p?.kind}${p?.label ? ` "${labelText(p.label)}"` : ''} — writing over it destroys it` : 'empty'}
                    outcome={o} onPress={() => setAnswers(a => ({...a, slot: n}))} />
                );
              })}
              {answers.slot !== undefined && taken(answers.slot) ? (
                <TextInput value={replace} onChangeText={setReplace} autoCapitalize="characters" placeholder="type REPLACE to write over it"
                  placeholderTextColor={theme.textDim} style={styles.input} />
              ) : null}
              {(() => {
                const blocked = answers.slot === undefined || (taken(answers.slot) && replace !== 'REPLACE');
                return <Btn title="Next" tone={blocked ? 'default' : 'primary'} disabled={blocked} onPress={() => answer({slotConfirmed: true})} />;
              })()}
            </>
          )}
        </>
      ) : null}

      {q.kind === 'pass' ? (
        <>
          <Text style={styles.ask}>{q.ask}</Text>
          <Text style={styles.why}>{q.why}</Text>
          <TextInput value={draft.pass ?? ''} onChangeText={v => setDraft({pass: v})} secureTextEntry autoCapitalize="none" autoCorrect={false}
            placeholder="passphrase (25+ characters)" placeholderTextColor={theme.textDim} style={styles.input} />
          <TextInput value={pass2} onChangeText={setPass2} secureTextEntry autoCapitalize="none" autoCorrect={false}
            placeholder="again" placeholderTextColor={theme.textDim} style={styles.input} />
          {(() => {
            const p1 = draft.pass ?? '';
            const msg = p1.length < 25 ? `${p1.length}/25 characters` : p1 !== pass2 ? 'The two do not match yet.' : null;
            return (
              <>
                {msg ? <Text style={styles.why}>{msg}</Text> : null}
                <Btn title="Next" tone={msg ? 'default' : 'primary'} disabled={Boolean(msg)} onPress={() => answer({pass: p1})} />
              </>
            );
          })()}
        </>
      ) : null}

      {q.kind === 'review' && plan ? (
        <>
          <Text style={styles.ask}>I will make {plan.what}.</Text>
          {answers.replaceSlot !== undefined ? (
            <Text style={styles.warn}>
              This destroys the key now in {slotName(answers.replaceSlot)}
              {(() => { const e = existing.find(x => x.slot === answers.replaceSlot); return e?.label ? ` (${labelText(e.label)})` : ''; })()}.
            </Text>
          ) : null}
          {reviewLines(answers, plan).map((l, i) => <Text key={i} style={styles.line}>•  {l}</Text>)}
          {plan.act === 'jobs' ? (
            <Btn title="Add it to the list to write" tone="primary" onPress={() => void finish()} />
          ) : plan.act === 'derive' ? (
            <Btn title={busy === 'derive' ? 'Making…' : 'Make it'} tone="primary" disabled={busy !== null || locked} onPress={() => void finish()} />
          ) : (
            <>
              {(() => {
                const needsConfig = plan.act === 'pgp-app' || (plan.act === 'host' && answers.slot !== undefined);
                const blocked = busy !== null || locked || (needsConfig && !inConfig);
                return (
                  <>
                    {progress ? <ProgressList progress={progress} /> : (
                      <Btn title="Make it now" tone={blocked ? 'default' : 'primary'} disabled={blocked} onPress={() => void finish()} />
                    )}
                    {needsConfig && !inConfig ? (
                      <>
                        <Text style={styles.warn}>Writing to the OnlyKey needs config mode first. Your answers are kept while you go through it.</Text>
                        {configPanel}
                      </>
                    ) : null}
                  </>
                );
              })()}
            </>
          )}
        </>
      ) : null}

      <View style={styles.nav}>
        {history.length ? <Btn title="Back" onPress={back} /> : null}
        {history.length ? <Btn title="Start over" onPress={() => { setAnswers({}); setHistory([]); }} /> : null}
        <Btn title="Cancel" onPress={close} />
      </View>
    </Section>
  );
}

function reviewLines(a: Answers, plan: Plan): string[] {
  const l: string[] = [];
  if (plan.act === 'jobs') {
    if (a.use === 'pgp') {
      l.push('Two keys made inside the OnlyKey: one to decrypt (ECC1) and one to sign (ECC2) - the slots the web app and desktop App use for PGP.');
      l.push('After the restart, Key Chain builds your PGP public key for you to share: tap "Sign it with the OnlyKey" and press when it asks (twice - one signature for your name, one for the decrypt key).');
    } else {
      l.push(`Made inside the OnlyKey in ${a.slot !== undefined ? slotName(a.slot) : '?'}${a.name ? `, named "${a.name}"` : ''}. The private key never leaves it.`);
      if (a.use === 'ssh') l.push('Afterwards: copy its SSH line from "On this Key" into ~/.ssh/authorized_keys on your servers.');
      if (a.use === 'files') l.push('Afterwards: share its age recipient from "On this Key" with people who send you files.');
    }
    l.push('It goes on the list to write. Then: Config mode (bottom panel) → "Write" → restart the app. Key Chain finishes when you are back.');
  } else if (plan.act === 'host') {
    l.push(`Made in the App${a.slot !== undefined ? `, stored on the OnlyKey in ${slotName(a.slot)}` : ''}, then wiped from the App${plan.copy ? ' - only an encrypted copy stays, in "On this App", to share or save as a file later' : ''}.`);
    if (plan.copy) l.push('The copy and its passphrase are this key\'s only backup: save the copy somewhere safe and offline, and write the passphrase down.');
    l.push('Needs config mode to write to the OnlyKey; a restart finishes it.');
  } else if (plan.act === 'pgp-app') {
    l.push('Made in the App, loaded onto the OnlyKey where PGP looks for it (decrypt in slot 1, sign in slot 2), then wiped from the App.');
    if (plan.copy) l.push('An encrypted copy of the whole PGP key stays in "On this App", to share or save as a file later.');
    l.push('Its public key (to share) is kept in "On this App". Needs config mode; a restart finishes it.');
  } else {
    l.push(`For "${a.label}". Nothing is stored: the OnlyKey re-creates it from that name every time. Its public key is kept in "On this App". No config mode.`);
  }
  return l;
}

const styles = StyleSheet.create({
  trail: {color: theme.accent, fontSize: 12, lineHeight: 18},
  ask: {color: theme.text, fontSize: 17, fontWeight: '600', lineHeight: 24},
  why: {color: theme.textSecondary, fontSize: 13, lineHeight: 19},
  line: {color: theme.text, fontSize: 14, lineHeight: 20},
  ok: {color: theme.ok, fontSize: 13, lineHeight: 19},
  warn: {color: theme.warn, fontSize: 13, lineHeight: 19},
  input: {
    color: theme.text, fontSize: 15, paddingHorizontal: 10, paddingVertical: 10, borderRadius: theme.radius,
    borderWidth: 1, borderColor: theme.border, backgroundColor: theme.inputBg,
  },
  nav: {flexDirection: 'row', gap: 8, flexWrap: 'wrap'},
});
