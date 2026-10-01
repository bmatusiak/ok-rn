import React, {useCallback, useEffect, useState} from 'react';
import {Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {Btn, Section, Segmented} from '../ui/components';
import {NEEDS_CONFIG_MODE, ON, type ConfigState} from '../ui/configModeNotes';
import {ConfigModePanel} from '../ui/ConfigModePanel';
import {theme} from '../ui/theme';
import {useActiveKey, useBackend, useKeyName} from '../hooks/KeyContext';
import {useSecureScreen} from '../hooks/useSecureScreen';
import type {EmuSession} from '../hooks/useOkEmu';
import OkEmu from '../transport/OkEmu';
import NativeSecrets from '../../specs/NativeSecrets';
import NativeShare from '../../specs/NativeShare';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const keychain = require('node-onlykey-lib/keychain');
import {
  type Probe, type Entry, type Job, type DeviceType, type HostType, type RemoveTarget, SLOTS, slotName, DEVICE_TYPES, KIND_TITLE,
  TYPE_INFO, KIND_INFO, SCHEME_INFO, labelText, slotOutcome, Choice, type Progress, ProgressList,
} from './keychain/shared';
import {KeyChainWizard, WIZARD_SAVE_KEY} from './keychain/KeyChainWizard';
import {KeyChainRemove} from './keychain/KeyChainRemove';

/*
 * KEY CHAIN - generate, keep track of, derive and export keys (owner,
 * 2026-10-01). The lib does the work (node-onlykey-lib/keychain and the
 * device plugin); this screen is the owner's list + "+" wizard.
 *
 * THE RULES IT FOLLOWS, from the firmware:
 *   - A key is written only in CONFIG MODE, which locks the key (PIN again)
 *     and ends only at a restart. So the wizard COLLECTS first, touching
 *     nothing, and "Write to key" does every queued key in one config-mode
 *     session - one restart for all of them.
 *   - The key drops public-key reads in config mode, so a new key's public
 *     half is read AFTER the restart: a public-only "pending" record survives
 *     it, and the tab finishes the job when you are back (the restart returns
 *     you here - src/resumeTab.ts).
 *   - Slots are read by probing their public keys (probeKeySlot); what each
 *     is FOR lives in the key's own label as a tag ("ssh:laptop"). The last
 *     reading is cached so config mode, where nothing can be read, still knows
 *     which slots are taken.
 *   - Derived keys and keys kept off the OnlyKey live in a PUBLIC-ONLY list on
 *     this phone (keychain.list refuses anything private).
 */

const LIST_KEY = 'okrn.keychain.list';
const CACHE_KEY = 'okrn.keychain.slots';
const PENDING_KEY = 'okrn.keychain.pending';
/*
 * THE QUEUE SURVIVES CONFIG MODE. Entering it locks the key, the app shows the
 * PIN pad and this screen unmounts - so a queue kept only in state was lost
 * on the way to the one place it can be written. Public data only (slot, type,
 * name); nothing private is made before Write.
 */
const QUEUE_KEY = 'okrn.keychain.queue';
/*
 * ENCRYPTED COPIES ARE KEPT IN THE APP (owner, 2026-10-01): a key's encrypted
 * copy (PEM or armored PGP) is stored here instead of being pushed straight
 * into Android's share sheet, so it can be shared or saved as a file LATER,
 * when the user is ready. Separate from the list on purpose: the list is
 * public-only (keychain.list refuses private data); these are private keys,
 * but only ever stored encrypted under the >= 25-character passphrase
 * (PBKDF2 600000 + AES-256). Never the plain key, never the passphrase.
 */
const COPIES_KEY = 'okrn.keychain.copies';
/*
 * A PGP PAIR MADE INSIDE THE KEY STILL NEEDS ITS CERTIFICATE. ECC1 (X25519,
 * decrypt) and ECC2 (Ed25519, sign) are the keys; what PGP software imports is
 * a certificate - the two public keys, the user id, and two self-signatures
 * that only the signing key can make (crypto.pgpCert.buildCertificate, the
 * same builder as `onlykey-js gpg init`). Public keys are readable only after
 * the restart, and the signatures need presses, so the job leaves this record
 * and the user starts the signing when ready. Kept until it succeeds.
 */
const PGP_TODO_KEY = 'okrn.keychain.pgpTodo';
type PgpTodo = {userId: string; signSlot: number; ecdhSlot: number; tag: string | null};
type Copy = {id: string; title: string; file: string; mime: string; text: string; made: string; where: string};
const CLIPBOARD_TTL_MS = 45000;

/* Which ways of adding each panel offers. */
const PATHS = {
  key: ['In the Key', 'In the App'] as ('In the Key' | 'In the App' | 'Derive')[],
  app: ['Derive', 'In the App'] as ('In the Key' | 'In the App' | 'Derive')[],
};
/*
 * ADDED TO, never replaced: one config-mode visit can write a queue AND a
 * phone-made key, and the finish after the restart must check every slot
 * that was written - the second write overwrote the first record once.
 */
async function addPending(jobs: Job[]): Promise<void> {
  const before = await loadJson<Job[]>(PENDING_KEY, []);
  const bySlot = new Map(before.map(j => [j.slot, j]));
  for (const j of jobs) bySlot.set(j.slot, j);
  await AsyncStorage.setItem(PENDING_KEY, JSON.stringify([...bySlot.values()])).catch(() => {});
}

async function loadJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function KeyChainScreen({
  emu,
  configMode,
  onWantConfigMode,
  blockScreenshots = true,
}: {
  emu: EmuSession;
  configMode: ConfigState;
  onWantConfigMode: () => void;
  blockScreenshots?: boolean;
}) {
  const getKey = useActiveKey();
  const keyName = useKeyName();
  const backend = useBackend();
  const locked = emu.device !== 'unlocked';
  const inConfig = configMode === ON;

  const [slots, setSlots] = useState<Probe[] | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [copies, setCopies] = useState<Copy[]>([]);
  const [pgpTodo, setPgpTodo] = useState<PgpTodo | null>(null);
  /* The digits the key is waiting for while it signs (any one press when it is set to press). */
  const [challenge, setChallenge] = useState<number[] | null>(null);
  /* PGP fingerprints, read from each entry's certificate when it is opened. */
  const [fingerprints, setFingerprints] = useState<Record<string, string>>({});
  /* The remove Wizard, while one is open (KeyChainRemove). */
  const [removing, setRemoving] = useState<RemoveTarget | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Job[] | null>(null);
  const [written, setWritten] = useState(false);
  /* The steps of a key being made in the App, as they happen (shared.tsx ProgressList). */
  const [progress, setProgress] = useState<Progress | null>(null);

  /* The wizard's own state. */
  const [path, setPath] = useState<'Derive' | 'In the Key' | 'In the App'>('In the Key');
  const [scheme, setScheme] = useState<'Label' | 'SSH' | 'GPG'>('Label');
  const [deriveType, setDeriveType] = useState('p256');
  const [deriveLabel, setDeriveLabel] = useState('');
  const [devType, setDevType] = useState<DeviceType>('ed25519');
  const [devKind, setDevKind] = useState('ssh');
  const [name, setName] = useState('');
  const [slot, setSlot] = useState<number | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [queue, setQueueState] = useState<Job[]>([]);
  const setQueue = useCallback((next: Job[] | ((q: Job[]) => Job[])) => {
    setQueueState(q => {
      const value = typeof next === 'function' ? (next as (q: Job[]) => Job[])(q) : next;
      void AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(value)).catch(() => {});
      return value;
    });
  }, []);
  const [hostType, setHostType] = useState<HostType>('rsa');
  const [rsaBits, setRsaBits] = useState(2048);
  const [hostStore, setHostStore] = useState(true);
  const [hostCopy, setHostCopy] = useState(false);
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  /*
   * THE WIZARD (owner): the same choices as the panel, one at a time, each
   * saying what it means. It sets the panel's own values and calls the same
   * actions, so there is one way to make a key underneath. 0 = closed.
   */
  const [wizard, setWizard] = useState(0);
  const [scope, setScope] = useState<'key' | 'app'>('key');

  /* A host-made private key is in memory during its step: keep it off screenshots. */
  useSecureScreen(blockScreenshots && (busy === 'host' || hostCopy));

  const saveEntries = useCallback(async (next: Entry[]) => {
    setEntries(next);
    try {
      await AsyncStorage.setItem(LIST_KEY, keychain.list.serialize(next));
    } catch {
      /* the list stays in memory for this visit */
    }
  }, []);

  /* Read-modify-write from storage, so two copies saved in one step both stay. */
  const addCopy = useCallback(async (c: Omit<Copy, 'id' | 'made'>) => {
    const made = new Date().toISOString();
    const next = [...(await loadJson<Copy[]>(COPIES_KEY, [])), {...c, id: `${made}-${Math.random().toString(36).slice(2, 8)}`, made}];
    await AsyncStorage.setItem(COPIES_KEY, JSON.stringify(next));
    setCopies(next);
  }, []);
  const removeCopy = useCallback(async (id: string) => {
    const next = (await loadJson<Copy[]>(COPIES_KEY, [])).filter(c => c.id !== id);
    await AsyncStorage.setItem(COPIES_KEY, JSON.stringify(next)).catch(() => {});
    setCopies(next);
  }, []);

  /* The remove Wizard's phone-side removal: the list entry and/or copies, at once. */
  const removeNow = useCallback(async (entryId: string | null, copyIds: string[]) => {
    if (entryId) await saveEntries(entries.filter(x => x.id !== entryId));
    for (const id of copyIds) await removeCopy(id);
    setOpen(null);
    setStatus('Removed from the App.');
  }, [entries, saveEntries, removeCopy]);

  /* The phone list and the cached slot reading, and any pending job. */
  useEffect(() => {
    void (async () => {
      setCopies(await loadJson<Copy[]>(COPIES_KEY, []));
      setPgpTodo(await loadJson<PgpTodo | null>(PGP_TODO_KEY, null));
      try {
        const raw = await AsyncStorage.getItem(LIST_KEY);
        if (raw) setEntries(keychain.list.parse(raw));
      } catch (e) {
        setError(`The Key Chain list on this phone could not be read: ${String((e as Error)?.message ?? e)}`);
      }
      const cached = await loadJson<{slot: number; kind: string; bits?: number; label: string}[] | null>(CACHE_KEY, null);
      if (cached) setSlots(cached);
      setPending(await loadJson<Job[] | null>(PENDING_KEY, null));
      const savedQueue = await loadJson<Job[]>(QUEUE_KEY, []);
      /* A Wizard you had under way (config mode unmounted it) comes back where it was. */
      if (await AsyncStorage.getItem(WIZARD_SAVE_KEY).catch(() => null)) setWizard(1);
      /* Restored, but NOT opened: a panel appears only when its button is pressed (owner). */
      if (savedQueue.length) setQueue(savedQueue);
    })();
  }, []);

  const readSlots = useCallback(async () => {
    setBusy('read');
    setError(null);
    try {
      const {device} = await getKey();
      const labels = new Map<number, string>();
      try {
        const {keys} = await device.readKeyLabels();
        for (const k of keys) labels.set(k.slot, k.label || '');
      } catch {
        /* names are a nicety; the probe is the answer */
      }
      const out: Probe[] = [];
      for (const n of SLOTS) {
        const label = labels.get(n) || '';
        const tag = keychain.tag.parseTag(label);
        const p = await device.probeKeySlot(n, {hint: tag ? tag.hint : null});
        out.push({...p, label});
      }
      setSlots(out);
      await AsyncStorage.setItem(
        CACHE_KEY,
        JSON.stringify(out.map(({slot: s, kind, bits, label}) => ({slot: s, kind, bits, label}))),
      ).catch(() => {});
      return out;
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      return null;
    } finally {
      setBusy(null);
    }
  }, [getKey]);

  useEffect(() => {
    const e = entries.find(x => x.id === open);
    if (!e?.pgp || fingerprints[e.id]) return;
    void (async () => {
      try {
        const openpgp = require('node-onlykey-lib/crypto/pgp');
        const key = await openpgp.readKey({armoredKey: e.pgp});
        setFingerprints(f => ({...f, [e.id]: key.getFingerprint().toUpperCase()}));
      } catch {
        setFingerprints(f => ({...f, [e.id]: 'unreadable'}));
      }
    })();
  }, [open, entries, fingerprints]);

  /* After the restart: read the slots the job wrote, then forget the job. */
  useEffect(() => {
    if (!pending || locked || inConfig || busy) return;
    void (async () => {
      setStatus(`Finishing ${pending.length} new key${pending.length === 1 ? '' : 's'}…`);
      const out = await readSlots();
      if (!out) return;
      const missing = pending.filter(j => (out.find(p => p.slot === j.slot) || {kind: 'empty'}).kind === 'empty');
      const pgpJob = pending.find(j => j.pgp);
      if (pgpJob && !missing.length) {
        const todo: PgpTodo = {userId: pgpJob.pgp!.userId, signSlot: pgpJob.slot, ecdhSlot: 101, tag: pgpJob.tag};
        await AsyncStorage.setItem(PGP_TODO_KEY, JSON.stringify(todo)).catch(() => {});
        setPgpTodo(todo);
      }
      await AsyncStorage.removeItem(PENDING_KEY).catch(() => {});
      setPending(null);
      setStatus(
        missing.length
          ? `Not found after the restart: ${missing.map(j => slotName(j.slot)).join(', ')}. Was the key in config mode?`
          : `Done - ${pending.map(j => slotName(j.slot)).join(', ')} ready. Make a fresh backup (Backup/Restore): the new keys are only on this key until you do.`,
      );
    })();
  }, [pending, locked, inConfig, busy, readSlots]);

  /* The PGP certificate for a pair made inside the Key: two device signatures. */
  const buildPgp = useCallback(async () => {
    if (!pgpTodo) return;
    setBusy('pgp');
    setError(null);
    setStatus('Signing your PGP key: the OnlyKey asks twice.');
    try {
      const out = await readSlots();
      const signKey = out?.find(p => p.slot === pgpTodo.signSlot);
      const ecdhKey = out?.find(p => p.slot === pgpTodo.ecdhSlot);
      if (signKey?.kind !== 'ed25519' || ecdhKey?.kind !== 'x25519' || !signKey.publicKey || !ecdhKey.publicKey) {
        throw new Error(`${slotName(pgpTodo.signSlot)} must hold an Ed25519 key and ${slotName(pgpTodo.ecdhSlot)} an X25519 key; they read ${signKey?.kind ?? 'empty'} and ${ecdhKey?.kind ?? 'empty'}.`);
      }
      setBusy('pgp');
      const {okcrypto} = await getKey();
      const openpgp = require('node-onlykey-lib/crypto/pgp');
      const {pgpCert} = require('node-onlykey-lib/crypto');
      const cert = await pgpCert.buildCertificate(openpgp, {
        userId: pgpTodo.userId,
        curve: 'ed25519',
        created: Math.floor(Date.now() / 1000),
        signPublic: signKey.publicKey,
        ecdhPublic: ecdhKey.publicKey,
        sign: async (digest: Uint8Array) => {
          try {
            return await okcrypto.sign(pgpTodo.signSlot, digest, {
              expectBytes: 64,
              confirm: ({digits}: {digits: number[]}) => setChallenge(digits),
            });
          } finally {
            setChallenge(null);
          }
        },
      });
      const made = keychain.list.createEntry({
        kind: 'external',
        name: pgpTodo.userId,
        slots: [pgpTodo.ecdhSlot, pgpTodo.signSlot],
        type: 'ed25519',
        publicKey: signKey.publicKey,
        pgp: cert.armored,
      });
      await saveEntries(keychain.list.merge(entries, [made]).entries);
      await AsyncStorage.removeItem(PGP_TODO_KEY).catch(() => {});
      setPgpTodo(null);
      setStatus(`Your PGP public key is in "On this App" (fingerprint ${cert.fingerprint.slice(-16)}). Share it so people can encrypt to you.`);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setStatus(null);
    } finally {
      setChallenge(null);
      setBusy(null);
    }
  }, [pgpTodo, readSlots, getKey, entries, saveEntries]);

  const copy = useCallback(async (text: string, what: string) => {
    try {
      await NativeSecrets.copySensitive(text, CLIPBOARD_TTL_MS);
      setStatus(`${what} copied.`);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, []);

  /* ---------------------------------------------------------- derive */
  /*
   * THE ACTIONS take what to make as arguments, so the Wizard and the "+ Add"
   * panel share one implementation of each (no second way to make a key).
   * Each returns true when it worked; failures land in `error`.
   */
  const deriveWith = useCallback(async (d: {scheme: string; type: string; label: string}) => {
    setBusy('derive');
    setError(null);
    setStatus(null);
    try {
      const {okcrypto} = await getKey();
      const entry = await keychain.derive.derivePublic(okcrypto, {scheme: d.scheme, type: d.type, label: d.label.trim()});
      const made = keychain.list.createEntry(entry);
      const {entries: next, added} = keychain.list.merge(entries, [made]);
      await saveEntries(next);
      setStatus(added ? `Derived and kept in the App: ${d.label.trim()}.` : 'Already in the App.');
      setOpen(made.id);
      return true;
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      return false;
    } finally {
      setBusy(null);
    }
  }, [getKey, entries, saveEntries]);
  const derive = useCallback(async () => {
    if (await deriveWith({scheme: scheme.toLowerCase(), type: deriveType, label: deriveLabel})) setAdding(false);
  }, [deriveWith, scheme, deriveType, deriveLabel]);

  /* ---------------------------------------------------------- on the OnlyKey */
  const taken = (n: number) => {
    const p = slots?.find(s => s.slot === n);
    return Boolean(p && (p.kind !== 'empty' || p.label)) || queue.some(j => j.slot === n);
  };
  const addToQueue = () => {
    setError(null);
    if (slot === null) return setError('Choose a slot.');
    let tag: string | null = null;
    if (name.trim()) {
      try {
        tag = keychain.tag.formatTag(devKind, name.trim());
      } catch (e) {
        return setError(String((e as Error)?.message ?? e));
      }
    }
    if (taken(slot) && confirmText !== 'REPLACE') {
      return setError(`${slotName(slot)} holds a key. Type REPLACE to write over it - the old key is destroyed.`);
    }
    setQueue(q => [...q, {slot, type: devType, tag}]);
    setSlot(null);
    setName('');
    setConfirmText('');
  };

  const addJobs = (jobs: Job[]) => setQueue(q => [...q.filter(j => !jobs.some(n => n.slot === j.slot)), ...jobs]);

  /*
   * WRITE ASKS FIRST (owner): it is the one step that destroys keys - every
   * queued slot that holds a key now loses it - so the confirmation names each
   * slot and what is in it before anything is sent.
   */
  const confirmWrite = () => {
    const lines = queue.map(j => {
      const p = slots?.find(s => s.slot === j.slot);
      const held = p && p.kind !== 'empty' ? ` - replaces ${p.label ? `"${p.label}" ` : ''}(${p.kind})` : '';
      if (j.op === 'wipe') return `${slotName(j.slot)}: WIPE - destroys ${j.tag ? `"${j.tag}" ` : ''}(${j.type})`;
      return `${slotName(j.slot)}: ${j.type}${held}`;
    });
    const replacing = queue.some(j => {
      const p = slots?.find(s => s.slot === j.slot);
      return j.op === 'wipe' || (p && p.kind !== 'empty');
    });
    Alert.alert(
      (() => {
        const w = queue.filter(j => j.op === 'wipe').length;
        const m = queue.length - w;
        const keys = `${m} key${m === 1 ? '' : 's'}`;
        const slotsTxt = `${w} slot${w === 1 ? '' : 's'}`;
        return w && m ? `Write ${keys} and wipe ${slotsTxt} on the OnlyKey?` : w ? `Wipe ${slotsTxt} on the OnlyKey?` : `Write ${keys} to the OnlyKey?`;
      })(),
      `${lines.join('\n')}${replacing ? '\n\nA key that is replaced or wiped is destroyed for good.' : ''}`,
      [{text: 'Cancel', style: 'cancel'}, {text: queue.every(j => j.op === 'wipe') ? 'Wipe' : 'Write', style: 'destructive', onPress: () => void writeQueue()}],
    );
  };

  const writeQueue = useCallback(async () => {
    setBusy('write');
    setError(null);
    setStatus(null);
    try {
      const {device} = await getKey();
      const wiped: Job[] = [];
      for (const job of queue) {
        if (job.op === 'wipe') {
          await device.wipeKey(job.slot);
          wiped.push(job);
          continue;
        }
        const spec = DEVICE_TYPES.find(t => t.type === job.type)!;
        if (spec.ecc) {
          await device.generateEccKey(job.slot, spec.ecc, {[spec.use as string]: true, label: job.tag});
        } else {
          await device.generateKey(job.slot, spec.pq, {label: job.tag});
        }
      }
      const made = queue.filter(j => j.op !== 'wipe');
      if (made.length) await addPending(made);
      if (wiped.length) {
        /* Only now that the OnlyKey's key is gone does the App let go of it. */
        const gone = new Set(wiped.map(j => j.removeEntry).filter(Boolean));
        if (gone.size) await saveEntries(entries.filter(e => !gone.has(e.id)));
        for (const id of new Set(wiped.flatMap(j => j.removeCopies || []))) await removeCopy(id);
        const next = (slots || []).map(p => (wiped.some(j => j.slot === p.slot) ? {...p, kind: 'empty', label: '', publicKey: undefined} : p));
        setSlots(next);
        await AsyncStorage.setItem(
          CACHE_KEY,
          JSON.stringify(next.map(({slot: n, kind, bits, label}) => ({slot: n, kind, bits, label}))),
        ).catch(() => {});
      }
      setPending(null);
      setWritten(true);
      setStatus(
        [
          made.length ? `Wrote ${made.length} key${made.length === 1 ? '' : 's'}` : '',
          wiped.length ? `wiped ${wiped.map(j => slotName(j.slot)).join(', ')}` : '',
        ].filter(Boolean).join(', ').replace(/^./, c => c.toUpperCase()) +
          (made.length ? '. The key reads public keys only after a restart; Key Chain finishes when you are back.' : '. Restart the key to leave config mode.'),
      );
      setQueue([]);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [getKey, queue, entries, saveEntries, removeCopy, slots]);

  /* ---------------------------------------------------------- on this phone */
  const makeHostWith = useCallback(async (h: {
    type: HostType; bits: number; slot: number | null; kind: string; name: string; pass: string | null;
  }) => {
    setBusy('host');
    setError(null);
    setStatus(null);
    let key: any = null;
    try {
      if (h.slot === null && h.pass === null) throw new Error('Store it on the Key, keep an encrypted copy, or both - otherwise it is made and lost.');
      const stages = ['Making the key', ...(h.pass !== null ? ['Protecting the copy'] : []), ...(h.slot !== null ? ['Writing it to the OnlyKey'] : [])];
      setProgress({stages, at: 0, pct: null});
      key = await keychain.generate.hostKey(h.type, {bits: h.bits});
      if (h.pass !== null) {
        setProgress({stages, at: 1, pct: 0});
        const pemKey = h.type === 'rsa' ? {type: 'rsa', p: key.p, q: key.q, e: key.e} : {type: h.type, secret: key.secret};
        const pem: string = await keychain.export.encryptedPem(pemKey, h.pass, {
          confirm: h.pass,
          onProgress: (pct: number) => setProgress({stages, at: 1, pct}),
        });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await addCopy({
          title: `${h.name.trim() || h.type}  ·  ${h.type === 'rsa' ? `RSA ${h.bits}` : h.type}`,
          file: `onlykey-${h.type}-${stamp}.pem`, mime: 'application/x-pem-file', text: pem,
          where: h.slot !== null ? `also in ${slotName(h.slot)}` : 'only copy - not on the Key',
        });
      }
      const tag = h.name.trim() ? keychain.tag.formatTag(h.kind, h.name.trim()) : null;
      if (h.slot !== null) {
        setProgress({stages, at: stages.length - 1, pct: null});
        const {device} = await getKey();
        const use = h.type === 'x25519' ? {decryption: true} : {signature: true};
        const okdev = require('node-onlykey-lib/device');
        const prepared = okdev.keys.prepareKey(key.material, {slot: h.slot, ...use});
        await device.loadKey(h.slot, {type: prepared.type, key: prepared.key}, {label: tag});
        prepared.key.fill(0);
        await addPending([{slot: h.slot, type: h.type as DeviceType, tag}]);
        setWritten(true);
      } else {
        const made = keychain.list.createEntry({
          kind: 'external',
          name: h.name.trim() || `${h.type} ${new Date().toISOString().slice(0, 10)}`,
          type: h.type,
          publicKey: key.publicKey,
        });
        await saveEntries(keychain.list.merge(entries, [made]).entries);
      }
      setStatus(
        h.slot !== null
          ? `Made in the App and stored in ${slotName(h.slot)}${h.pass !== null ? ', with an encrypted copy' : ''}. Restart to finish.`
          : 'Made in the App: the encrypted copy and its public key are kept in "On this App".',
      );
      return true;
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      return false;
    } finally {
      if (key) keychain.generate.wipe(key);
      setProgress(null);
      setBusy(null);
    }
  }, [getKey, entries, saveEntries, addCopy]);

  /*
   * A WHOLE PGP KEY made in the App (RSA - for PGP setups that need it): the
   * signing key and the encryption subkey loaded where the PGP pages look for
   * them (loadPgpKey: decryption in slot 1, signing in slot 2), an armored
   * encrypted copy, and the public key to share kept in the App.
   */
  const makePgpInApp = useCallback(async (g: {name: string; email: string; bits: number; pass: string | null; tagName: string; ecc?: boolean}) => {
    setBusy('host');
    setError(null);
    setStatus(null);
    try {
      const stages = ['Making the PGP key', ...(g.pass !== null ? ['Protecting the copy'] : []), 'Writing it to the OnlyKey'];
      setProgress({stages, at: 0, pct: null});
      const openpgp = require('node-onlykey-lib/crypto/pgp');
      const userId = g.email.trim() ? {name: g.name.trim(), email: g.email.trim()} : {name: g.name.trim()};
      const {privateKey} = await openpgp.generateKey({
        ...(g.ecc ? {type: 'ecc', curve: 'curve25519'} : {type: 'rsa', rsaBits: g.bits}),
        userIDs: [userId], format: 'object',
      });
      if (g.pass !== null) {
        setProgress({stages, at: 1, pct: null});
        const armored: string = await keychain.export.encryptedPgp(privateKey, g.pass, {confirm: g.pass, openpgp});
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await addCopy({
          title: `${g.tagName.trim() || g.name.trim()}  ·  PGP ${g.ecc ? 'Ed25519' : `RSA ${g.bits}`}`,
          file: `onlykey-pgp-${stamp}.asc`, mime: 'application/pgp-keys', text: armored,
          where: g.ecc ? 'also in ECC1 and ECC2' : 'also in RSA1 and RSA2',
        });
      }
      setProgress({stages, at: stages.length - 1, pct: null});
      const {device} = await getKey();
      const loaded: {slot: number; role: string}[] = await device.loadPgpKey(privateKey, {});
      const tag = g.tagName.trim() ? keychain.tag.formatTag('pgp', g.tagName.trim()) : null;
      if (tag) for (const l of loaded) await device.setKeyLabel(l.slot, tag);
      await addPending(loaded.map(l => ({slot: l.slot, type: (g.ecc ? 'ed25519' : 'rsa') as DeviceType, tag})));
      const publicArmored: string = privateKey.toPublic().armor();
      const made = keychain.list.createEntry({
        kind: 'external',
        name: g.tagName.trim() || g.name.trim(),
        type: g.ecc ? 'ed25519' : 'rsa',
        publicKey: g.ecc ? privateKey.keyPacket.publicParams.A ?? privateKey.keyPacket.publicParams.Q : privateKey.keyPacket.publicParams.n,
        pgp: publicArmored,
        slots: loaded.map(l => l.slot),
      });
      await saveEntries(keychain.list.merge(entries, [made]).entries);
      setWritten(true);
      setStatus(`PGP key made and loaded: ${loaded.map(l => `${l.role} in ${slotName(l.slot)}`).join(', ')}. Its public key is in "On this App". Restart to finish.`);
      return true;
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      return false;
    } finally {
      setProgress(null);
      setBusy(null);
    }
  }, [getKey, entries, saveEntries, addCopy]);

  /* The panel's "Make the key": its fields checked, then the shared action. */
  const makeHost = useCallback(async () => {
    setError(null);
    if (hostCopy && pass1 !== pass2) return setError('The two passphrases differ.');
    if (hostCopy && pass1.length < 25) return setError('The copy\'s passphrase is at least 25 characters (the backup passphrase\'s rule).');
    if (hostStore && slot === null) return setError('Choose a slot to store it in.');
    if (hostStore && slot !== null && taken(slot) && confirmText !== 'REPLACE') {
      return setError(`${slotName(slot)} holds a key. Type REPLACE to write over it.`);
    }
    const ok = await makeHostWith({
      type: hostType, bits: rsaBits, slot: hostStore ? slot : null,
      kind: hostType === 'x25519' ? 'enc' : 'sig', name, pass: hostCopy ? pass1 : null,
    });
    if (ok) {
      setPass1('');
      setPass2('');
      setAdding(false);
    }
  }, [makeHostWith, hostType, rsaBits, hostStore, hostCopy, pass1, pass2, slot, name, confirmText]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------------------------------------------------- list file */
  const exportList = useCallback(async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    await NativeShare.shareFile(`onlykey-keychain-${stamp}.json`, keychain.list.serialize(entries), 'application/json', 'Key Chain list');
  }, [entries]);
  const importList = useCallback(async () => {
    setError(null);
    try {
      const picked = await NativeShare.pickTextFile('application/json');
      if (!picked.picked) return;
      const incoming = keychain.list.parse(picked.content);
      const {entries: next, added, kept} = keychain.list.merge(entries, incoming);
      await saveEntries(next);
      setStatus(`Imported ${added}${kept ? ` (${kept} already here)` : ''}.`);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, [entries, saveEntries]);

  /* ---------------------------------------------------------- views */
  /*
   * THE OPEN ENTRY IS WHERE A KEY'S DETAILS ARE, AND WHERE IT IS SHARED FROM
   * (owner): the fingerprint people compare, the PGP public key, and Share -
   * the PGP key as a .asc file, otherwise the SSH line, age recipient or the
   * raw public key as text. Public data only.
   */
  const shareKey = (name: string, a: Entry['artifacts'], pgp?: string) => {
    const base = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'key';
    if (pgp) return void NativeShare.shareFile(`${base}.asc`, pgp, 'application/pgp-keys', 'PGP public key');
    const text = a.ssh || a.age || a.hex;
    return void NativeShare.shareFile(`${base}${a.ssh ? '.pub' : '.txt'}`, `${text}\n`, 'text/plain', 'Public key');
  };
  /*
   * WHAT A REMOVE IS ABOUT: the OnlyKey slots an App entry stands for (its
   * recorded slots, or a slot holding the same public key), a PGP pair's
   * partner slot (same label), and encrypted copies made for those slots.
   */
  const slotByName = (text: string) => {
    const m = /^(RSA|ECC)(\d+)$/.exec(text);
    return m ? (m[1] === 'RSA' ? Number(m[2]) : 100 + Number(m[2])) : null;
  };
  const copiesFor = (nums: number[]) => copies
    .filter(c => (c.where.match(/\b(?:RSA|ECC)\d+\b/g) || []).some(n => nums.includes(slotByName(n) ?? -1)))
    .map(c => ({id: c.id, title: c.title}));
  const hexOf = (b?: Uint8Array) => (b ? Array.from(b, x => x.toString(16).padStart(2, '0')).join('') : '');
  const withPartners = (found: Probe[]) => {
    const out = new Map(found.map(p => [p.slot, p]));
    for (const p of found) {
      if (p.label && keychain.tag.parseTag(p.label)?.kind === 'pgp') {
        for (const o of slots || []) if (o.label === p.label && o.kind !== 'empty') out.set(o.slot, o);
      }
    }
    return [...out.values()].sort((x, y) => x.slot - y.slot);
  };
  const targetForEntry = (e: Entry): RemoveTarget => {
    const pk = hexOf(e.publicKey);
    const found = e.kind === 'derived' ? [] : (slots || []).filter(
      p => p.kind !== 'empty' && ((e.slots || []).includes(p.slot) || (pk !== '' && hexOf(p.publicKey) === pk)),
    );
    const s = withPartners(found);
    const tag = s.length && s[0].label ? keychain.tag.parseTag(s[0].label) : null;
    return {
      title: e.label || e.name || 'this key',
      entryId: e.id,
      derived: e.kind === 'derived',
      kind: tag?.kind ?? (e.pgp ? 'pgp' : null),
      slots: s.map(p => ({slot: p.slot, kind: p.kind, label: p.label})),
      copies: copiesFor(s.map(p => p.slot)),
    };
  };
  const targetForSlot = (p: Probe): RemoveTarget => {
    const s = withPartners([p]);
    const nums = s.map(x => x.slot);
    const pks = s.map(x => hexOf(x.publicKey)).filter(Boolean);
    const e = entries.find(x => (x.slots || []).some(n => nums.includes(n)) || pks.includes(hexOf(x.publicKey)));
    const tag = p.label ? keychain.tag.parseTag(p.label) : null;
    return {
      title: e ? e.label || e.name || slotName(p.slot) : tag ? `${tag.name} (${slotName(p.slot)})` : slotName(p.slot),
      entryId: e?.id ?? null,
      derived: false,
      kind: tag?.kind ?? null,
      slots: s.map(x => ({slot: x.slot, kind: x.kind, label: x.label})),
      copies: copiesFor(nums),
    };
  };

  const artifactRows = (a: Entry['artifacts'], more?: {name: string; pgp?: string; id?: string}) => (
    <View style={styles.detail}>
      {more?.pgp ? (
        <>
          <CopyRow
            title="finger­print"
            value={more.id && fingerprints[more.id] ? fingerprints[more.id].replace(/(.{4})/g, '$1 ').trim() : 'reading…'}
            onCopy={() => more.id && fingerprints[more.id] && copy(fingerprints[more.id], 'Fingerprint')}
          />
          <CopyRow title="PGP" value="public key block (to import into PGP software)" onCopy={() => copy(more.pgp as string, 'PGP public key')} />
        </>
      ) : null}
      {a.ssh ? <CopyRow title="SSH" value={a.ssh} onCopy={() => copy(a.ssh as string, 'SSH key')} /> : null}
      {a.age ? <CopyRow title="age" value={a.age} onCopy={() => copy(a.age as string, 'age recipient')} /> : null}
      <CopyRow title="hex" value={a.hex} onCopy={() => copy(a.hex, 'Public key')} />
      {more ? <Btn title={more.pgp ? 'Share PGP public key' : 'Share public key'} tone="primary" onPress={() => shareKey(more.name, a, more.pgp)} /> : null}
    </View>
  );

  const slotRows = (slots || []).filter(p => p.kind !== 'empty' || p.label);
  /* The use flag the key being made will get - what decides each slot's outcome. */
  const keyUse: 'signature' | 'decryption' = path === 'In the App'
    ? (hostType === 'x25519' ? 'decryption' : 'signature')
    : (['x25519', 'xwing', 'mlkem768'].includes(devType) ? 'decryption' : 'signature');
  const devSpec = DEVICE_TYPES.find(t => t.type === devType)!;

  /*
   * EACH PANEL ADDS ITS OWN (owner): "On this Key" makes keys that end up IN
   * the Key (made there, or made in the App and stored); "On this App" makes
   * what the App keeps (derived public keys, or an App-made key kept as an
   * encrypted copy with its public half in the list). The editor - Wizard or
   * the panel - opens under the panel that asked.
   */
  const openEditor = (which: 'key' | 'app', asWizard: boolean) => {
    const same = scope === which && (asWizard ? wizard > 0 : adding);
    setScope(which);
    if (same) {
      setWizard(0);
      setAdding(false);
      return;
    }
    setPath(which === 'key' ? 'In the Key' : 'Derive');
    setHostStore(which === 'key');
    setHostCopy(which === 'app');
    setWizard(asWizard ? 1 : 0);
    setAdding(!asWizard);
  };

  const configPanel = (
    <ConfigModePanel
      state={configMode}
      emu={emu}
      backend={backend}
      onWant={onWantConfigMode}
      purpose="write keys to the key"
    />
  );

  const editor = (
    <>

      {adding ? (
        <Section title="Add a key">
          <Segmented
            options={PATHS[scope]}
            value={path}
            onChange={setPath}
          />

          {path === 'Derive' ? (
            <>
              <Text style={styles.body}>
                The key makes a public key from a label; its private half is made again whenever it is needed and never
                kept anywhere. No config mode.
              </Text>
              <Segmented
                options={['Label', 'SSH', 'GPG'] as const}
                value={scheme}
                onChange={v => {
                  setScheme(v);
                  setDeriveType(v === 'Label' ? 'p256' : 'ed25519');
                }}
              />
              <Text style={styles.note}>{SCHEME_INFO[scheme]}</Text>
              <View style={styles.chips}>
                {(scheme === 'Label' ? ['p256', 'secp256k1', 'x25519', 'xwing'] : ['ed25519', 'p256']).map(t => (
                  <Btn key={t} title={t} tone={t === deriveType ? 'primary' : 'default'} onPress={() => setDeriveType(t)} />
                ))}
              </View>
              <Text style={styles.note}>{TYPE_INFO[deriveType]}</Text>
              <TextInput
                value={deriveLabel}
                onChangeText={setDeriveLabel}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={scheme === 'SSH' ? 'user@host' : scheme === 'GPG' ? 'Name <email>' : 'label (e.g. example.com)'}
                placeholderTextColor={theme.textDim}
                style={styles.input}
              />
              <Btn
                title={busy === 'derive' ? 'Deriving…' : 'Derive and keep'}
                tone="primary"
                disabled={busy !== null || locked || !deriveLabel.trim()}
                onPress={() => void derive()}
              />
            </>
          ) : null}

          {path === 'In the Key' ? (
            <>
              <Text style={styles.body}>
                Made in the Key itself: the private half never exists anywhere else. Collect one or more here, then
                write them all in one config-mode visit.
              </Text>
              <View style={styles.chips}>
                {DEVICE_TYPES.map(t => (
                  <Btn
                    key={t.type}
                    title={t.title}
                    tone={t.type === devType ? 'primary' : 'default'}
                    onPress={() => {
                      setDevType(t.type);
                      setDevKind(t.kinds[0]);
                    }}
                  />
                ))}
              </View>
              <Text style={styles.note}>{TYPE_INFO[devType]}</Text>
              {devSpec.kinds.length > 1 ? (
                <View style={styles.chips}>
                  {devSpec.kinds.map(k => (
                    <Btn key={k} title={KIND_TITLE[k]} tone={k === devKind ? 'primary' : 'default'} onPress={() => setDevKind(k)} />
                  ))}
                </View>
              ) : null}
              <Text style={styles.note}>{KIND_INFO[devKind]}</Text>
              <SlotChips slots={SLOTS.filter(n => n >= 101)} value={slot} taken={taken} onChange={setSlot} />
              <Text style={styles.note}>
                The slot is where on the Key it is stored. ● means it already holds a key — writing over it destroys that key.
                ECC1 and ECC2 (RSA1 and RSA2 for RSA) are the slots the web app and desktop App use for PGP decryption and
                signing; keep them for PGP keys.
              </Text>
              {slot !== null ? (
                <Text style={slotOutcome(slot, keyUse).warn ? styles.outcomeWarn : styles.outcomeOk}>
                  {slotName(slot)}: {slotOutcome(slot, keyUse).text}
                </Text>
              ) : null}
              <TextInput
                value={name}
                onChangeText={setName}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={12}
                placeholder="name (optional, up to 12)"
                placeholderTextColor={theme.textDim}
                style={styles.input}
              />
              {slot !== null && taken(slot) ? (
                <TextInput
                  value={confirmText}
                  onChangeText={setConfirmText}
                  autoCapitalize="characters"
                  placeholder="type REPLACE to write over it"
                  placeholderTextColor={theme.textDim}
                  style={styles.input}
                />
              ) : null}
              <Text style={styles.note}>
                The name is saved on the Key as its label{name.trim() ? ` ("${devKind}:${name.trim()}")` : ''} — every OnlyKey app shows it.
              </Text>
              <Btn title="Add to the list to write" disabled={slot === null} onPress={addToQueue} />
              <Text style={styles.note}>Adds it to "Waiting to be written" at the top. Nothing touches the Key yet.</Text>
            </>
          ) : null}

          {path === 'In the App' ? (
            <>
              <Text style={styles.body}>
                Made in the App, in memory: for RSA (the key cannot make it) or a key you want to use elsewhere.
                Store it on the key, keep an encrypted copy, or both - then it is wiped from the phone.
              </Text>
              <View style={styles.chips}>
                {(['rsa', 'ed25519', 'p256', 'secp256k1', 'x25519'] as HostType[]).map(t => (
                  <Btn key={t} title={t === 'rsa' ? 'RSA' : t} tone={t === hostType ? 'primary' : 'default'} onPress={() => setHostType(t)} />
                ))}
              </View>
              <Text style={styles.note}>{TYPE_INFO[hostType]}</Text>
              {hostType === 'rsa' ? (
                <View style={styles.chips}>
                  {[2048, 3072, 4096].map(b => (
                    <Btn key={b} title={String(b)} tone={b === rsaBits ? 'primary' : 'default'} onPress={() => setRsaBits(b)} />
                  ))}
                </View>
              ) : null}
              {hostType === 'rsa' ? (
                <Text style={styles.note}>Bits: bigger is stronger and slower. 2048 is standard; 4096 the most cautious.</Text>
              ) : null}
              <View style={styles.chips}>
                <Btn title="Store on the key" tone={hostStore ? 'primary' : 'default'} onPress={() => setHostStore(s => !s)} />
                <Btn title="Encrypted copy (PEM)" tone={hostCopy ? 'primary' : 'default'} onPress={() => setHostCopy(c => !c)} />
              </View>
              <Text style={styles.note}>
                Store on the key: loaded into a slot, then wiped from the App. Encrypted copy: kept in the App under a passphrase,
                to share or save as a file later from "On this App". Pick one or both.
              </Text>
              {hostStore ? (
                <SlotChips
                  slots={hostType === 'rsa' ? [1, 2, 3, 4] : SLOTS.filter(n => n >= 101)}
                  value={slot}
                  taken={taken}
                  onChange={setSlot}
                />
              ) : null}
              <TextInput
                value={name}
                onChangeText={setName}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={12}
                placeholder="name (optional, up to 12)"
                placeholderTextColor={theme.textDim}
                style={styles.input}
              />
              {hostStore && slot !== null && taken(slot) ? (
                <TextInput
                  value={confirmText}
                  onChangeText={setConfirmText}
                  autoCapitalize="characters"
                  placeholder="type REPLACE to write over it"
                  placeholderTextColor={theme.textDim}
                  style={styles.input}
                />
              ) : null}
              {hostCopy ? (
                <>
                  <TextInput value={pass1} onChangeText={setPass1} secureTextEntry autoCapitalize="none" autoCorrect={false}
                    placeholder="passphrase for the copy (25+)" placeholderTextColor={theme.textDim} style={styles.input} />
                  <TextInput value={pass2} onChangeText={setPass2} secureTextEntry autoCapitalize="none" autoCorrect={false}
                    placeholder="again" placeholderTextColor={theme.textDim} style={styles.input} />
                </>
              ) : null}
              <Btn
                title={busy === 'host' ? (hostType === 'rsa' ? 'Making the RSA key…' : 'Making…') : 'Make the key'}
                tone="primary"
                disabled={busy !== null || (hostStore && !inConfig)}
                onPress={() => void makeHost()}
              />
              {progress ? <ProgressList progress={progress} /> : null}
              {hostStore && !inConfig ? <Text style={styles.note}>Storing on the key: {NEEDS_CONFIG_MODE}</Text> : null}
            </>
          ) : null}
        </Section>
      ) : null}

    </>
  );

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {status ? <Text style={styles.status}>{status}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {/*
        ONE WIZARD for the whole tab (owner): its first question - does the
        private key ever need to leave the OnlyKey? - already decides whether
        the key ends up On this Key or On this App, so it needs no panel of
        its own. The panels keep "+ Add" for people who know what they want.
      */}
      <Btn
        title={wizard ? 'Close the Wizard' : 'Add a key — Wizard'}
        tone={wizard ? 'default' : 'primary'}
        onPress={() => {
          setAdding(false);
          setRemoving(null);
          if (wizard) void AsyncStorage.removeItem(WIZARD_SAVE_KEY).catch(() => {});
          setWizard(w => (w ? 0 : 1));
        }}
      />
      {wizard ? (
        <KeyChainWizard
          onClose={() => setWizard(0)}
          slots={slots}
          taken={taken}
          inConfig={inConfig}
          locked={locked}
          busy={busy}
          addJobs={addJobs}
          makeHostWith={makeHostWith}
          makePgpInApp={makePgpInApp}
          deriveWith={deriveWith}
          onQueued={() => setWizard(0)}
          configPanel={configPanel}
          progress={progress}
        />
      ) : null}
      {removing ? (
        <KeyChainRemove target={removing} busy={busy} onClose={() => setRemoving(null)} removeNow={removeNow} addJobs={addJobs} />
      ) : null}

      {/*
        WAITING TO BE WRITTEN - ITS OWN PANEL (owner): whatever was queued, by
        the Wizard or the panels, shows here whenever there is any, until it is
        written or removed - not tucked inside "+ Add". Writing needs config
        mode, so the config mode panel sits right under it while it waits.
      */}
      {queue.length ? (
        <Section title={`Waiting to be written (${queue.length})`}>
          {queue.map(j => {
            const p = slots?.find(s => s.slot === j.slot);
            const held = p && p.kind !== 'empty';
            const outcome = slotOutcome(j.slot, j.type === 'x25519' || j.type === 'xwing' || j.type === 'mlkem768' ? 'decryption' : 'signature');
            return (
              <View key={j.slot} style={styles.queueRow}>
                <View style={styles.queueText}>
                  <Text style={styles.rowName}>
                    {slotName(j.slot)}  ·  {j.op === 'wipe' ? 'WIPE' : j.type}  ·  {j.tag || '(no name)'}
                  </Text>
                  {j.op === 'wipe' ? (
                    <Text style={styles.outcomeWarn}>
                      Destroys the {j.type} key here{j.removeEntry ? ', and its public key in the App' : ''}
                      {j.removeCopies?.length ? ', and its encrypted copy' : ''}.
                    </Text>
                  ) : (
                    <>
                      {held ? (
                        <Text style={styles.outcomeWarn}>Replaces {p!.label ? `"${p!.label}" ` : ''}({p!.kind}) - that key is destroyed.</Text>
                      ) : (
                        <Text style={styles.note}>Empty slot.</Text>
                      )}
                      <Text style={outcome.warn ? styles.outcomeWarn : styles.note}>{outcome.text}</Text>
                    </>
                  )}
                </View>
                <Btn title="Remove" disabled={busy !== null} onPress={() => setQueue(q => q.filter(x => x.slot !== j.slot))} />
              </View>
            );
          })}
          <View pointerEvents={inConfig ? 'auto' : 'none'} style={inConfig ? null : styles.dim}>
            <Btn
              title={busy === 'write' ? 'Writing…' : `Write ${queue.length} to the key`}
              tone="danger"
              disabled={busy !== null || !inConfig}
              onPress={confirmWrite}
            />
          </View>
          <Text style={styles.note}>
            {inConfig
              ? 'Writes every key above in one go, after you confirm. A restart then finishes them.'
              : 'Writing needs config mode - the panel just below takes you there. The list is kept meanwhile.'}
          </Text>
        </Section>
      ) : null}
      {queue.length && !written ? configPanel : null}

      {pgpTodo && !written ? (
        <Section title="Finish your PGP key">
          <Text style={styles.body}>
            The keys are in {slotName(pgpTodo.ecdhSlot)} (decrypt) and {slotName(pgpTodo.signSlot)} (sign). What PGP software
            imports is a public key signed by the OnlyKey itself, for "{pgpTodo.userId}". The key asks twice: once for
            your name, once for the decrypt key.
          </Text>
          {challenge ? (
            <>
              <Text style={styles.status}>
                The key is waiting: press {challenge.join(' - ')} on it (or any one button, if it is set to a single press).
              </Text>
              {emu.canPress === true ? <Btn title="Press them for me" onPress={() => void emu.pressRun(challenge)} /> : null}
            </>
          ) : null}
          <Btn
            title={busy === 'pgp' ? 'Signing…' : 'Sign it with the OnlyKey'}
            tone="primary"
            disabled={busy !== null || locked || inConfig}
            onPress={() => void buildPgp()}
          />
          {inConfig ? <Text style={styles.note}>Not in config mode: restart the key first.</Text> : null}
        </Section>
      ) : null}

      {written ? (
        <Section title="Restart to finish">
          <Text style={styles.body}>
            Config mode ends only when the key restarts. New keys are read then: Key Chain finishes them when you are
            back on this tab.
          </Text>
          {backend !== 'usb' ? (
            <Btn title="Restart the app" tone="primary" onPress={() => void OkEmu.restartApp()} />
          ) : (
            <Text style={styles.note}>Unplug the key and plug it back in, then unlock it.</Text>
          )}
        </Section>
      ) : null}

      {/*
        THE WIZARD HAS THE SCREEN TO ITSELF (owner): while it is open the
        panels are hidden, so there is one thing to read; closing it brings
        them back. The config mode panel it may need comes along inside it.
      */}
      {wizard || removing ? null : (
      <>
      <Section
        title={`On this Key — ${keyName}`}
        right={
          <View style={styles.headerButtons}>
            <Btn title={adding && scope === 'key' ? 'Close' : '+ Add'} tone="primary" onPress={() => openEditor('key', false)} />
          </View>
        }>
        {inConfig ? (
          <Text style={styles.note}>
            In config mode the key answers no public-key read, so this shows the last reading.
          </Text>
        ) : null}
        {slotRows.length ? (
          slotRows.map(p => {
            const id = `slot${p.slot}`;
            const tag = keychain.tag.parseTag(p.label);
            const a = p.publicKey ? keychain.artifacts.forKey({type: p.kind, publicKey: p.publicKey}) : null;
            return (
              <View key={id}>
                <Pressable onPress={() => setOpen(o => (o === id ? null : id))} style={styles.row}>
                  <Text style={styles.rowSlot}>{slotName(p.slot)}</Text>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {tag ? `${tag.name}  ·  ${KIND_TITLE[tag.kind] || tag.kind}` : p.label || '(no name)'}
                  </Text>
                  <Text style={styles.rowType}>{p.kind === 'rsa' ? `RSA ${p.bits}` : p.kind}</Text>
                </Pressable>
                {open === id ? (
                  <>
                    {a ? artifactRows(a, {name: tag ? `${tag.kind}-${tag.name}` : slotName(p.slot)}) : null}
                    <Btn title="Remove…" tone="danger" disabled={busy !== null} onPress={() => setRemoving(targetForSlot(p))} />
                  </>
                ) : null}
              </View>
            );
          })
        ) : (
          <Text style={styles.note}>{slots ? 'No keys in RSA1-4 or ECC1-16.' : 'Not read yet.'}</Text>
        )}
        <Btn
          title={busy === 'read' ? 'Reading the slots…' : 'Read the slots'}
          disabled={busy !== null || locked || inConfig}
          onPress={() => void readSlots()}
        />
      </Section>

      {scope === 'key' ? editor : null}

      {/* What the App keeps: derived keys and public halves of keys made here (public data only). */}
      <Section
        title="On this App"
        right={
          <View style={styles.headerButtons}>
            <Btn title={adding && scope === 'app' ? 'Close' : '+ Add'} tone="primary" onPress={() => openEditor('app', false)} />
          </View>
        }>
        {entries.length ? (
          entries.map(e => (
            <View key={e.id}>
              <Pressable onPress={() => setOpen(o => (o === e.id ? null : e.id))} style={styles.row}>
                <Text style={styles.rowSlot}>{e.kind === 'derived' ? e.scheme : 'phone'}</Text>
                <Text style={styles.rowName} numberOfLines={1}>{e.label || e.name}</Text>
                <Text style={styles.rowType}>{e.type}</Text>
              </Pressable>
              {open === e.id ? (
                <>
                  {artifactRows(e.artifacts, {name: e.label || e.name || 'key', pgp: e.pgp, id: e.id})}
                  <Btn title="Remove…" tone="danger" disabled={busy !== null} onPress={() => setRemoving(targetForEntry(e))} />
                </>
              ) : null}
            </View>
          ))
        ) : (
          <Text style={styles.note}>Nothing yet. Derived keys, and public keys of keys made in the App, are kept here — public data only.</Text>
        )}
        {copies.length ? (
          <>
            <Text style={styles.copiesHead}>Encrypted copies</Text>
            {copies.map(c => (
              <View key={c.id}>
                <Pressable onPress={() => setOpen(o => (o === c.id ? null : c.id))} style={styles.row}>
                  <Text style={styles.rowSlot}>copy</Text>
                  <Text style={styles.rowName} numberOfLines={1}>{c.title}</Text>
                  <Text style={styles.rowType}>{c.file.endsWith('.asc') ? 'PGP' : 'PEM'}</Text>
                </Pressable>
                {open === c.id ? (
                  <>
                    <Text style={styles.note}>
                      {c.file} — made {c.made.slice(0, 10)}, {c.where}. Encrypted: opening it needs the passphrase chosen
                      when it was made.
                    </Text>
                    <View style={styles.chips}>
                      <Btn title="Share / save as file" onPress={() => void NativeShare.shareFile(c.file, c.text, c.mime, 'Encrypted private key')} />
                      <Btn
                        title="Delete copy"
                        onPress={() =>
                          Alert.alert(
                            'Delete this encrypted copy?',
                            c.where.startsWith('only')
                              ? 'This is the ONLY copy of this key - it is not on the OnlyKey. Deleted, it is gone for good unless you saved the file somewhere.'
                              : 'The key itself stays on the OnlyKey; only this copy in the App goes.',
                            [{text: 'Keep it', style: 'cancel'}, {text: 'Delete', style: 'destructive', onPress: () => void removeCopy(c.id)}],
                          )
                        }
                      />
                    </View>
                  </>
                ) : null}
              </View>
            ))}
          </>
        ) : null}
        <View style={styles.chips}>
          <Btn title="Export list" disabled={!entries.length} onPress={() => void exportList()} />
          <Btn title="Import list" onPress={() => void importList()} />
        </View>
      </Section>

      {scope === 'app' ? editor : null}

      {queue.length && !written ? null : configPanel}
      </>
      )}
    </ScrollView>
  );
}

function SlotChips({
  slots,
  value,
  taken,
  onChange,
}: {
  slots: number[];
  value: number | null;
  taken: (n: number) => boolean;
  onChange: (n: number) => void;
}) {
  /* Empty slots first: overwriting is the exception, and it asks. */
  const ordered = [...slots.filter(n => !taken(n)), ...slots.filter(n => taken(n))];
  return (
    <View style={styles.chips}>
      {ordered.map(n => (
        <Btn
          key={n}
          title={`${slotName(n)}${taken(n) ? ' ●' : ''}`}
          tone={n === value ? 'primary' : 'default'}
          onPress={() => onChange(n)}
        />
      ))}
    </View>
  );
}

function CopyRow({title, value, onCopy}: {title: string; value: string; onCopy: () => void}) {
  return (
    <View style={styles.copyRow}>
      <Text style={styles.copyTitle}>{title}</Text>
      <Text style={styles.copyValue} numberOfLines={2} selectable>{value}</Text>
      <Btn title="Copy" onPress={onCopy} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  content: {padding: 16, gap: 16, paddingBottom: 48},
  body: {color: theme.textSecondary, fontSize: theme.fontSize, lineHeight: theme.lineHeight},
  note: {color: theme.textDim, fontSize: 12, lineHeight: 18},
  status: {color: theme.ok, fontSize: 13, lineHeight: 20},
  error: {color: theme.error, fontSize: 13, lineHeight: 20},
  input: {
    color: theme.text,
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.inputBg,
  },
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 6},
  row: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8},
  rowSlot: {color: theme.textDim, fontSize: 12, minWidth: 52, fontFamily: theme.mono},
  copiesHead: {color: theme.textDim, fontSize: 12, marginTop: 12, textTransform: 'uppercase', letterSpacing: 1},
  rowName: {color: theme.text, fontSize: 14, flex: 1},
  rowType: {color: theme.textSecondary, fontSize: 12, fontFamily: theme.mono},
  detail: {gap: 8, paddingBottom: 8},
  copyRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  copyTitle: {color: theme.textDim, fontSize: 12, minWidth: 34},
  copyValue: {color: theme.text, fontSize: 11, flex: 1, fontFamily: theme.mono},
  queue: {gap: 4},
  queueRow: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6},
  queueText: {flex: 1, gap: 2},
  dim: {opacity: 0.5},
  headerButtons: {flexDirection: 'row', gap: 8},
  choice: {borderWidth: 1, borderColor: theme.border, borderRadius: theme.radius, padding: 12, gap: 4},
  choiceOn: {borderColor: theme.accent, backgroundColor: theme.surfaceAlt},
  choiceTitle: {color: theme.text, fontSize: 15, fontWeight: '600'},
  review: {color: theme.text, fontSize: 14, lineHeight: 20},
  outcomeOk: {color: theme.ok, fontSize: 12, lineHeight: 18},
  outcomeWarn: {color: theme.warn, fontSize: 12, lineHeight: 18},
});
