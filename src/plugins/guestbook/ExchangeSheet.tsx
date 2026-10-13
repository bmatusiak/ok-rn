import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Dimensions, Image, PixelRatio, StyleSheet, Text, TextInput, View} from 'react-native';
import {useActiveKey} from '../../hooks/KeyContext';
import {Choice} from '../../screens/keychain/shared';
import {Btn} from '../../ui/components';
import {Sheet} from '../../ui/Sheet';
import {theme} from '../../ui/theme';
import type {MyKey} from './myCard';
import {openpgp, randomBytes, readMyName} from './service';
import {createSwap, type Card, type SwapView} from './swapLink';
import {contactIdentity, nativeLink} from './swapNative';
import type {Contact, Found, useGuestBook} from './useGuestBook';

const {formats} = require('node-onlykey-lib/guestbook');

/*
 * THE EXCHANGE SHEET - blue, Guest Book's own (Brad, 2026-10-12: "both phones go into a pubkey
 * exchange prompt or sheet (edge has yellow edges for the sheet) maybe we can do blue for
 * guestbook sheet"). Both phones show it: the one showing the QR from the moment it is open,
 * the one that scanned from the moment it connects. Each person picks which of their keys to
 * give; nothing crosses until Send. What arrives is shown with fingerprints and saved only when
 * the person says - verified, because it was handed over in person.
 *
 * It draws swapLink's `view` and nothing else decides here. Close ends the link: nothing is
 * kept, no pairing is saved.
 */

const FORMAT_OF: Record<MyKey['format'], string> = {PGP: 'openpgp', SSH: 'ssh', age: 'age'};
const qrPixels = () => Math.min(2048, Math.round(Dimensions.get('window').width * PixelRatio.get()));

export function ExchangeSheet({
  start,
  mine,
  gb,
  onClose,
}: {
  /** 'host': show this phone's invite QR; otherwise the invite text this phone scanned */
  start: 'host' | {join: string};
  mine: MyKey[];
  gb: ReturnType<typeof useGuestBook>;
  onClose: () => void;
}) {
  const getKey = useActiveKey();
  const [view, setView] = useState<SwapView>({step: 'connecting'});
  const [qr, setQr] = useState<string | null>(null);
  /* every offered key is picked to start with: offering it (Me) was the choice; unpick one here for this swap */
  const [picked, setPicked] = useState<Set<string>>(() => new Set(mine.map(k => k.id)));
  const [arrived, setArrived] = useState<Found[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  /*
   * THEIR NAME, ASKED BEFORE SAVING (Brad, 2026-10-12: "Ask before saving"). A card carries no
   * name of its own; a PGP key that came across names its owner, so its user id fills the box.
   */
  const [name, setName] = useState('');
  /* the name this person set on the Me page: it goes on their card */
  const [myName, setMyName] = useState('');
  useEffect(() => {
    readMyName().then(setMyName, () => {});
  }, []);
  const swap = useRef<ReturnType<typeof createSwap> | null>(null);

  useEffect(() => {
    const s = createSwap({link: nativeLink, identity: contactIdentity(getKey as any), randomBytes, onView: setView});
    swap.current = s;
    if (start === 'host') void s.host();
    else void s.join(start.join);
    return () => {
      void s.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* the invite QR, drawn once it exists (full width, the logo in the middle) */
  const url = view.step === 'waiting' ? view.url : null;
  useEffect(() => {
    if (!url) return;
    const NativeQrScanner = require('../../../specs/NativeQrScanner').default;
    NativeQrScanner.render(url, qrPixels()).then(setQr, () => setQr(null));
  }, [url]);

  /* what the other person gave, read the way every way into Guest Book reads keys */
  const received = view.step === 'linked' ? view.received : null;
  useEffect(() => {
    if (!received) return;
    (async () => {
      const out: Found[] = [];
      for (const k of received.keys) {
        const {found} = await formats.detectAll(k.text, {openpgp: openpgp()});
        /* a PGP key names itself (its user id); any other is named as the sender named it */
        out.push(...found.map((f: Found) => ({...f, label: (f.format === 'openpgp' && f.label) || k.label || f.label})));
      }
      setArrived(out);
      const pgp = out.find(f => f.format === 'openpgp' && f.label);
      /* the name they gave themselves first; else their PGP key's owner; editable either way */
      setName(n => n || received.name || (pgp ? pgp.label.replace(/\s*<[^>]*>\s*$/, '') : '') || '');
    })().catch(() => setArrived([]));
  }, [received]);

  const card = (): Card => ({
    name: myName,
    keys: mine.filter(k => picked.has(k.id)).map(k => ({format: FORMAT_OF[k.format], label: k.title, text: k.text})),
  });
  const peerId = view.step === 'linked' ? view.peerId : '';
  const source = useMemo(() => ({kind: 'connect', handle: peerId.replace(/ /g, '').toLowerCase()}), [peerId]);
  const save = async (contact?: Contact) => {
    if (!arrived?.length) return;
    await gb.add({name: name.trim(), found: arrived, source, contactId: contact?.id});
    setSaved(contact ? contact.name : name.trim());
  };

  const title =
    view.step === 'waiting' ? 'Swap keys in person'
      : view.step === 'connecting' ? 'Connecting…'
        : view.step === 'press' ? 'Confirm on your OnlyKey'
          : view.step === 'linked' ? 'Linked - pick what to give'
            : 'The swap stopped';

  return (
    <Sheet visible tone="guestbook" title={title} onClose={onClose}>
      {view.step === 'waiting' ? (
        <>
          <Text style={styles.line}>Show this to the other person. Their phone scans it (Guest Book → Add → Scan, or the camera). Then both of you pick which keys to give.</Text>
          {qr ? <Image source={{uri: qr}} style={styles.qr} accessibilityLabel="Swap invite QR" /> : <Text style={styles.dim}>Drawing the QR…</Text>}
          <Text style={styles.dim}>It works only while this sheet is open, and only for someone standing here.</Text>
        </>
      ) : null}

      {view.step === 'connecting' ? <Text style={styles.line}>Finding the other phone over Bluetooth…</Text> : null}

      {view.step === 'press' ? (
        <>
          <Text style={styles.line}>Your OnlyKey proves it is yours by opening what the other phone sealed to it.</Text>
          {view.digits?.length ? <Text style={styles.big}>Press {view.digits.join(' - ')}</Text> : <Text style={styles.line}>Press it when it asks.</Text>}
        </>
      ) : null}

      {view.step === 'linked' ? (
        <>
          <Text style={styles.ok}>Linked with {view.peerId}. Its OnlyKey proved itself.</Text>
          <Text style={styles.head}>Your keys to give</Text>
          {mine.length ? (
            mine.map(k => (
              <Choice
                key={k.id}
                title={`${picked.has(k.id) ? '☑' : '☐'}  ${k.title}`}
                info={k.format}
                selected={picked.has(k.id)}
                disabled={view.sent}
                onPress={() => setPicked(p => {
                  const n = new Set(p);
                  if (n.has(k.id)) n.delete(k.id); else n.add(k.id);
                  return n;
                })}
              />
            ))
          ) : (
            <Text style={styles.dim}>You offer no keys in swaps yet - on Me, open a key and turn on "Offer in key swaps". You can still receive theirs.</Text>
          )}
          <Text style={styles.dim}>{myName ? `They will see you as "${myName}".` : 'No name set - they will name you themselves. Set yours on the Me page.'}</Text>
          <Btn
            title={view.sent ? 'Sent' : `Send ${picked.size} key${picked.size === 1 ? '' : 's'}`}
            tone="primary"
            disabled={view.sent}
            onPress={() => void swap.current?.send(card())}
          />

          <Text style={styles.head}>From them</Text>
          {!received ? <Text style={styles.dim}>Waiting for them to send…</Text> : null}
          {received && !arrived ? <Text style={styles.dim}>Reading their keys…</Text> : null}
          {arrived ? (
            <>
              {arrived.map(f => (
                <View key={`${f.format}:${f.fingerprint}`} style={styles.key}>
                  <Text style={styles.line}>{f.label || f.format}</Text>
                  <Text style={styles.mono}>{f.format}  ·  {f.fingerprint}</Text>
                </View>
              ))}
              {!arrived.length ? (
                <Text style={styles.dim}>{received?.keys.length ? 'They sent no keys this app can read.' : 'They chose not to give any keys.'}</Text>
              ) : null}
              {saved ? (
                <Text style={styles.ok}>Saved to {saved} - verified (in person).</Text>
              ) : arrived.length ? (
                <>
                  <Text style={styles.head}>Their name</Text>
                  <TextInput
                    style={styles.input}
                    value={name}
                    onChangeText={setName}
                    placeholder="who you swapped with"
                    placeholderTextColor={theme.textSecondary}
                    accessibilityLabel="Their name"
                  />
                  <Btn title="Save as a new contact" tone="primary" disabled={!name.trim()} onPress={() => void save()} />
                  {gb.contacts.slice(0, 8).map((c: Contact) => (
                    <Btn key={c.id} title={`Add to ${c.name}`} onPress={() => void save(c)} />
                  ))}
                </>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      {view.step === 'failed' ? <Text style={styles.warn}>{view.message}</Text> : null}

      <Btn title={saved || view.step === 'failed' ? 'Done' : 'Close - keep nothing'} onPress={onClose} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  line: {color: theme.text, fontSize: 14, lineHeight: 20, marginBottom: 8},
  dim: {color: theme.textSecondary, fontSize: 13, lineHeight: 19, marginBottom: 8},
  head: {color: theme.text, fontSize: 15, fontWeight: '600', marginTop: 12, marginBottom: 6},
  big: {color: theme.text, fontSize: 22, fontWeight: '700', marginVertical: 8},
  ok: {color: theme.ok, fontSize: 14, lineHeight: 20, marginBottom: 8},
  warn: {color: theme.warn, fontSize: 14, lineHeight: 20, marginBottom: 8},
  mono: {color: theme.textSecondary, fontFamily: 'monospace', fontSize: 11},
  key: {paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border},
  qr: {alignSelf: 'stretch', aspectRatio: 1, marginVertical: 8, backgroundColor: '#fff'},
  input: {color: theme.text, fontSize: 15, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 8, backgroundColor: theme.inputBg, borderRadius: 8, borderWidth: 1, borderColor: theme.border},
});
