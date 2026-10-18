import React, {useCallback, useEffect, useState} from 'react';
import {Alert, BackHandler, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';

import {legacy, totp as totpLib} from 'node-onlykey-lib/passwords';
import NativeSecrets from '../../../specs/NativeSecrets';
import NativeShare from '../../../specs/NativeShare';
import {missingNote} from '../../firmwareFeatures';
import {useSharedBtKeyboard} from '../../hooks/BtKeyboardContext';
import {BACKEND_NAME} from '../../hooks/keySession';
import {useSecureScreen} from '../../hooks/useSecureScreen';
import {getOnlyKey} from '../../onlykey';
import {SlotsScreen} from '../../screens/SlotsScreen';
import {Btn, KeyValue, Section, Segmented} from '../../ui/components';
import {EdgeList, type EdgeListItem} from '../../ui/EdgeList';
import {theme} from '../../ui/theme';
import type {TabContext} from '../types';
import {AutofillCard} from './autofill/AutofillCard';
import {EntryEditor} from './EntryEditor';
import {DerivedEntry, NewDerived} from './DerivedViews';
import {openEntry, sealEntry, stripInner} from './innerKeys';
import {NewPhrase, PhraseEntry} from './PhraseViews';
import {RowActions, type RowAction} from '../../ui/RowActions';
import {TotpCode, TotpRowCode} from './TotpViews';
import {policyWords, timeLeftWords} from './session';
import {usePasswordManager, type OldVault} from './usePasswordManager';
import type {Manager, StorePolicy} from './stores';

/*
 * THE PASSWORDS TAB. Unlocks when the tab opens if that needs no press; otherwise "Open with
 * OnlyKey", so opening the tab never sends a press request by itself (Brad, 2026-10-11). The
 * list is Edge's scrollable list (src/ui/EdgeList.tsx; Brad: "we need to reuse the scrollable list
 * view we use in edge"). An entry and the editor open as a page with ‹ Back and its name, and the
 * phone's own Back goes back too, as Settings and Edge's budget view do.
 */

const CLIPBOARD_TTL_MS = 45000;
/* the kind filter's labels, and the entry kind each picks */
const KIND_FILTERS = ['All', 'Logins', 'Notes', 'Cards', 'Codes', 'Phrases'] as const;
type KindFilter = (typeof KIND_FILTERS)[number];
/* Logins also holds derived passwords: both sign in to a site */
const KIND_OF_FILTER: Record<Exclude<KindFilter, 'All'>, string[]> = {Logins: ['login', 'derived'], Notes: ['note'], Cards: ['card'], Codes: ['totp'], Phrases: ['mnemonic']};

const KIND_TITLE: Record<string, string> = {login: 'Logins', derived: 'Derived passwords', note: 'Notes', card: 'Cards', totp: 'Authenticators', mnemonic: 'Wallet phrases'};

type Entry = {
  id: string;
  kind: 'login' | 'note' | 'card' | 'mnemonic' | 'totp' | 'derived';
  totp?: any;
  recipe?: {label: string; out: string; press: boolean; check: string};
  title: string;
  username?: string;
  password?: string;
  urls?: string[];
  folder?: string;
  tags?: string[];
  /* apps linked by package + signing certificate (Autofill's Link this app) */
  androidApps?: {package: string; cert: string}[];
  notes?: string;
  history?: {password: string; changedAt: string}[];
  inner?: {seal: string; ref?: string; salt?: string; blob: string};
  updatedAt?: string;
};

type NewKind = 'login' | 'note' | 'card' | 'totp';
type Page =
  | {kind: 'list'}
  | {kind: 'add'; id: null}
  | {kind: 'entry'; id: string}
  | {kind: 'edit'; id: string | null; newKind?: NewKind}
  | {kind: 'phrase'; id: null}
  | {kind: 'derive-new'; id: null}
  | {kind: 'to-slot'; id: string};

/* the store's "stays open" choices, in words (stores.ts STORE_POLICIES) */
const POLICY_OF_LABEL = {'5 min': 'session:5m', '30 min': 'session:30m', '8 hours': 'session:8h', 'Until restart': 'startup'} as const;
const POLICY_LABELS = Object.keys(POLICY_OF_LABEL) as (keyof typeof POLICY_OF_LABEL)[];
const POLICY_LABEL_OF = Object.fromEntries(Object.entries(POLICY_OF_LABEL).map(([k, v]) => [v, k])) as Record<StorePolicy, keyof typeof POLICY_OF_LABEL>;

const hostOf = (url: string) => url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0];

async function copy(text: string | undefined, what: string) {
  if (!text) return;
  await NativeSecrets.copySensitive(text, CLIPBOARD_TTL_MS);
  Alert.alert('Copied', `${what} copied. The clipboard is cleared in ${CLIPBOARD_TTL_MS / 1000} seconds.`);
}

export function PasswordsScreen({ctx}: {ctx: TabContext}) {
  const {view, pressAsked, openWithKey, touch, lockNow, retry, oldVault, phraseKey, policy, timeLeft, choosePolicy} = usePasswordManager({
    backend: ctx.backend,
    unlocked: ctx.unlocked,
    caps: ctx.caps,
  });
  const keyName = BACKEND_NAME[ctx.backend];
  useSecureScreen(ctx.blockScreenshots && view.state === 'open');

  /* an authenticator's setup key into one of the active key's TOTP slots (lib device.totpFields, as the slot editor writes it) */
  const writeSlot = async (slotId: string, secret: string) => {
    const {device} = await getOnlyKey(ctx.backend);
    await device.setSlot(slotId, device.totpFields(secret));
  };
  if (view.state === 'open') return <OpenStore manager={view.manager} keyName={keyName} touch={touch} lockNow={lockNow} oldVault={oldVault} phraseKey={phraseKey} timeLeft={timeLeft} policy={policy} choosePolicy={choosePolicy} writeSlot={writeSlot} />;

  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <Section title="Passwords">
        {view.state === 'unsupported' ? (
          <Text style={styles.body}>{missingNote('deviceVault')}</Text>
        ) : view.state === 'reading' ? (
          <Text style={styles.body}>Reading the {keyName}'s firmware…</Text>
        ) : view.state === 'locked-key' ? (
          <Text style={styles.body}>Unlock the {keyName} to see its passwords.</Text>
        ) : view.state === 'checking' ? (
          <Text style={styles.body}>{pressAsked ? 'Press a button on your OnlyKey…' : 'Opening…'}</Text>
        ) : view.state === 'pressing' ? (
          <Text style={styles.body}>
            {ctx.backend === 'usb' ? 'Press a button on your OnlyKey to open your passwords.' : 'Confirm on the key to open your passwords.'}
          </Text>
        ) : view.state === 'button' ? (
          <>
            <Text style={styles.body}>
              {view.isNew
                ? `No password store for this key on this phone yet. Opening makes one, sealed to the ${keyName}: only this key, or a key restored from its backup, opens it.`
                : `Your passwords are sealed to the ${keyName}. Opening asks the key once; the store then stays open for ${policyWords(policy())}, or until the key locks.`}
            </Text>
            <Text style={styles.store}>Store {view.storeId.slice(0, 8)}</Text>
            <Btn title="Open with OnlyKey" tone="primary" onPress={openWithKey} />
          </>
        ) : (
          <>
            <Text style={[styles.body, {color: theme.error}]}>{view.message}</Text>
            <Btn title="Try again" onPress={retry} />
          </>
        )}
      </Section>
    </ScrollView>
  );
}

function OpenStore({
  manager,
  keyName,
  touch,
  lockNow,
  oldVault,
  phraseKey,
  timeLeft,
  policy,
  choosePolicy,
  writeSlot,
}: {
  manager: Manager;
  keyName: string;
  touch: () => boolean;
  lockNow: () => void;
  oldVault: () => Promise<OldVault>;
  phraseKey: Parameters<typeof PhraseEntry>[0]['phraseKey'];
  timeLeft: () => number | null;
  policy: () => string | null;
  choosePolicy: (p: StorePolicy) => Promise<void>;
  writeSlot: (slotId: string, secret: string) => Promise<void>;
}) {
  /* the session's time left, redrawn every 15 s (read-only: it does not keep the session open) */
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 15000);
    return () => clearInterval(t);
  }, []);
  const left = timeLeft();
  const [page, setPage] = useState<Page>({kind: 'list'});
  /*
   * Entries sealed a second time, opened while their page is up: {entry with its secrets, the
   * passphrase if it took one}. In memory only; gone when the list is shown again.
   */
  const [opened, setOpened] = useState<Record<string, {entry: any; passphrase?: string}>>({});
  useEffect(() => {
    if (page.kind === 'list') setOpened({});
  }, [page.kind]);
  const [search, setSearch] = useState('');
  /* the list's filters: one kind, one folder (spec UI: "search, folders, kind filter") */
  const [kindFilter, setKindFilter] = useState<KindFilter>('All');
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  /* a long-pressed row's shortcuts (RowActions): copy and type without opening the entry */
  const [rowFor, setRowFor] = useState<Entry | null>(null);
  const bt = useSharedBtKeyboard();
  const canType = bt.state === 'connected' && bt.forwarding;
  /* Back: an edit to its entry, a new entry's form (or a phrase) to the Add page, the rest to the list */
  const back = useCallback(
    () =>
      setPage(p =>
        (p.kind === 'edit' && p.id) || p.kind === 'to-slot' ? {kind: 'entry', id: p.id!} : (p.kind === 'edit' || p.kind === 'phrase' || p.kind === 'derive-new') ? {kind: 'add', id: null} : {kind: 'list'},
      ),
    [],
  );
  useEffect(() => {
    if (page.kind === 'list') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      back();
      return true;
    });
    return () => sub.remove();
  }, [page, back]);

  /* every action first slides the session; a run-out session closes the store (the hook redraws) */
  const act = useCallback((fn: () => void | Promise<void>) => {
    if (!touch()) return;
    Promise.resolve(fn()).catch(err => Alert.alert('Passwords', String(err?.message ?? err)));
  }, [touch]);

  /*
   * The shortcuts a row offers. Only what the list already holds open: an entry sealed again
   * keeps its secrets shut until it is opened (it asks its key or passphrase), a derived password
   * or phrase is made only when shown, and a counter code moves its counter only from the entry.
   */
  const rowActions = (e: Entry | null): RowAction[] => {
    if (!e || e.inner) return [];
    const out: RowAction[] = [];
    if (e.password) out.push({title: 'Copy password', primary: true, onPress: () => act(() => copy(e.password, 'Password'))});
    if (e.username) out.push({title: 'Copy username', onPress: () => act(() => copy(e.username, 'Username'))});
    if (canType && e.username) out.push({title: 'Type username + Tab', onPress: () => act(() => bt.typeSecret(e.username!, {then: 'tab'}))});
    if (canType && e.password) out.push({title: 'Type password', onPress: () => act(() => bt.typeSecret(e.password!, {then: null}))});
    const timed = e.totp && e.totp.type !== 'hotp';
    if (timed) out.push({title: 'Copy code', primary: !e.password, onPress: () => act(() => copy(totpLib.codeOf(e.totp).code, 'Code'))});
    if (timed && canType) out.push({title: 'Type code', onPress: () => act(() => bt.typeSecret(totpLib.codeOf(e.totp).code, {then: null}))});
    return out;
  };

  /* read on every draw, not memoised: the Autofill sheet adds entries to this same store */
  void rev;
  const entries = manager.locked ? [] : (manager.list() as Entry[]);
  const refused = manager.locked ? 0 : manager.refused().length;

  if (page.kind !== 'list') {
    const stored = page.id ? (manager.get(page.id) as Entry | null) : null;
    /* a sealed entry, once opened, is shown and edited with its secrets */
    const entry = page.id && opened[page.id] ? (opened[page.id].entry as Entry) : stored;
    const title =
      page.kind === 'add' ? 'Add' : page.kind === 'to-slot' ? 'Put on a key slot' : page.kind === 'derive-new' ? 'New derived password' : page.kind === 'phrase' ? 'New wallet phrase' : page.kind === 'edit' ? (entry ? `Edit ${entry.title}` : 'New entry') : entry?.title ?? '';
    return (
      <View style={styles.root}>
        <View style={styles.row}>
          <Btn title="‹ Back" onPress={back} />
          <View style={styles.titleBox}>
            <Text style={styles.title} numberOfLines={1}>{title}</Text>
          </View>
        </View>
        {page.kind === 'phrase' ? (
          <NewPhrase
            manager={manager}
            phraseKey={phraseKey}
            act={act}
            onSaved={id => {
              setRev(n => n + 1);
              setPage({kind: 'entry', id});
            }}
          />
        ) : page.kind === 'to-slot' && entry?.totp ? (
          /* PUT ON A KEY SLOT (spec "Using a code"): the key types the code itself from then on */
          <ScrollView contentContainerStyle={styles.pad}>
            <Text style={styles.body}>
              Pick the slot for "{entry.title}". Its setup key is written into that slot's TOTP; the key then types the code from the
              slot itself. The slot's own code, if it has one, is replaced.
            </Text>
            <SlotsScreen
              panel
              onOpen={slot =>
                Alert.alert('Write the code to this slot?', `Slot ${slot.id}${slot.label ? ` ("${slot.label}")` : ''} gets this setup key. Its own code, if any, is replaced.`, [
                  {text: 'Cancel', style: 'cancel'},
                  {
                    text: 'Write',
                    onPress: () =>
                      act(async () => {
                        await writeSlot(slot.id, entry.totp.secret);
                        Alert.alert('Written', `Slot ${slot.id} has the code.`);
                        setPage({kind: 'entry', id: entry.id});
                      }),
                  },
                ])
              }
            />
          </ScrollView>
        ) : page.kind === 'derive-new' ? (
          <NewDerived
            manager={manager}
            deriveKey={phraseKey}
            act={act}
            onSaved={id => {
              setRev(n => n + 1);
              setPage({kind: 'entry', id});
            }}
          />
        ) : page.kind === 'add' ? (
          <AddPage
            first={entries.length === 0}
            keyName={keyName}
            onPick={next =>
              setPage(next === 'phrase' ? {kind: 'phrase', id: null} : next === 'derived' ? {kind: 'derive-new', id: null} : {kind: 'edit', id: null, newKind: next})
            }
          />
        ) : page.kind === 'edit' ? (
          <EntryEditor
            newKind={page.newKind}
            /* never a phrase: a phrase entry has no Edit (its recipe is the entry) */
            entry={entry as (Entry & {kind: 'login' | 'note' | 'card' | 'totp'}) | null}
            onSave={(input, how) =>
              act(async () => {
                let toSave: any = input;
                const was = page.id ? opened[page.id] : undefined;
                if (how.seal !== 'none') {
                  /* sealed: the history stays inside the seal (the store keeps none outside it) */
                  const base: any = was?.entry ?? stored;
                  let history = base?.history ?? [];
                  if (base?.password && input.password !== base.password) {
                    history = [{password: base.password, changedAt: new Date().toISOString()}, ...history].slice(0, 5);
                  }
                  const {okcrypto, press} = await phraseKey();
                  toSave = await sealEntry(
                    {...input, ...(history.length ? {history} : {}), ...(stored?.inner ? {inner: stored.inner} : {})},
                    {seal: how.seal, passphrase: how.passphrase ?? was?.passphrase},
                    okcrypto as any,
                    press,
                  );
                }
                const saved = await manager.put(toSave);
                if (was) setOpened(o => ({...o, [saved.id]: {entry: {...stripInner(input), id: saved.id, sealedWith: how.seal}, passphrase: how.passphrase ?? was.passphrase}}));
                setRev(n => n + 1);
                setPage({kind: 'entry', id: saved.id});
              })
            }
            onDelete={
              entry
                ? () =>
                    Alert.alert('Delete this entry?', `"${entry.title}" is removed from this store. It cannot be brought back.`, [
                      {text: 'Cancel', style: 'cancel'},
                      {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: () =>
                          act(async () => {
                            await manager.remove(entry.id);
                            setRev(n => n + 1);
                            setPage({kind: 'list'});
                          }),
                      },
                    ])
                : undefined
            }
          />
        ) : entry?.kind === 'derived' ? (
          <DerivedEntry entry={entry} deriveKey={phraseKey} act={act} copy={copy} />
        ) : entry?.kind === 'mnemonic' ? (
          <PhraseEntry entry={entry} phraseKey={phraseKey} act={act} />
        ) : entry?.inner ? (
          <SealedEntry
            entry={entry}
            act={act}
            onOpen={async passphrase => {
              const {okcrypto, press} = await phraseKey();
              const open = await openEntry(entry, okcrypto as any, press, passphrase);
              setOpened(o => ({...o, [entry.id]: {entry: open, passphrase}}));
            }}
          />
        ) : entry ? (
          <EntryView
            entry={entry}
            act={act}
            onEdit={() => setPage({kind: 'edit', id: entry.id})}
            /* HOTP's counter is saved through the store; an entry sealed again keeps it inside its seal (Edit) */
            onCounter={
              stored?.inner
                ? undefined
                : async next => {
                    await manager.put({...stored, totp: {...stored!.totp, counter: next}});
                    setRev(n => n + 1);
                  }
            }
            onToSlot={() => setPage({kind: 'to-slot', id: entry.id})}
          />
        ) : (
          <Text style={[styles.body, styles.pad]}>This entry is gone.</Text>
        )}
      </View>
    );
  }

  const q = search.trim().toLowerCase();
  const folders = [...new Set(entries.map(e => e.folder).filter((f): f is string => !!f))].sort((a, b) => a.localeCompare(b));
  const shown = entries.filter(
    e =>
      (kindFilter === 'All' || KIND_OF_FILTER[kindFilter].includes(e.kind)) &&
      (folderFilter === null || e.folder === folderFilter) &&
      (!q || [e.title, e.username, e.folder, ...(e.urls ?? []), ...(e.tags ?? [])].some(s => s && s.toLowerCase().includes(q))),
  );
  const filtered = !!q || kindFilter !== 'All' || folderFilter !== null;
  const items: EdgeListItem[] = [];
  if (refused) {
    items.push({
      key: 'refused',
      kind: 'row',
      tone: 'alarm',
      title: `${refused} record${refused === 1 ? '' : 's'} here did not open`,
      subtitle: 'They are not shown. A record that does not open with this key, or that was moved onto another record, is refused - never shown as an entry.',
    });
  }
  for (const kind of ['login', 'derived', 'note', 'card', 'totp', 'mnemonic'] as const) {
    const of = shown.filter(e => e.kind === kind);
    if (!of.length) continue;
    items.push({key: `s-${kind}`, kind: 'section', title: KIND_TITLE[kind], right: String(of.length)});
    for (const e of of) {
      /* an authenticator row shows its code and time bar, live (spec UI: "Show TOTP" in the list) */
      if (e.kind === 'totp' && !e.inner && e.totp) {
        items.push({
          key: e.id,
          kind: 'node',
          accessibilityLabel: e.title,
          render: () => <TotpRowCode totp={e.totp} title={e.title} subtitle={e.totp?.issuer || 'authenticator'} />,
          onPress: () => act(() => setPage({kind: 'entry', id: e.id})),
          onLongPress: () => setRowFor(e),
        });
        continue;
      }
      items.push({
        key: e.id,
        kind: 'row',
        title: e.title,
        subtitle:
          e.kind === 'mnemonic'
            ? `${e.recipe?.out === 'bip39-12' ? 12 : 24} words, from the key`
            : e.kind === 'totp'
              ? e.totp?.issuer || 'authenticator'
              : e.kind === 'derived'
                ? e.username || 'made from the key'
                : e.username || (e.urls?.[0] ? hostOf(e.urls[0]) : undefined),
        right: e.inner ? 'sealed' : undefined,
        onPress: () => act(() => setPage({kind: 'entry', id: e.id})),
        onLongPress: () => setRowFor(e),
      });
    }
  }

  /*
   * MOVING PASSWORDS. The export is the store as it is kept - every entry still sealed to this key,
   * record ids random - so the file opens only with this key or one from its backup; an import
   * skips (and counts) anything that does not open. The old vault's entries (Encrypt/Decrypt's
   * single-password vault) are each opened with their own derive, one press per site as before,
   * and kept here as logins; the old vault is left as it is.
   */
  const move = (kind: 'export' | 'save' | 'import' | 'old') =>
    act(async () => {
      /* the sealed copy into a folder the person picks (spec: "Save to a folder through Android's file picker") */
      if (kind === 'save') {
        const stamp = new Date().toISOString().slice(0, 10);
        const r = await NativeShare.saveFile(`onlykey-passwords-${stamp}.json`, await manager.exportJSON(), 'application/json');
        if (r.saved) Alert.alert('Saved', `Sealed copy saved as ${r.name || 'the chosen file'}. It opens only with this key or one restored from its backup.`);
        return;
      }
      if (kind === 'export') {
        const stamp = new Date().toISOString().slice(0, 10);
        await NativeShare.shareFile(`onlykey-passwords-${stamp}.json`, await manager.exportJSON(), 'application/json', 'Passwords (sealed)');
        return;
      }
      if (kind === 'import') {
        const picked = await NativeShare.pickTextFile('application/json');
        if (!picked.picked) return;
        const r = await manager.importJSON(picked.content);
        setRev(n => n + 1);
        Alert.alert('Import', `${r.imported} added, ${r.skipped} already here, ${r.unreadable} did not open with this key.`);
        return;
      }
      const vault = await oldVault();
      const r = await legacy.importLegacy({
        legacy: vault,
        openOne: (id: string) => vault.load(id, {requirePress: true}),
        manager,
      });
      setRev(n => n + 1);
      Alert.alert(
        'Old vault',
        r.imported + r.failed.length === 0
          ? 'The old vault on this key is empty.'
          : `${r.imported} brought in.${r.failed.length ? ` ${r.failed.length} did not open: ${r.failed.map(f => f.serviceId).join(', ')}.` : ''}`,
      );
    });
  if (filtered && !shown.length) items.push({key: 'nomatch', kind: 'row', tone: 'dim', title: 'Nothing matches'});
  if (!q && !entries.length) items.push({key: 'none', kind: 'row', tone: 'dim', title: 'No passwords yet', subtitle: '+ Add makes the first one.'});
  /* the panels below belong to the whole store, not to a filtered view */
  if (!filtered) {
    /* how long the store stays open once the key opened it (spec: "up to session:8h") */
    const chosen = POLICY_LABEL_OF[policy() as StorePolicy] ?? '30 min';
    items.push({key: 's-stay', kind: 'section', title: 'Stays open'});
    items.push({
      key: 'stay',
      kind: 'node',
      render: () => (
        <View>
          <Segmented options={POLICY_LABELS} value={chosen} onChange={v => act(() => choosePolicy(POLICY_OF_LABEL[v]))} />
          <Text style={styles.dim}>
            {policyWords(POLICY_OF_LABEL[chosen])}, or until the key locks. A shorter choice counts from the next open.
          </Text>
        </View>
      ),
    });
    items.push({key: 's-autofill', kind: 'section', title: 'Autofill'});
    items.push({key: 'autofill', kind: 'node', render: () => <AutofillCard />});
    items.push({key: 's-move', kind: 'section', title: 'Move passwords'});
    items.push({
      key: 'move',
      kind: 'node',
      render: () => (
        <View>
          <Text style={styles.dim}>
            A sealed export opens only with this key or a key restored from its backup.
          </Text>
          <View style={styles.buttons}>
            <Btn title="Save to a folder (sealed)" onPress={() => move('save')} />
            <Btn title="Share (sealed)" onPress={() => move('export')} />
            <Btn title="Import (sealed)" onPress={() => move('import')} />
            {/* Import old vault: hidden - no legacy support yet (Brad, 2026-10-11); move('old') and lib legacy.js stay */}
          </View>
        </View>
      ),
    });
  }

  return (
    <View style={styles.root}>
      <View style={styles.bar}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder={`Search ${entries.length} on the ${keyName}`}
          placeholderTextColor={theme.textDim}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, styles.search]}
        />
        <Btn title="+ Add" tone="primary" onPress={() => act(() => setPage({kind: 'add', id: null}))} />
        <Btn title="Lock" onPress={lockNow} />
      </View>
      <View style={styles.filters}>
        <Segmented options={KIND_FILTERS} value={kindFilter} onChange={setKindFilter} />
        {folders.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            <Btn title="All folders" tone={folderFilter === null ? 'primary' : 'default'} onPress={() => setFolderFilter(null)} />
            {folders.map(f => (
              <Btn key={f} title={f} tone={folderFilter === f ? 'primary' : 'default'} onPress={() => setFolderFilter(folderFilter === f ? null : f)} />
            ))}
          </ScrollView>
        ) : null}
      </View>
      {left !== null ? <Text style={[styles.dim, styles.session]}>{timeLeftWords(left)}</Text> : null}
      <EdgeList items={items} empty="Nothing matches." />
      <RowActions title={rowFor ? rowFor.title : null} actions={rowActions(rowFor)} onClose={() => setRowFor(null)} />
    </View>
  );
}

/*
 * + ADD: one button per kind (Brad, 2026-10-11: "the +add button need to go into a view to a list
 * of button, like + Wallet Phrase"). Authenticator: TOTP, in 0.0.7 (Brad, same day).
 */
const ADD_KINDS: {kind: NewKind | 'phrase' | 'derived'; title: string; what: string}[] = [
  {kind: 'login', title: '+ Login', what: 'A username and password for a site or an app.'},
  {kind: 'derived', title: '+ Derived password', what: 'A password made from this OnlyKey and a name - nothing of it is stored; the same name gives it again.'},
  {kind: 'note', title: '+ Note', what: 'Text kept sealed: a code, an answer, anything.'},
  {kind: 'card', title: '+ Card', what: 'A card number or a PIN.'},
  {kind: 'totp', title: '+ Authenticator', what: 'The 6-digit code for two-step sign-in (GitHub and others), from its setup key or QR link.'},
  {kind: 'phrase', title: '+ Wallet phrase', what: 'A BIP39 phrase made from this OnlyKey and a name - nothing of it is stored.'},
];

function AddPage({first, keyName, onPick}: {first: boolean; keyName: string; onPick: (kind: NewKind | 'phrase' | 'derived') => void}) {
  return (
    <ScrollView contentContainerStyle={styles.pad}>
      {/*
        * Before the first entry (spec Security: "OnlyKey lost with no backup - Data lost. By design;
        * the backup section says so in the UI before the first entry is saved"). The app cannot
        * tell whether the key has a backup key set - only a backup attempt says so - so it says it
        * to everyone, once the store is empty.
        */}
      {first ? (
        <Text style={[styles.dim, styles.firstNote]}>
          Everything saved here opens only with the {keyName}, or with a key restored from its backup. Without a backup, losing the key loses these. Make one in Settings › Backup/Restore.
        </Text>
      ) : null}
      {ADD_KINDS.map(k => (
        <View key={k.kind} style={styles.addRow}>
          <Btn title={k.title} tone="primary" onPress={() => onPick(k.kind)} />
          <Text style={[styles.dim, styles.addWhat]}>{k.what}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

/*
 * AN ENTRY SEALED A SECOND TIME, not opened yet: its title and username show (they are the
 * store's), its secrets wait for one more press of the key, or for its passphrase (innerKeys.ts).
 */
function SealedEntry({entry, act, onOpen}: {entry: Entry; act: (fn: () => void | Promise<void>) => void; onOpen: (passphrase?: string) => Promise<void>}) {
  const [passphrase, setPassphrase] = useState('');
  const byKey = (entry.inner as any)?.seal === 'entry-derive';
  return (
    <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
      <Section title={byKey ? 'Sealed with one more press' : 'Sealed with a passphrase'}>
        {entry.username ? <KeyValue label="Username" value={entry.username} /> : null}
        {entry.urls?.length ? <KeyValue label={entry.urls.length > 1 ? 'Sites' : 'Site'} value={entry.urls.join('\n')} /> : null}
        <Text style={styles.body}>
          {byKey
            ? 'Its password, notes and code open with one more press of the key, each time.'
            : 'Its password, notes and code open with the passphrase it was sealed with.'}
        </Text>
        {byKey ? null : (
          <TextInput
            value={passphrase}
            onChangeText={setPassphrase}
            placeholder="Passphrase"
            placeholderTextColor={theme.textDim}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            importantForAutofill="no"
            style={styles.input}
          />
        )}
        <View style={styles.buttons}>
          <Btn
            title={byKey ? 'Open with OnlyKey' : 'Open'}
            tone="primary"
            disabled={!byKey && !passphrase}
            onPress={() => act(() => onOpen(byKey ? undefined : passphrase))}
          />
        </View>
      </Section>
    </ScrollView>
  );
}

function EntryView({
  entry,
  act,
  onEdit,
  onCounter,
  onToSlot,
}: {
  entry: Entry;
  act: (fn: () => void | Promise<void>) => void;
  onEdit: () => void;
  onCounter?: (next: number) => Promise<void>;
  onToSlot?: () => void;
}) {
  const [show, setShow] = useState(false);
  /* Type: the phone as the computer's Bluetooth keyboard, US layout (useBtKeyboard typeSecret) */
  const bt = useSharedBtKeyboard();
  const canType = bt.state === 'connected' && bt.forwarding;
  const type = (text: string | undefined, then: 'tab' | 'enter' | null) =>
    act(async () => {
      if (text) await bt.typeSecret(text, {then});
    });
  /* an authenticator entry: its code, and Edit */
  if (entry.kind === 'totp') {
    return (
      <ScrollView contentContainerStyle={styles.pad}>
        <TotpCode totp={entry.totp} act={act} copy={copy} title={entry.title} onCounter={onCounter} onToSlot={onToSlot} />
        {entry.notes ? <Section title="Notes"><KeyValue label="Notes" value={entry.notes} /></Section> : null}
        <View style={styles.buttons}>
          <Btn title="Edit" onPress={() => act(onEdit)} />
        </View>
      </ScrollView>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <Section title={KIND_TITLE[entry.kind].replace(/s$/, '')}>
        {entry.username ? <KeyValue label="Username" value={entry.username} /> : null}
        {entry.password ? <KeyValue label="Password" value={show ? entry.password : '••••••••••'} /> : null}
        {entry.urls?.length ? <KeyValue label={entry.urls.length > 1 ? 'Sites' : 'Site'} value={entry.urls.join('\n')} /> : null}
        {entry.notes ? <KeyValue label="Notes" value={entry.notes} /> : null}
        {(entry as any).sealedWith && (entry as any).sealedWith !== 'none' ? (
          <Text style={styles.dim}>{(entry as any).sealedWith === 'key' ? 'Sealed again with the key: opened for this visit.' : 'Sealed again with a passphrase: opened for this visit.'}</Text>
        ) : null}
        {entry.androidApps?.length ? <KeyValue label="Apps" value={entry.androidApps.map(a => a.package).join('\n')} /> : null}
        {entry.folder ? <KeyValue label="Folder" value={entry.folder} /> : null}
        {entry.tags?.length ? <KeyValue label="Tags" value={entry.tags.join(', ')} /> : null}
        <View style={styles.buttons}>
          {entry.password ? <Btn title="Copy password" tone="primary" onPress={() => act(() => copy(entry.password, 'Password'))} /> : null}
          {entry.username ? <Btn title="Copy username" onPress={() => act(() => copy(entry.username, 'Username'))} /> : null}
          {entry.password ? <Btn title={show ? 'Hide' : 'Show'} onPress={() => act(() => setShow(s => !s))} /> : null}
          <Btn title="Edit" onPress={() => act(onEdit)} />
        </View>
      </Section>
      {entry.kind === 'login' && (entry.username || entry.password) ? (
        <Section title="Type on the computer">
          {canType ? (
            <>
              <Text style={styles.dim}>Typed into whatever has focus on {bt.host || 'the connected computer'}. US keyboard layout.</Text>
              <View style={styles.buttons}>
                {entry.username ? <Btn title="Type username + Tab" onPress={() => type(entry.username, 'tab')} /> : null}
                {entry.password ? <Btn title="Type password" tone="primary" onPress={() => type(entry.password, null)} /> : null}
                {entry.password ? <Btn title="Type password + Enter" onPress={() => type(entry.password, 'enter')} /> : null}
              </View>
            </>
          ) : (
            <Text style={styles.dim}>
              {bt.state === 'connected' ? 'Typing to the computer is switched off (the keyboard IO switch).' : 'Connect a computer on the Bluetooth tab to type here.'}
            </Text>
          )}
        </Section>
      ) : null}
      {/* a login's own authenticator code (GitHub: the password, then this) */}
      {entry.totp ? <TotpCode totp={entry.totp} act={act} copy={copy} onCounter={onCounter} onToSlot={onToSlot} /> : null}
      {entry.history?.length ? (
        <Section title="Earlier passwords">
          {entry.history.map((h, i) => (
            <View key={i} style={styles.history}>
              <Text style={styles.body}>{show ? h.password : '••••••••••'}</Text>
              <Text style={styles.dim}>until {h.changedAt.slice(0, 10)}</Text>
              <Btn title="Copy" onPress={() => act(() => copy(h.password, 'Earlier password'))} />
            </View>
          ))}
        </Section>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  firstNote: {color: theme.warn, marginBottom: 12},
  root: {flex: 1},
  pad: {padding: 16},
  row: {flexDirection: 'row', alignItems: 'stretch', paddingHorizontal: 16, paddingTop: 16},
  titleBox: {marginTop: 10, marginLeft: 16, justifyContent: 'center', flex: 1},
  title: {color: theme.text, fontSize: 18, fontWeight: '700'},
  bar: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 8},
  search: {flex: 1},
  input: {
    marginTop: 8,
    color: theme.text,
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.inputBg,
  },
  body: {color: theme.text, fontSize: 14, lineHeight: 20},
  dim: {color: theme.textDim, fontSize: 12},
  store: {color: theme.textDim, fontSize: 12, fontFamily: theme.mono, marginTop: 8},
  buttons: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  history: {flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap'},
  addRow: {flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 4},
  session: {paddingHorizontal: 16, paddingBottom: 6},
  filters: {paddingHorizontal: 16, paddingBottom: 6, gap: 4},
  chips: {gap: 8},
  addWhat: {flex: 1},
});
