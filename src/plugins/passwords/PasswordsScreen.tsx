import React, {useCallback, useEffect, useState} from 'react';
import {Alert, BackHandler, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';

import {legacy} from 'node-onlykey-lib/passwords';
import NativeSecrets from '../../../specs/NativeSecrets';
import NativeShare from '../../../specs/NativeShare';
import {missingNote} from '../../firmwareFeatures';
import {useSharedBtKeyboard} from '../../hooks/BtKeyboardContext';
import {BACKEND_NAME} from '../../hooks/keySession';
import {useSecureScreen} from '../../hooks/useSecureScreen';
import {Btn, KeyValue, Section} from '../../ui/components';
import {EdgeList, type EdgeListItem} from '../../ui/EdgeList';
import {theme} from '../../ui/theme';
import type {TabContext} from '../types';
import {AutofillCard} from './autofill/AutofillCard';
import {EntryEditor} from './EntryEditor';
import {NewPhrase, PhraseEntry} from './PhraseViews';
import {TotpCode} from './TotpViews';
import {usePasswordManager, type OldVault} from './usePasswordManager';
import type {Manager} from './stores';

/*
 * THE PASSWORDS TAB. Unlocks when the tab opens if that needs no press; otherwise "Open with
 * OnlyKey", so opening the tab never sends a press request by itself (Brad, 2026-10-11). The
 * list is Edge's scrollable list (src/ui/EdgeList.tsx; Brad: "we need to reuse the scrollable list
 * view we use in edge"). An entry and the editor open as a page with ‹ Back and its name, and the
 * phone's own Back goes back too, as Settings and Edge's budget view do.
 */

const CLIPBOARD_TTL_MS = 45000;
const KIND_TITLE: Record<string, string> = {login: 'Logins', note: 'Notes', card: 'Cards', totp: 'Authenticators', mnemonic: 'Wallet phrases'};

type Entry = {
  id: string;
  kind: 'login' | 'note' | 'card' | 'mnemonic' | 'totp';
  totp?: any;
  recipe?: {label: string; out: string; press: boolean; check: string};
  title: string;
  username?: string;
  password?: string;
  urls?: string[];
  notes?: string;
  history?: {password: string; changedAt: string}[];
  inner?: unknown;
  updatedAt?: string;
};

type NewKind = 'login' | 'note' | 'card' | 'totp';
type Page =
  | {kind: 'list'}
  | {kind: 'add'; id: null}
  | {kind: 'entry'; id: string}
  | {kind: 'edit'; id: string | null; newKind?: NewKind}
  | {kind: 'phrase'; id: null};

const hostOf = (url: string) => url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0];

async function copy(text: string | undefined, what: string) {
  if (!text) return;
  await NativeSecrets.copySensitive(text, CLIPBOARD_TTL_MS);
  Alert.alert('Copied', `${what} copied. The clipboard is cleared in ${CLIPBOARD_TTL_MS / 1000} seconds.`);
}

export function PasswordsScreen({ctx}: {ctx: TabContext}) {
  const {view, pressAsked, openWithKey, touch, lockNow, retry, oldVault, phraseKey} = usePasswordManager({
    backend: ctx.backend,
    unlocked: ctx.unlocked,
    caps: ctx.caps,
  });
  const keyName = BACKEND_NAME[ctx.backend];
  useSecureScreen(ctx.blockScreenshots && view.state === 'open');

  if (view.state === 'open') return <OpenStore manager={view.manager} keyName={keyName} touch={touch} lockNow={lockNow} oldVault={oldVault} phraseKey={phraseKey} />;

  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <Section title="Passwords">
        {view.state === 'unsupported' ? (
          <Text style={styles.body}>{missingNote('deviceVault')}</Text>
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
                : `Your passwords are sealed to the ${keyName}. Opening asks the key once; the store then stays open for 30 minutes of use, or until the key locks.`}
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
}: {
  manager: Manager;
  keyName: string;
  touch: () => boolean;
  lockNow: () => void;
  oldVault: () => Promise<OldVault>;
  phraseKey: Parameters<typeof PhraseEntry>[0]['phraseKey'];
}) {
  const [page, setPage] = useState<Page>({kind: 'list'});
  const [search, setSearch] = useState('');
  const [rev, setRev] = useState(0);
  /* Back: an edit to its entry, a new entry's form (or a phrase) to the Add page, the rest to the list */
  const back = useCallback(
    () =>
      setPage(p =>
        p.kind === 'edit' && p.id ? {kind: 'entry', id: p.id} : (p.kind === 'edit' || p.kind === 'phrase') ? {kind: 'add', id: null} : {kind: 'list'},
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

  /* read on every draw, not memoised: the Autofill sheet adds entries to this same store */
  void rev;
  const entries = manager.locked ? [] : (manager.list() as Entry[]);
  const refused = manager.locked ? 0 : manager.refused().length;

  if (page.kind !== 'list') {
    const entry = page.id ? (manager.get(page.id) as Entry | null) : null;
    const title =
      page.kind === 'add' ? 'Add' : page.kind === 'phrase' ? 'New wallet phrase' : page.kind === 'edit' ? (entry ? `Edit ${entry.title}` : 'New entry') : entry?.title ?? '';
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
        ) : page.kind === 'add' ? (
          <AddPage onPick={next => setPage(next === 'phrase' ? {kind: 'phrase', id: null} : {kind: 'edit', id: null, newKind: next})} />
        ) : page.kind === 'edit' ? (
          <EntryEditor
            newKind={page.newKind}
            /* never a phrase: a phrase entry has no Edit (its recipe is the entry) */
            entry={entry as (Entry & {kind: 'login' | 'note' | 'card' | 'totp'}) | null}
            onSave={input =>
              act(async () => {
                const saved = await manager.put(input);
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
        ) : entry?.kind === 'mnemonic' ? (
          <PhraseEntry entry={entry} phraseKey={phraseKey} act={act} />
        ) : entry ? (
          <EntryView entry={entry} act={act} onEdit={() => setPage({kind: 'edit', id: entry.id})} />
        ) : (
          <Text style={[styles.body, styles.pad]}>This entry is gone.</Text>
        )}
      </View>
    );
  }

  const q = search.trim().toLowerCase();
  const shown = q
    ? entries.filter(e => [e.title, e.username, ...(e.urls ?? [])].some(s => s && s.toLowerCase().includes(q)))
    : entries;
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
  for (const kind of ['login', 'note', 'card', 'totp', 'mnemonic'] as const) {
    const of = shown.filter(e => e.kind === kind);
    if (!of.length) continue;
    items.push({key: `s-${kind}`, kind: 'section', title: KIND_TITLE[kind], right: String(of.length)});
    for (const e of of) {
      items.push({
        key: e.id,
        kind: 'row',
        title: e.title,
        subtitle:
          e.kind === 'mnemonic'
            ? `${e.recipe?.out === 'bip39-12' ? 12 : 24} words, from the key`
            : e.kind === 'totp'
              ? e.totp?.issuer || 'authenticator'
              : e.username || (e.urls?.[0] ? hostOf(e.urls[0]) : undefined),
        right: e.inner ? 'sealed' : undefined,
        onPress: () => act(() => setPage({kind: 'entry', id: e.id})),
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
  const move = (kind: 'export' | 'import' | 'old') =>
    act(async () => {
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
  if (!q && !entries.length) items.push({key: 'none', kind: 'row', tone: 'dim', title: 'No passwords yet', subtitle: '+ Add makes the first one.'});
  if (!q) {
    items.push({key: 's-autofill', kind: 'section', title: 'Autofill'});
    items.push({key: 'autofill', kind: 'node', render: () => <AutofillCard />});
    items.push({key: 's-move', kind: 'section', title: 'Move passwords'});
    items.push({
      key: 'move',
      kind: 'node',
      render: () => (
        <View>
          <Text style={styles.dim}>
            A sealed export opens only with this key or a key restored from its backup. The old vault asks a press for each site.
          </Text>
          <View style={styles.buttons}>
            <Btn title="Export (sealed)" onPress={() => move('export')} />
            <Btn title="Import (sealed)" onPress={() => move('import')} />
            <Btn title="Import old vault" onPress={() => move('old')} />
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
      <EdgeList items={items} empty="Nothing matches." />
    </View>
  );
}

/*
 * + ADD: one button per kind (Brad, 2026-10-11: "the +add button need to go into a view to a list
 * of button, like + Wallet Phrase"). Authenticator: TOTP, in 0.0.7 (Brad, same day).
 */
const ADD_KINDS: {kind: NewKind | 'phrase'; title: string; what: string}[] = [
  {kind: 'login', title: '+ Login', what: 'A username and password for a site or an app.'},
  {kind: 'note', title: '+ Note', what: 'Text kept sealed: a code, an answer, anything.'},
  {kind: 'card', title: '+ Card', what: 'A card number or a PIN.'},
  {kind: 'totp', title: '+ Authenticator', what: 'The 6-digit code for two-step sign-in (GitHub and others), from its setup key or QR link.'},
  {kind: 'phrase', title: '+ Wallet phrase', what: 'A BIP39 phrase made from this OnlyKey and a name - nothing of it is stored.'},
];

function AddPage({onPick}: {onPick: (kind: NewKind | 'phrase') => void}) {
  return (
    <ScrollView contentContainerStyle={styles.pad}>
      {ADD_KINDS.map(k => (
        <View key={k.kind} style={styles.addRow}>
          <Btn title={k.title} tone="primary" onPress={() => onPick(k.kind)} />
          <Text style={[styles.dim, styles.addWhat]}>{k.what}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

function EntryView({entry, act, onEdit}: {entry: Entry; act: (fn: () => void | Promise<void>) => void; onEdit: () => void}) {
  const [show, setShow] = useState(false);
  /* Type: the phone as the computer's Bluetooth keyboard, US layout (useBtKeyboard typeSecret) */
  const bt = useSharedBtKeyboard();
  const canType = bt.state === 'connected' && bt.forwarding;
  const type = (text: string | undefined, then: 'tab' | null) =>
    act(async () => {
      if (text) await bt.typeSecret(text, {then});
    });
  if (entry.inner) {
    return (
      <ScrollView contentContainerStyle={styles.pad}>
        <Section title="Sealed a second time">
          <Text style={styles.body}>This entry has its own key. Opening it is not in this release yet.</Text>
        </Section>
      </ScrollView>
    );
  }
  /* an authenticator entry: its code, and Edit */
  if (entry.kind === 'totp') {
    return (
      <ScrollView contentContainerStyle={styles.pad}>
        <TotpCode totp={entry.totp} act={act} copy={copy} title={entry.title} />
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
      {entry.totp ? <TotpCode totp={entry.totp} act={act} copy={copy} /> : null}
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
  addWhat: {flex: 1},
});
