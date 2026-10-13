import React, {useCallback, useEffect, useState} from 'react';
import {Alert, BackHandler, Dimensions, Image, PixelRatio, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';

import NativeSecrets from '../../../specs/NativeSecrets';
import NativeShare from '../../../specs/NativeShare';
import {useSecureScreen} from '../../hooks/useSecureScreen';
import {Btn, KeyValue, Section, Segmented} from '../../ui/components';
import {EdgeList, type EdgeListItem} from '../../ui/EdgeList';
import {theme} from '../../ui/theme';
import type {TabContext} from '../types';
import {readMyCard, type MyKey} from './myCard';
import {useGuestBook, type Contact, type Found, type Source} from './useGuestBook';
import {ExchangeSheet} from './ExchangeSheet';
import {isInvite, onInvite, takeInvite} from './swapNative';
import {readMyName, saveMyName} from './service';

/*
 * GUEST BOOK (onlykey-edge/features/GUEST-BOOK-SPEC.md): other people's PUBLIC keys, laid out like
 * the phone's own Contacts app - your card first, ready to share, then everyone else (Brad,
 * 2026-10-12: "like in android/ios it shows your contact info at the top before any other
 * contacts, so you can quickly share from there").
 *
 * Public only: nothing here holds or shows a private key (Brad, 2026-10-12: "guest book is only for
 * public output") - the lib refuses one at every way in, and says so.
 */

const CLIPBOARD_TTL_MS = 45000;
/* the QR is drawn at the screen's real width in pixels, so it stays sharp shown full width */
const qrPixels = () => Math.min(2048, Math.round(Dimensions.get('window').width * PixelRatio.get()));

type Page =
  | {kind: 'list'}
  | {kind: 'add'; contactId?: string}
  | {kind: 'contact'; id: string}
  | {kind: 'me'}
  | {kind: 'share'; title: string; text: string; file: string};

const FORMAT_NAME: Record<string, string> = {openpgp: 'PGP', age: 'age', ssh: 'SSH'};
const formatName = (f: string) => FORMAT_NAME[f] ?? (f.startsWith('raw-') ? `raw ${f.slice(4)}` : f);
/* a PGP fingerprint in groups of 4, as people read it out; the others as they are printed */
const showFingerprint = (k: {format: string; fingerprint: string}) =>
  k.format === 'openpgp' ? k.fingerprint.replace(/(.{4})/g, '$1 ').trim() : k.fingerprint;
const fileFor = (k: {format: string}, name: string) =>
  `${name.replace(/[^\w.-]+/g, '_') || 'key'}${k.format === 'openpgp' ? '.asc' : k.format === 'ssh' ? '.pub' : '.txt'}`;

const SOURCES = ['Paste', 'Scan', 'Keybase', 'Proton', 'GitHub', 'URL'] as const;
type SourceChoice = (typeof SOURCES)[number];
const LOOKUP_KIND: Partial<Record<SourceChoice, string>> = {Keybase: 'keybase', Proton: 'protonmail', GitHub: 'github', URL: 'url'};
const LOOKUP_HINT: Partial<Record<SourceChoice, string>> = {
  Keybase: 'Keybase username or name',
  Proton: 'Proton Mail address',
  GitHub: 'GitHub username',
  URL: 'https:// address of a key',
};

const copy = async (text: string, what: string) => {
  await NativeSecrets.copySensitive(text, CLIPBOARD_TTL_MS);
  Alert.alert('Copied', `${what} copied. The clipboard is cleared in ${CLIPBOARD_TTL_MS / 1000} seconds.`);
};

type Swap = 'host' | {join: string};

/*
 * THE SWAP SHEET SITS OVER EVERY PAGE: started from My card (show / scan), from Add's Scan when
 * the QR is an invite, or from outside (the phone's camera opened an okrn://connect link).
 */
export function GuestBookScreen({ctx}: {ctx: TabContext}) {
  const [swap, setSwap] = useState<Swap | null>(null);
  useEffect(() => {
    const waiting = takeInvite();
    if (waiting) setSwap({join: waiting});
    return onInvite(url => setSwap({join: url}));
  }, []);
  return (
    <>
      <GuestBookPages ctx={ctx} onSwap={setSwap} />
      {swap ? <SwapOverlay start={swap} onClose={() => setSwap(null)} /> : null}
    </>
  );
}

function SwapOverlay({start, onClose}: {start: Swap; onClose: () => void}) {
  const gb = useGuestBook();
  const [mine, setMine] = useState<MyKey[] | null>(null);
  useEffect(() => {
    readMyCard().then(setMine, () => setMine([]));
  }, []);
  return mine ? <ExchangeSheet start={start} mine={mine} gb={gb} onClose={onClose} /> : null;
}

function GuestBookPages({ctx, onSwap}: {ctx: TabContext; onSwap: (s: Swap) => void}) {
  /* who you talk to is not public: no screenshots of the list in a release build (spec Security) */
  useSecureScreen(ctx.blockScreenshots);
  const gb = useGuestBook();
  const [page, setPage] = useState<Page>({kind: 'list'});
  const [mine, setMine] = useState<MyKey[] | null>(null);
  const [search, setSearch] = useState('');
  const [myName, setMyName] = useState('');
  useEffect(() => {
    readMyName().then(setMyName, () => {});
  }, []);

  useEffect(() => {
    readMyCard().then(setMine, () => setMine([]));
  }, []);

  useEffect(() => {
    if (page.kind === 'list') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setPage({kind: 'list'});
      return true;
    });
    return () => sub.remove();
  }, [page]);

  /* every action: a failure is shown in the person's words, never swallowed */
  const act = useCallback((fn: () => unknown) => {
    Promise.resolve()
      .then(fn)
      .catch((e: any) => Alert.alert('Guest Book', String(e?.message ?? e)));
  }, []);

  if (page.kind === 'share') return <SharePage page={page} onBack={() => setPage({kind: 'list'})} />;
  if (page.kind === 'me') {
    const items: EdgeListItem[] = [{key: 's-me', kind: 'section', title: 'My card - your public keys', right: String(mine?.length ?? 0)}];
    for (const k of mine ?? []) {
      items.push({
        key: k.id,
        kind: 'row',
        title: k.title,
        subtitle: `${k.format} · Share, Copy, QR`,
        onPress: () => setPage({kind: 'share', title: k.title, text: k.text, file: fileFor({format: k.format === 'PGP' ? 'openpgp' : k.format === 'SSH' ? 'ssh' : 'age'}, k.title)}),
      });
    }
    return (
      <View style={styles.root}>
        <View style={styles.bar}>
          <Btn title="‹ Back" onPress={() => setPage({kind: 'list'})} />
          <Text style={styles.dim}>From Key Chain. Public keys only - safe to give to anyone.</Text>
        </View>
        {/* your name on a swap: sent with your keys, the other person can change it (Brad, 2026-10-12) */}
        <View style={styles.bar}>
          <Text style={styles.dim}>Your name on swaps</Text>
          <TextInput
            style={[styles.input, {flex: 1, marginTop: 0}]}
            value={myName}
            onChangeText={setMyName}
            onEndEditing={() => void saveMyName(myName)}
            placeholder="your name on swaps"
            placeholderTextColor={theme.textSecondary}
            accessibilityLabel="Your name on swaps"
          />
        </View>
        {/* in person, over Bluetooth: one phone shows, the other scans (Brad, 2026-10-12) */}
        <View style={styles.bar}>
          <Btn title="Swap keys: show my QR" tone="primary" onPress={() => onSwap('host')} />
          <Btn title="Scan their QR" onPress={() => act(async () => {
            const NativeQrScanner = require('../../../specs/NativeQrScanner').default;
            const t: string | null = await NativeQrScanner.scan('Point the camera at the other phone\'s swap QR');
            if (!t) return;
            if (!isInvite(t)) throw new Error('That QR is not a swap invite. Add → Scan reads a key QR.');
            onSwap({join: t});
          })} />
        </View>
        <EdgeList items={items} />
      </View>
    );
  }
  if (page.kind === 'add') {
    return (
      <AddPage
        gb={gb}
        contactId={page.contactId}
        onDone={id => setPage(id ? {kind: 'contact', id} : {kind: 'list'})}
        onInvite={url => onSwap({join: url})}
      />
    );
  }
  if (page.kind === 'contact') {
    const c = gb.contacts.find((x: Contact) => x.id === page.id);
    if (!c) return <BackOnly onBack={() => setPage({kind: 'list'})} text="That contact is gone." />;
    return (
      <ContactPage
        c={c}
        gb={gb}
        act={act}
        onBack={() => setPage({kind: 'list'})}
        onAddKey={() => setPage({kind: 'add', contactId: c.id})}
        onShare={(title, text, file) => setPage({kind: 'share', title, text, file})}
      />
    );
  }

  const q = search.trim().toLowerCase();
  const shown = gb.contacts
    .filter((c: Contact) => !q || c.name.toLowerCase().includes(q) || c.keys.some((k: any) => k.label?.toLowerCase().includes(q)))
    .sort((a: Contact, b: Contact) => a.name.localeCompare(b.name));
  const items: EdgeListItem[] = [];
  if (gb.recovered) {
    items.push({key: 'recovered', kind: 'row', tone: 'alarm', title: 'The saved list did not read', subtitle: 'It was kept aside on the phone and a new, empty list started.'});
  }
  items.push({key: 's-mine', kind: 'section', title: 'My card', right: mine ? String(mine.length) : ''});
  if (mine && !mine.length) {
    items.push({key: 'mine-none', kind: 'row', tone: 'dim', title: 'Your public keys show here', subtitle: 'From Key Chain - make or record a key there.'});
  }
  /* one row, like "Me" at the top of the phone's Contacts; the keys are on its page */
  if (mine?.length) {
    items.push({
      key: 'me',
      kind: 'row',
      title: 'Me',
      subtitle: `${[...new Set(mine.map(k => k.format))].join(' · ')} - ${mine.length} key${mine.length === 1 ? '' : 's'} to share`,
      onPress: () => setPage({kind: 'me'}),
    });
  }
  for (const c of gb.contacts.filter((x: Contact) => x.keys.some((k: any) => k.pending))) {
    items.push({key: `p-${c.id}`, kind: 'row', tone: 'alarm', title: `${c.name}: a key changed`, subtitle: 'Waiting for you - open to accept it or keep the current one.', onPress: () => setPage({kind: 'contact', id: c.id})});
  }
  items.push({key: 's-contacts', kind: 'section', title: 'Contacts', right: String(gb.contacts.length)});
  if (gb.loaded && !gb.contacts.length) {
    items.push({key: 'none', kind: 'row', tone: 'dim', title: 'No contacts yet', subtitle: '+ Add: paste a key, scan its QR, or look someone up. Nothing is fetched until you do.'});
  }
  for (const c of shown) {
    const formatsHeld = [...new Set(c.keys.map((k: any) => formatName(k.format)))].join(' · ');
    const badges = [
      c.keys.length && c.keys.every((k: any) => k.verified) ? 'verified' : '',
      c.keys.some((k: any) => k.pending) ? 'pending' : '',
      c.keys.some((k: any) => k.sources.some((s: any) => s.lastResult === 'missing')) ? 'missing' : '',
      c.keys.some((k: any) => k.info?.revoked) ? 'revoked' : '',
    ].filter(Boolean);
    items.push({
      key: c.id,
      kind: 'row',
      title: c.name,
      subtitle: formatsHeld,
      right: badges.join(' · ') || undefined,
      tone: badges.includes('revoked') ? 'warn' : undefined,
      onPress: () => setPage({kind: 'contact', id: c.id}),
    });
  }
  if (!q) {
    items.push({key: 's-move', kind: 'section', title: 'Move contacts'});
    items.push({
      key: 'move',
      kind: 'node',
      render: () => (
        <View>
          <Text style={styles.dim}>Public keys only - a file you can keep anywhere or open on another phone.</Text>
          <View style={styles.buttons}>
            <Btn title="Save to a folder" onPress={() => act(async () => { const r = await gb.exportFile(); if (r.saved) Alert.alert('Saved', `Guest Book saved as ${r.name || 'the chosen file'}.`); })} />
            <Btn title="Import" onPress={() => act(async () => { const r = await gb.importFile(); if (r) Alert.alert('Import', `${r.added} new contact(s), ${r.total - r.added} merged into ones here.`); })} />
          </View>
        </View>
      ),
    });
  }

  return (
    <View style={styles.root}>
      <View style={styles.bar}>
        <TextInput value={search} onChangeText={setSearch} placeholder={`Search ${gb.contacts.length} contacts`} placeholderTextColor={theme.textDim} autoCapitalize="none" autoCorrect={false} style={styles.search} />
        <Btn title="+ Add" tone="primary" onPress={() => setPage({kind: 'add'})} />
      </View>
      <View style={styles.subbar}>
        <Text style={styles.dim}>{gb.refreshing ? `Checking ${gb.refreshing}…` : 'Keys are checked only when you press Refresh.'}</Text>
        <Btn
          title="Refresh all"
          disabled={!!gb.refreshing || !gb.contacts.length}
          onPress={() => act(async () => { const changes = await gb.refreshAll(); Alert.alert('Refresh all', changes.length ? changes.join('\n') : 'Nothing changed.'); })}
        />
      </View>
      <EdgeList items={items} empty="Nothing matches." />
    </View>
  );
}

/* ---- share one key: Share, Copy, Show QR --------------------------------------------------- */

function SharePage({page, onBack}: {page: Extract<Page, {kind: 'share'}>; onBack: () => void}) {
  const [qr, setQr] = useState<string | null>(null);
  const [qrNote, setQrNote] = useState<string | null>(null);
  const showQr = async () => {
    try {
      const NativeQrScanner = require('../../../specs/NativeQrScanner').default;
      setQr(await NativeQrScanner.render(page.text, qrPixels()));
      setQrNote(null);
    } catch (e: any) {
      setQr(null);
      setQrNote(String(e?.code) === 'TOO_BIG' ? 'This key is too big for one QR code - use Share or Copy.' : String(e?.message ?? e));
    }
  };
  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <View style={styles.buttons}>
        <Btn title="‹ Back" onPress={onBack} />
      </View>
      <Section title={page.title}>
        <Text style={styles.dim}>A public key - safe to give to anyone.</Text>
        <View style={styles.buttons}>
          <Btn title="Share" tone="primary" onPress={() => void NativeShare.shareFile(page.file, `${page.text}\n`, 'text/plain', page.title)} />
          <Btn title="Copy" onPress={() => void copy(page.text, 'Public key')} />
          <Btn title="Show QR" onPress={() => void showQr()} />
        </View>
        {qr ? <Image source={{uri: qr}} style={styles.qr} accessibilityLabel={`QR code of ${page.title}`} /> : null}
        {qrNote ? <Text style={[styles.dim, {color: theme.warn}]}>{qrNote}</Text> : null}
        <Text selectable style={styles.mono}>{page.text}</Text>
      </Section>
    </ScrollView>
  );
}

/* ---- add: paste, scan, or look up ----------------------------------------------------------- */

function AddPage({gb, contactId, onDone, onInvite: startSwap}: {gb: ReturnType<typeof useGuestBook>; contactId?: string; onDone: (id?: string) => void; onInvite?: (url: string) => void}) {
  const [how, setHow] = useState<SourceChoice>('Paste');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Found[]>([]);
  const [source, setSource] = useState<Source>({kind: 'paste', handle: ''});
  const [needsCurve, setNeedsCurve] = useState<string[] | null>(null);
  const [results, setResults] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const target = contactId ? gb.contacts.find((c: Contact) => c.id === contactId) : null;

  const readText = async (body: string, src: Source) => {
    setError(null);
    setFound([]);
    setNeedsCurve(null);
    try {
      const r = await gb.read(body);
      setFound(r.found as Found[]);
      setSource(src);
      setNeedsCurve(r.needsCurve);
      if (!r.found.length && !r.needsCurve) setError(r.errors[0] ?? 'No public key found in that.');
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  };

  const scan = async () => {
    try {
      const NativeQrScanner = require('../../../specs/NativeQrScanner').default;
      const t: string | null = await NativeQrScanner.scan("Point the camera at the person's key QR");
      if (t && isInvite(t) && startSwap) {
        startSwap(t);
      } else if (t) {
        setText(t);
        await readText(t, {kind: 'qr', handle: ''});
      }
    } catch (e: any) {
      setError(/PERMISSION/.test(String(e?.code ?? e?.message)) ? 'the camera was not allowed: Android settings › Apps › OnlyKey › Permissions' : String(e?.message ?? e));
    }
  };

  const lookUp = async () => {
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const r = await gb.lookup(LOOKUP_KIND[how]!, query);
      setResults(r);
      if (!r.length) setError('Nothing found there.');
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const save = async (keys: Found[], src: Source, suggested?: string) => {
    try {
      const saved = await gb.add({name: name.trim() || suggested, found: keys, source: src, contactId});
      const id = contactId ?? saved[saved.length - 1]?.id;
      onDone(id);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  };

  const lookupKind = LOOKUP_KIND[how];
  return (
    <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
      <View style={styles.buttons}>
        <Btn title="‹ Back" onPress={() => onDone(contactId)} />
      </View>
      <Section title={target ? `Add a key to ${target.name}` : 'Add a contact'}>
        <Text style={styles.dim}>Public keys only. Nothing is fetched until you press Look up.</Text>
        <Segmented options={SOURCES} value={how} onChange={v => { setHow(v); setFound([]); setResults(null); setError(null); setNeedsCurve(null); }} />
        {!target ? <Field label="Name (optional - taken from the key otherwise)" value={name} onChange={setName} /> : null}
        {how === 'Paste' ? (
          <>
            <Field label="Paste a PGP key, an SSH line, an age1... recipient, or raw hex" value={text} onChange={setText} multiline />
            <View style={styles.buttons}>
              <Btn title="Read" tone="primary" disabled={!text.trim()} onPress={() => void readText(text, {kind: 'paste', handle: ''})} />
            </View>
          </>
        ) : null}
        {how === 'Scan' ? (
          <View style={styles.buttons}>
            <Btn title="Scan QR" tone="primary" onPress={() => void scan()} />
          </View>
        ) : null}
        {lookupKind ? (
          <>
            <Field label={LOOKUP_HINT[how]!} value={query} onChange={setQuery} />
            <View style={styles.buttons}>
              <Btn title={busy ? 'Looking up…' : 'Look up'} tone="primary" disabled={busy || !query.trim()} onPress={() => void lookUp()} />
            </View>
          </>
        ) : null}
        {error ? <Text style={[styles.dim, {color: theme.error}]}>{error}</Text> : null}
      </Section>

      {needsCurve ? (
        <Section title="Which kind of raw key is it?">
          <Text style={styles.dim}>A raw key does not say what it is - the length fits these.</Text>
          <View style={styles.buttons}>
            {needsCurve.map(f => (
              <Btn key={f} title={f.slice(4)} onPress={() => { try { setFound([gb.readRaw(text, f) as Found]); setNeedsCurve(null); } catch (e: any) { setError(String(e?.message ?? e)); } }} />
            ))}
          </View>
        </Section>
      ) : null}

      {found.length ? (
        <Section title={`Found ${found.length} key${found.length === 1 ? '' : 's'}`}>
          {found.map(k => (
            <KeyValue key={`${k.format}:${k.fingerprint}`} label={`${formatName(k.format)} · ${k.label}`} value={showFingerprint(k)} />
          ))}
          <View style={styles.buttons}>
            <Btn title={target ? 'Add to contact' : 'Save contact'} tone="primary" onPress={() => void save(found, source)} />
          </View>
        </Section>
      ) : null}

      {results?.map((r, i) => (
        <Section key={`${r.where}:${i}`} title={r.label}>
          <Text style={styles.dim}>{r.where}</Text>
          {r.error ? <Text style={[styles.dim, {color: theme.error}]}>{r.error}</Text> : null}
          {r.found.map((k: Found) => (
            <KeyValue key={`${k.format}:${k.fingerprint}`} label={`${formatName(k.format)} · ${k.label}`} value={showFingerprint(k)} />
          ))}
          {r.found.length ? (
            <View style={styles.buttons}>
              <Btn title={target ? 'Add to contact' : 'Add'} tone="primary" onPress={() => void save(r.found, r.source, r.label)} />
            </View>
          ) : null}
        </Section>
      ))}
    </ScrollView>
  );
}

/* ---- one contact ---------------------------------------------------------------------------- */

function ContactPage({
  c,
  gb,
  act,
  onBack,
  onAddKey,
  onShare,
}: {
  c: Contact;
  gb: ReturnType<typeof useGuestBook>;
  act: (fn: () => unknown) => void;
  onBack: () => void;
  onAddKey: () => void;
  onShare: (title: string, text: string, file: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(c.name);
  const [note, setNote] = useState(c.note ?? '');
  const fetchable = c.keys.some((k: any) => k.sources.some((s: any) => ['keybase', 'protonmail', 'github', 'url'].includes(s.kind)));
  return (
    <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
      <View style={styles.buttons}>
        <Btn title="‹ Back" onPress={onBack} />
      </View>
      <Section title={c.name}>
        {c.note && !editing ? <Text style={styles.body}>{c.note}</Text> : null}
        {editing ? (
          <>
            <Field label="Name" value={name} onChange={setName} />
            <Field label="Note" value={note} onChange={setNote} multiline />
            <View style={styles.buttons}>
              <Btn title="Save" tone="primary" onPress={() => act(async () => { await gb.rename(c.id, name, note); setEditing(false); })} />
              <Btn title="Cancel" onPress={() => setEditing(false)} />
            </View>
          </>
        ) : (
          <View style={styles.buttons}>
            {fetchable ? (
              <Btn
                title={gb.refreshing ? 'Checking…' : 'Refresh'}
                disabled={!!gb.refreshing}
                onPress={() => act(async () => { const ch = await gb.refreshOne(c.id); Alert.alert('Refresh', ch.length ? ch.join('\n') : 'Nothing changed.'); })}
              />
            ) : null}
            <Btn title="Add a key" onPress={onAddKey} />
            <Btn title="Edit" onPress={() => setEditing(true)} />
            <Btn
              title="Delete"
              tone="danger"
              onPress={() =>
                Alert.alert('Delete contact', `Remove ${c.name} and their keys from Guest Book?`, [
                  {text: 'Cancel', style: 'cancel'},
                  {text: 'Delete', style: 'destructive', onPress: () => act(async () => { await gb.remove(c.id); onBack(); })},
                ])
              }
            />
          </View>
        )}
      </Section>

      {c.keys.map((k: any) => (
        <Section key={k.id} title={`${formatName(k.format)}${k.verified ? ' ✓ verified' : ''}${k.info?.revoked ? ' - REVOKED' : ''}`}>
          <KeyValue label="Fingerprint" value={showFingerprint(k)} />
          {k.label ? <KeyValue label="Label" value={k.label} /> : null}
          {k.format === 'openpgp' && k.info?.users?.length ? <KeyValue label="User ids" value={k.info.users.join('\n')} /> : null}
          {k.info?.created ? <KeyValue label="Created" value={k.info.created.slice(0, 10)} /> : null}
          {k.info?.expires ? <KeyValue label="Expires" value={k.info.expires.slice(0, 10)} /> : null}
          {k.sources.length ? (
            <KeyValue
              label="From"
              value={k.sources
                .map((s: any) => `${s.kind}${s.handle ? ` ${s.handle}` : ''}${s.lastResult ? ` - ${s.lastResult}${s.lastChecked ? `, ${s.lastChecked.slice(0, 16).replace('T', ' ')}` : ''}` : ''}`)
                .join('\n')}
            />
          ) : null}
          {k.pending ? (
            <View style={styles.pending}>
              <Text style={[styles.body, {color: theme.warn}]}>
                {k.pending.conflict ? 'Two sources serve two different keys - keep yours, or pick one.' : 'A source now serves a different key. It is NOT used until you accept it.'}
              </Text>
              <KeyValue label="Current" value={showFingerprint(k)} />
              {k.pending.candidates.map((cand: any) => (
                <View key={cand.fingerprint}>
                  <KeyValue label={`New, from ${cand.source.kind} ${cand.source.handle}`} value={showFingerprint({format: k.format, fingerprint: cand.fingerprint})} />
                  <View style={styles.buttons}>
                    <Btn title="Accept this key" onPress={() => act(() => gb.accept(c.id, k.id, cand.fingerprint))} />
                  </View>
                </View>
              ))}
              <View style={styles.buttons}>
                <Btn title="Keep current" tone="primary" onPress={() => act(() => gb.keepCurrent(c.id, k.id))} />
                <Btn title="Keep and remove the source" onPress={() => act(() => gb.keepAndRemove(c.id, k.id))} />
              </View>
            </View>
          ) : null}
          <View style={styles.buttons}>
            <Btn title="Share" onPress={() => onShare(`${c.name} - ${formatName(k.format)}`, k.text, fileFor(k, c.name))} />
            <Btn title="Copy" onPress={() => act(() => copy(k.text, 'Public key'))} />
            <Btn
              title={k.verified ? 'Clear verified' : 'Mark verified'}
              onPress={() =>
                k.verified
                  ? act(() => gb.setVerified(c.id, k.id, false))
                  : Alert.alert('Mark verified', 'Only when you compared this fingerprint with the person directly (in person, or on a call you trust).', [
                      {text: 'Cancel', style: 'cancel'},
                      {text: 'They match', onPress: () => act(() => gb.setVerified(c.id, k.id, true))},
                    ])
              }
            />
            {c.keys.length > 1 ? <Btn title="Remove key" tone="danger" onPress={() => act(() => gb.removeKey(c.id, k.id))} /> : null}
          </View>
        </Section>
      ))}
    </ScrollView>
  );
}

function BackOnly({onBack, text}: {onBack: () => void; text: string}) {
  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <Btn title="‹ Back" onPress={onBack} />
      <Text style={styles.dim}>{text}</Text>
    </ScrollView>
  );
}

function Field({label, value, onChange, multiline}: {label: string; value: string; onChange: (s: string) => void; multiline?: boolean}) {
  return (
    <View style={styles.field}>
      <Text style={styles.dim}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        importantForAutofill="no"
        placeholderTextColor={theme.textDim}
        style={[styles.input, multiline && styles.multi]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  bar: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 8},
  subbar: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 16, paddingVertical: 6},
  search: {flex: 1, color: theme.text, backgroundColor: theme.inputBg, borderRadius: 8, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 12, paddingVertical: 8, fontSize: 15},
  pad: {padding: 16, gap: 12},
  buttons: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8},
  dim: {color: theme.textDim, fontSize: 13, flexShrink: 1},
  body: {color: theme.text, fontSize: 14, lineHeight: 20},
  mono: {color: theme.text, fontFamily: theme.mono, fontSize: 11, marginTop: 12},
  /* full width of the card (Brad, 2026-10-12: "the QR code must be full width"), square */
  qr: {alignSelf: 'stretch', aspectRatio: 1, marginTop: 12, backgroundColor: '#fff'},
  pending: {marginTop: 8, padding: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.warn},
  field: {marginTop: 8},
  input: {marginTop: 4, color: theme.text, fontSize: 14, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: theme.inputBg, borderRadius: 8, borderWidth: 1, borderColor: theme.border},
  multi: {minHeight: 120, textAlignVertical: 'top', fontFamily: theme.mono, fontSize: 12},
});
