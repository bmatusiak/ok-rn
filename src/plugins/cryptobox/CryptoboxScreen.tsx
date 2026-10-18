import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';

import okpure from 'node-onlykey-lib/crypto';
import {store} from 'node-onlykey-lib/cryptobox';
import NativeSecrets from '../../../specs/NativeSecrets';
import NativeShare from '../../../specs/NativeShare';
import {useActiveKey} from '../../hooks/KeyContext';
import {armDeviceKey, deviceKeyFor, openpgpFork, readDeviceKeys, type DeviceKey} from '../../pgpOps';
import {indexSigners, signedBy, signerOf} from '../../signers';
import {Btn} from '../../ui/components';
import {EdgeList, type EdgeListItem} from '../../ui/EdgeList';
import {ListPicker, type PickItem} from '../../ui/ListPicker';
import {RowActions} from '../../ui/RowActions';
import {theme} from '../../ui/theme';
import type {RecipientContact, RecipientsService} from '../recipients';
import type {TabContext} from '../types';
import {ME, openBox, type BoxMessage} from './service';

/*
 * CRYPTOBOX (onlykey-edge/features/CRYPTOBOX-SPEC.md; Brad, 2026-10-18: "i want to store messages
 * in the app, i dont want to store decrypted or unsigned data ... design to be like a messaging
 * app, a list of contacts i created encrypted messages for ... a pre-design to a messenger chat").
 *
 * Three pages: the list of people you have messages with; one person's thread, chat-style; and
 * Import message. What is stored is only ever the armored block (the lib's store refuses anything
 * else). Opening a bubble decrypts it with your key on the device - a press - and the text lives
 * in this screen's memory until you leave the thread.
 *
 * His choices (2026-10-18): a sent message is encrypted to them AND you, so your side of the thread
 * opens again later; signing is chosen per message; an imported message is filed under whoever
 * signed it, and an unsigned encrypted one under the person you pick ("if a encrypted message is
 * signed, its obvious who it came from").
 */

type Person = RecipientContact;
type Page = {kind: 'list'} | {kind: 'thread'; contact: string} | {kind: 'import'};
/* a bubble opened in this visit: its text and who signed it - memory only, never stored */
type Opened = {text: string; line: string};

const when = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString(undefined, {month: 'short', day: 'numeric'})} ${hm}`;
};

const verifiedLine = (p: Person) => {
  if (p.id === ME) return 'you';
  const ok = p.keys.filter(k => k.verified).length;
  return ok === p.keys.length ? '✓ verified' : ok ? `! ${ok} of ${p.keys.length} verified` : '! unverified';
};

export function CryptoboxScreen({recipients}: {ctx: TabContext; recipients: RecipientsService}) {
  const getKey = useActiveKey();
  const [page, setPage] = useState<Page>({kind: 'list'});
  const [people, setPeople] = useState<Person[]>([]);
  const [messages, setMessages] = useState<BoxMessage[]>([]);
  const [deviceKeys, setDeviceKeys] = useState<DeviceKey[]>([]);
  const [opened, setOpened] = useState<Record<string, Opened>>({});
  const [challenge, setChallenge] = useState<number[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const box = useMemo(() => openBox(), []);
  const reload = useCallback(async () => {
    const sources = recipients.list();
    const lists = await Promise.all(sources.map(s => Promise.all([s.me(), s.pgpContacts()]).then(([me, list]) => (me ? [me, ...list] : list))));
    setPeople(lists.flat());
    setMessages((await box.load()).messages as BoxMessage[]);
    setDeviceKeys(await readDeviceKeys());
  }, [recipients, box]);
  useEffect(() => {
    reload().catch(e => setError(String(e?.message ?? e)));
  }, [reload]);

  const byId = useMemo(() => new Map(people.map(p => [p.id, p])), [people]);
  const me = byId.get(ME) ?? null;
  const nameOf = (id: string) => byId.get(id)?.name ?? (id === ME ? 'Me' : 'Not in Guest Book any more');
  const go = (p: Page) => {
    setError(null);
    /* leaving a thread forgets what was opened in it */
    setOpened({});
    setPage(p);
  };

  /* open one message: decrypt with the device key it was encrypted to (a press), or check a signed one */
  const openMessage = useCallback(
    async (armored: string): Promise<{text: string; line: string; signer: ReturnType<typeof signerOf>}> => {
      const openpgp = openpgpFork();
      const everyone = people.flatMap(p => p.keys.map(k => k.text));
      const signers = await indexSigners(openpgp, people);
      if (store.kindOf(armored) === 'signed') {
        const r = await okpure.messages.verifyText(openpgp, {armored, verifyWith: everyone});
        return {text: String(r.data), line: signedBy(r.signatures, signers) || 'There is no signature on it.', signer: signerOf(r.signatures, signers)};
      }
      const key = await deviceKeyFor(armored, deviceKeys);
      if (!key) throw new Error('This message is not encrypted to any of your keys on this OnlyKey.');
      const armed = await armDeviceKey(getKey, key, setChallenge);
      try {
        const r = await okpure.messages.decryptMessage(openpgp, {armored, decryptWith: armed.privateKey as any, verifyWith: everyone.length ? everyone : null});
        return {text: typeof r.data === 'string' ? r.data : '(a file - open it in Encrypt / Decrypt)', line: signedBy(r.signatures, signers) || 'Not signed.', signer: signerOf(r.signatures, signers)};
      } finally {
        armed.disarm();
      }
    },
    [people, deviceKeys, getKey],
  );

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const banner = (
    <>
      {challenge ? <Text style={styles.status}>The key is waiting: press {challenge.join(' - ')} on it.</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </>
  );

  if (page.kind === 'thread') {
    return (
      <Thread
        contact={page.contact}
        person={byId.get(page.contact) ?? null}
        me={me}
        name={nameOf(page.contact)}
        messages={messages.filter(m => m.contact === page.contact)}
        opened={opened}
        busy={busy}
        banner={banner}
        signKey={deviceKeys[0] ?? null}
        onBack={() => go({kind: 'list'})}
        onOpen={m =>
          run('open', async () => {
            const r = await openMessage(m.armored);
            setOpened(o => ({...o, [m.id]: {text: r.text, line: r.line}}));
          })
        }
        onSend={(text, sign) =>
          run('send', async () => {
            const to = byId.get(page.contact);
            if (!me) throw new Error('You have no PGP key yet, so you could not read what you send. Make a +PQC key in Key Chain first.');
            if (!to || !to.keys.length) throw new Error('This person has no PGP key in Guest Book any more.');
            /* them AND you, so your side of the thread opens again later */
            const keys = page.contact === ME ? me.keys : [...to.keys, ...me.keys];
            const openpgp = openpgpFork();
            let signWith: unknown = null;
            let disarm: (() => void) | null = null;
            if (sign) {
              const key = deviceKeys[0];
              if (!key) throw new Error('Signing needs your +PQC key on the device - make one in Key Chain.');
              const armed = await armDeviceKey(getKey, key, setChallenge);
              signWith = armed.privateKey;
              disarm = armed.disarm;
            }
            try {
              const armored = String(await okpure.messages.encryptText(openpgp, {text, recipients: keys.map(k => k.text), signWith: signWith as any}));
              const saved = await box.add({contact: page.contact, dir: 'out', armored, signed: sign});
              setMessages(list => [...list, saved as BoxMessage]);
              /* you just typed it: shown open until you leave, never stored */
              setOpened(o => ({...o, [saved.id]: {text, line: sign ? 'Signed by you.' : 'Not signed.'}}));
            } finally {
              disarm?.();
            }
          })
        }
        onDelete={id =>
          run('delete', async () => {
            await box.remove(id);
            setMessages(list => list.filter(m => m.id !== id));
          })
        }
      />
    );
  }

  if (page.kind === 'import') {
    return (
      <ImportPage
        people={people}
        busy={busy}
        banner={banner}
        onBack={() => go({kind: 'list'})}
        openMessage={openMessage}
        run={run}
        file={async (contact, armored, signed) => {
          const saved = await box.add({contact, dir: 'in', armored, signed});
          setMessages(list => [...list, saved as BoxMessage]);
        }}
        onShowThread={contact => go({kind: 'thread', contact})}
        nameOf={nameOf}
      />
    );
  }

  /* ---- the list ---------------------------------------------------------------------------- */
  const pickItems: PickItem[] = people.map(p => ({key: p.id, title: p.name, detail: verifiedLine(p), detailTone: p.id === ME || p.keys.every(k => k.verified) ? 'ok' : 'warn'}));
  const items: EdgeListItem[] = store.threads(messages).map((t: {contact: string; count: number; last: BoxMessage}) => {
    const p = byId.get(t.contact);
    return {
      key: t.contact,
      kind: 'row' as const,
      title: nameOf(t.contact),
      detail: `${t.last.dir === 'out' ? 'You' : 'They'}: ${t.last.kind === 'signed' ? '✍ signed' : '🔒 encrypted'} · ${t.count} message${t.count === 1 ? '' : 's'}`,
      detailTone: p ? undefined : 'warn',
      right: when(t.last.at),
      onPress: () => go({kind: 'thread', contact: t.contact}),
    };
  });
  return (
    <View style={styles.root}>
      <View style={styles.bar}>
        <ListPicker
          label="New"
          placeholder="Write to…"
          sheetTitle="Write to"
          tone="guestbook"
          items={pickItems}
          selected={[]}
          onChange={keys => keys[0] && go({kind: 'thread', contact: keys[0]})}
          onOpen={() => void reload()}
          empty="Nobody with a PGP key in Guest Book yet - swap keys with someone there first."
        />
        <View style={styles.row}>
          <Btn title="Import message" onPress={() => go({kind: 'import'})} />
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
      <EdgeList items={items} empty="No messages yet. Write to someone, or import a message you were sent." />
    </View>
  );
}

/* ---- one person's thread, chat-style --------------------------------------------------------- */

function Thread({
  contact,
  person,
  me,
  name,
  messages,
  opened,
  busy,
  banner,
  signKey,
  onBack,
  onOpen,
  onSend,
  onDelete,
}: {
  contact: string;
  person: Person | null;
  me: Person | null;
  name: string;
  messages: BoxMessage[];
  opened: Record<string, Opened>;
  busy: string | null;
  banner: React.ReactNode;
  signKey: DeviceKey | null;
  onBack: () => void;
  onOpen: (m: BoxMessage) => void;
  onSend: (text: string, sign: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const [text, setText] = useState('');
  /* signed by default (Brad, 2026-10-18); off only when there is no +PQC key on the device to sign with */
  const [signWanted, setSign] = useState(true);
  const sign = signWanted && !!signKey;
  const [actionFor, setActionFor] = useState<BoxMessage | null>(null);
  const scroller = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const canSend = !!person && person.keys.length > 0 && !!me;
  return (
    <View style={styles.root}>
      <View style={styles.topbar}>
        <Btn title="‹ Back" onPress={onBack} />
        <View style={styles.flex}>
          <Text style={styles.title} numberOfLines={1}>{name}</Text>
          {person ? <Text style={[styles.dim, {color: contact === ME || person.keys.every(k => k.verified) ? theme.ok : theme.warn}]}>{verifiedLine(person)}</Text> : null}
        </View>
      </View>
      <ScrollView ref={scroller} style={styles.flex} contentContainerStyle={styles.thread} onContentSizeChange={() => scroller.current?.scrollToEnd({animated: false})}>
        {messages.length ? null : <Text style={styles.dim}>No messages with {name} yet.</Text>}
        {messages.map(m => {
          const o = opened[m.id];
          const mine = m.dir === 'out';
          return (
            <Pressable
              key={m.id}
              onPress={() => (o || busy ? undefined : onOpen(m))}
              onLongPress={() => setActionFor(m)}
              accessibilityRole="button"
              accessibilityLabel={o ? `Message: ${o.text}` : `${mine ? 'Sent' : 'Received'} message, ${m.kind}, tap to open`}
              style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
              {o ? (
                <>
                  <Text style={styles.bubbleText} selectable>{o.text}</Text>
                  {/* the lock stays on an opened bubble: it is still stored encrypted (Brad, 2026-10-18) */}
                  <Text style={styles.bubbleMeta}>{m.kind === 'encrypted' ? '🔒 ' : '✍ '}{o.line} · {when(m.at)}</Text>
                </>
              ) : (
                <>
                  <Text style={styles.bubbleText}>{m.kind === 'signed' ? '✍ Signed message' : '🔒 Encrypted'}{m.kind === 'encrypted' && m.signed ? ' · signed' : ''}</Text>
                  <Text style={styles.bubbleMeta}>{busy === 'open' ? 'Opening…' : 'Tap to open'} · {when(m.at)}</Text>
                </>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
      {banner}
      <View style={styles.compose}>
        {canSend ? null : (
          <Text style={styles.dim}>{!me ? 'Make a +PQC key in Key Chain to write - you need one to read what you send.' : 'This person has no PGP key in Guest Book.'}</Text>
        )}
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={`Message to ${name}`}
          placeholderTextColor={theme.textDim}
          multiline
          editable={canSend && !busy}
          style={styles.input}
        />
        <View style={styles.row}>
          <Btn
            title={sign ? 'Sign: on' : 'Sign: off'}
            tone={sign ? 'primary' : undefined}
            disabled={!signKey}
            onPress={() => setSign(s => !s)}
          />
          <View style={styles.flex} />
          <Btn
            title={busy === 'send' ? 'Sending…' : 'Send'}
            tone="primary"
            disabled={!canSend || !text.trim() || !!busy}
            onPress={() => {
              onSend(text, sign);
              setText('');
            }}
          />
        </View>
      </View>
      <RowActions
        title={actionFor ? `${actionFor.dir === 'out' ? 'Sent' : 'Received'} ${when(actionFor.at)}` : null}
        onClose={() => setActionFor(null)}
        actions={
          actionFor
            ? [
                {title: 'Copy the PGP block', onPress: () => { void NativeSecrets.copySensitive(actionFor.armored, 60000); setActionFor(null); }},
                {title: 'Share the PGP block', onPress: () => { void NativeShare.shareFile('message.asc', actionFor.armored, 'application/pgp-encrypted', 'PGP'); setActionFor(null); }},
                {title: 'Delete', onPress: () => { onDelete(actionFor.id); setActionFor(null); }},
              ]
            : []
        }
      />
    </View>
  );
}

/* ---- Import message: open it, then file it under whoever sent it ------------------------------ */

function ImportPage({
  people,
  busy,
  banner,
  onBack,
  openMessage,
  run,
  file,
  onShowThread,
  nameOf,
}: {
  people: Person[];
  busy: string | null;
  banner: React.ReactNode;
  onBack: () => void;
  openMessage: (armored: string) => Promise<{text: string; line: string; signer: {id: string; name: string} | null}>;
  run: (what: string, fn: () => Promise<void>) => Promise<void>;
  file: (contact: string, armored: string, signed: boolean) => Promise<void>;
  onShowThread: (contact: string) => void;
  nameOf: (id: string) => string;
}) {
  const [armored, setArmored] = useState('');
  /* after opening: what it says (memory only), and where it went - or that you must say who sent it */
  const [result, setResult] = useState<{text: string; line: string; filedUnder: string | null; needsPick: boolean} | null>(null);
  const pickItems: PickItem[] = people.map(p => ({key: p.id, title: p.name, detail: verifiedLine(p)}));
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.page}>
      {/* the page is padded already: the bar adds none of its own */}
      <View style={[styles.topbar, styles.flush]}>
        <Btn title="‹ Back" onPress={onBack} />
        <Text style={styles.title}>Import message</Text>
      </View>
      <Text style={styles.dim}>
        Paste a PGP message you were sent. It is opened once to see who it is from, then kept still encrypted in that person's thread. A signed message
        goes under its signer; an unsigned one under the person you pick.
      </Text>
      <TextInput
        value={armored}
        onChangeText={t => {
          setArmored(t);
          setResult(null);
        }}
        placeholder="-----BEGIN PGP MESSAGE-----"
        placeholderTextColor={theme.textDim}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, styles.paste]}
      />
      <View style={styles.row}>
        <Btn
          title={busy === 'import' ? 'Opening…' : 'Open and file it'}
          tone="primary"
          disabled={!armored.trim() || !!busy || !!result}
          onPress={() =>
            run('import', async () => {
              const block = armored.trim();
              store.kindOf(block); /* only encrypted or signed blocks - the reason shows if not */
              const r = await openMessage(block);
              if (r.signer) {
                await file(r.signer.id, block, true);
                setResult({text: r.text, line: r.line, filedUnder: r.signer.id, needsPick: false});
              } else if (store.kindOf(block) === 'signed') {
                throw new Error(`${r.line} Add the sender in Guest Book first, then import it again.`);
              } else {
                setResult({text: r.text, line: r.line, filedUnder: null, needsPick: true});
              }
            })
          }
        />
      </View>
      {banner}
      {result ? (
        <View style={styles.card}>
          <Text style={styles.bubbleText} selectable>{result.text}</Text>
          <Text style={styles.bubbleMeta}>{result.line}</Text>
          {result.filedUnder ? (
            <>
              <Text style={styles.ok}>Filed under {nameOf(result.filedUnder)}.</Text>
              <Btn title={`Open ${nameOf(result.filedUnder)}'s thread`} onPress={() => onShowThread(result.filedUnder!)} />
            </>
          ) : result.needsPick ? (
            <>
              <Text style={styles.warn}>Not signed, so nothing says who sent it. Pick who it is from:</Text>
              <ListPicker
                label="From"
                placeholder="Pick a person"
                sheetTitle="Who sent it?"
                tone="guestbook"
                items={pickItems}
                selected={[]}
                onChange={keys =>
                  keys[0] &&
                  run('import', async () => {
                    await file(keys[0], armored.trim(), false);
                    setResult(r => (r ? {...r, filedUnder: keys[0], needsPick: false} : r));
                  })
                }
              />
            </>
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  flex: {flex: 1},
  bar: {paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8, gap: 4},
  page: {padding: 16, gap: 12, paddingBottom: 48},
  topbar: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8},
  flush: {paddingHorizontal: 0},
  title: {color: theme.text, fontSize: 17, fontWeight: '600'},
  dim: {color: theme.textDim, fontSize: 12, lineHeight: 17},
  status: {color: theme.textSecondary, fontSize: 12, lineHeight: 18, paddingHorizontal: 16},
  error: {color: theme.error, fontSize: 13, lineHeight: 19, paddingHorizontal: 16},
  ok: {color: theme.ok, fontSize: 13},
  warn: {color: theme.warn, fontSize: 13, lineHeight: 18},
  row: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8},
  thread: {padding: 16, gap: 8},
  bubble: {maxWidth: '82%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, gap: 4},
  mine: {alignSelf: 'flex-end', backgroundColor: theme.accent},
  theirs: {alignSelf: 'flex-start', backgroundColor: theme.surfaceAlt},
  bubbleText: {color: theme.text, fontSize: 15, lineHeight: 21},
  bubbleMeta: {color: theme.textSecondary, fontSize: 11},
  compose: {paddingHorizontal: 16, paddingVertical: 8, borderTopWidth: 1, borderTopColor: theme.border, gap: 4},
  input: {color: theme.text, backgroundColor: theme.inputBg, borderRadius: theme.radius, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 12, paddingVertical: 8, fontSize: 15, maxHeight: 140},
  paste: {minHeight: 140, fontFamily: 'monospace', fontSize: 11},
  card: {borderWidth: 1, borderColor: theme.border, borderRadius: theme.radius, padding: 12, gap: 8},
});
