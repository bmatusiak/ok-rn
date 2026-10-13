import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Animated, Dimensions, PixelRatio, StyleSheet, Text, TextInput, View} from 'react-native';
import {useActiveKey, useBackend} from '../../hooks/KeyContext';
import {Choice} from '../../screens/keychain/shared';
import {Btn} from '../../ui/components';
import {CountdownBar} from '../../ui/CountdownBar';
import {Sheet} from '../../ui/Sheet';
import {theme} from '../../ui/theme';
import type {MyKey} from './myCard';
import {openpgp, randomBytes, readMyName} from './service';
import {createSwap, type Card, type SwapView} from './swapLink';
import {contactIdentity, isInvite, nativeLink} from './swapNative';
import type {Contact, Found, useGuestBook} from './useGuestBook';

const {formats, invite: inv} = require('node-onlykey-lib/guestbook');

/*
 * THE EXCHANGE SHEET - blue, Guest Book's own (Brad, 2026-10-12: "both phones go into a pubkey
 * exchange prompt or sheet (edge has yellow edges for the sheet) maybe we can do blue for
 * guestbook sheet").
 *
 * KEYS ARE PICKED FIRST (Brad, 2026-10-13: "we should select the key or keys before showing QR code
 * or before scanning ... so that way a key must be selected for a trade, i dont want to trade
 * without a key"). The sheet opens on the pick step - the keys turned on under Me, at least one -
 * and only then shows the QR, opens the camera, or connects to an invite already in hand. Once
 * both OnlyKeys have proved themselves the picked keys go out by themselves; a swap is always two
 * ways. Adding someone one way is Add → Paste or Scan a key QR, no Bluetooth.
 *
 * What arrives is shown with fingerprints and saved only when the person says - verified, because
 * it was handed over in person. Close ends the link: nothing is kept, no pairing is saved.
 */

const FORMAT_OF: Record<MyKey['format'], string> = {PGP: 'openpgp', SSH: 'ssh', age: 'age'};
const qrPixels = () => Math.min(2048, Math.round(Dimensions.get('window').width * PixelRatio.get()));

/** 'host': show this phone's QR; 'scan': scan theirs; {join}: an invite already read (Add → Scan, a link) */
export type SwapStart = 'host' | 'scan' | {join: string};

export function ExchangeSheet({
  start,
  mine,
  gb,
  onClose,
}: {
  start: SwapStart;
  /** the keys turned on under Me (Offer in key swaps) */
  mine: MyKey[];
  gb: ReturnType<typeof useGuestBook>;
  onClose: () => void;
}) {
  const getKey = useActiveKey();
  /* the soft key (embedded) has its own press sheet, which knows its mode; a hard key's mode the app cannot read */
  const backend = useBackend();
  /* 'pick' until the person has chosen; then the swap itself */
  const [phase, setPhase] = useState<'pick' | 'swap'>('pick');
  const [view, setView] = useState<SwapView>({step: 'connecting'});
  const [qr, setQr] = useState<string | null>(null);
  /*
   * A NEW CODE: THE OLD ONE FADES OUT, THEN THE NEW ONE FADES IN (Brad, 2026-10-12: "because phone
   * take time to render the qrcode ... i want it to fade out and in"). The old QR stays on screen
   * until the new one is drawn - never a blank square while the phone renders - then half a second
   * out, the swap, half a second in. The old code is still accepted for a window, so a slow redraw
   * costs nothing.
   */
  const opacity = useRef(new Animated.Value(1)).current;
  const shown = useRef<string | null>(null);
  const showQr = useCallback((next: string) => {
    if (!shown.current) {
      shown.current = next;
      setQr(next);
      return;
    }
    Animated.timing(opacity, {toValue: 0, duration: 500, useNativeDriver: true}).start(() => {
      shown.current = next;
      setQr(next);
      Animated.timing(opacity, {toValue: 1, duration: 500, useNativeDriver: true}).start();
    });
  }, [opacity]);
  /* every offered key is picked to start with: offering it (Me) was the choice; unpick here for this swap */
  const [picked, setPicked] = useState<Set<string>>(() => new Set(mine.map(k => k.id)));
  const [arrived, setArrived] = useState<Found[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /*
   * ADDING TO A CONTACT YOU ALREADY HAVE (Brad, 2026-10-13: "the user may have a lot of contact, so
   * a button, add to existing contact, that brings up the list of stored contacts, with back"): one
   * button, then the list in the sheet; Back returns to the swap without adding anything.
   */
  const [choosing, setChoosing] = useState(false);
  /*
   * THEIR NAME, ASKED BEFORE SAVING (Brad, 2026-10-12). The name they set on their Me page fills
   * it; else a PGP key's owner; editable either way.
   */
  const [name, setName] = useState('');
  /* the name this person set on the Me page: it goes on their card */
  const [myName, setMyName] = useState('');
  useEffect(() => {
    readMyName().then(setMyName, () => {});
  }, []);
  const swap = useRef<ReturnType<typeof createSwap> | null>(null);
  useEffect(() => () => void swap.current?.close(), []);

  const card = (): Card => ({
    name: myName,
    keys: mine.filter(k => picked.has(k.id)).map(k => ({format: FORMAT_OF[k.format], label: k.title, text: k.text})),
  });

  /* the person has picked: show the QR, scan theirs, or connect to the invite in hand */
  const begin = async () => {
    setNote(null);
    let invite: string | null = typeof start === 'object' ? start.join : null;
    if (start === 'scan') {
      try {
        const NativeQrScanner = require('../../../specs/NativeQrScanner').default;
        invite = await NativeQrScanner.scan('Point the camera at the other phone\'s swap QR');
      } catch (e: any) {
        setNote(String(e?.message ?? e));
        return;
      }
      if (!invite) return;
      if (!isInvite(invite)) {
        setNote('That QR is not a swap invite. To add a key one way, use Add → Scan.');
        return;
      }
    }
    const s = createSwap({link: nativeLink, identity: contactIdentity(getKey as any), randomBytes, onView: setView});
    swap.current = s;
    setPhase('swap');
    if (start === 'host') void s.host();
    else void s.join(invite!);
  };

  /* linked: the picked keys go out at once - nothing to press, a swap is always both ways */
  const linkedOpen = view.step === 'linked' && view.link === 'open' && !view.sent;
  useEffect(() => {
    if (linkedOpen) void swap.current?.send(card());
  }, [linkedOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  /* the invite QR, drawn once it exists (full width, the logo in the middle) */
  const url = view.step === 'waiting' ? view.url : null;
  useEffect(() => {
    if (!url) return;
    const NativeQrScanner = require('../../../specs/NativeQrScanner').default;
    NativeQrScanner.render(url, qrPixels()).then(showQr, () => setQr(null));
  }, [url, showQr]);

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
      setName(n => n || received.name || (pgp ? pgp.label.replace(/\s*<[^>]*>\s*$/, '') : '') || '');
    })().catch(() => setArrived([]));
  }, [received]);

  const peerId = view.step === 'linked' ? view.peerId : '';
  const source = useMemo(() => ({kind: 'connect', handle: peerId.replace(/ /g, '').toLowerCase()}), [peerId]);
  const save = async (contact?: Contact) => {
    if (!arrived?.length) return;
    await gb.add({name: name.trim(), found: arrived, source, contactId: contact?.id});
    setChoosing(false);
    setSaved(contact ? contact.name : name.trim());
  };

  const go = start === 'host' ? 'Show my QR' : start === 'scan' ? 'Scan their QR' : 'Connect';
  const title =
    phase === 'pick' ? 'Swap keys - pick what to give'
      : view.step === 'waiting' ? 'Swap keys in person'
        : view.step === 'connecting' ? 'Connecting…'
          : view.step === 'press' ? 'Confirm on your OnlyKey'
            : view.step === 'linked' ? 'Linked'
              : 'The swap stopped';

  return (
    <Sheet visible tone="guestbook" title={title} onClose={onClose}>
      {phase === 'pick' ? (
        <>
          {mine.length ? (
            <>
              <Text style={styles.line}>The keys the other person gets - at least one. They give you theirs the same way.</Text>
              {mine.map(k => (
                <Choice
                  key={k.id}
                  title={`${picked.has(k.id) ? '☑' : '☐'}  ${k.title}`}
                  info={k.format}
                  selected={picked.has(k.id)}
                  onPress={() => setPicked(p => {
                    const n = new Set(p);
                    if (n.has(k.id)) n.delete(k.id); else n.add(k.id);
                    return n;
                  })}
                />
              ))}
              <Text style={styles.dim}>{myName ? `They will see you as "${myName}".` : 'No name set - they will name you themselves. Set yours on the Me page.'}</Text>
              <Btn title={picked.size ? `${go} - give ${picked.size} key${picked.size === 1 ? '' : 's'}` : 'Pick at least one key'} tone="primary" disabled={!picked.size} onPress={() => void begin()} />
            </>
          ) : (
            <Text style={styles.line}>A swap needs at least one key to give. On Me, open a key - a PGP or age key - and turn on "Offer in key swaps". To add someone without giving yours, use Add → Paste or Scan.</Text>
          )}
          {note ? <Text style={styles.warn}>{note}</Text> : null}
        </>
      ) : null}

      {phase === 'swap' && view.step === 'waiting' ? (
        <>
          <Text style={styles.line}>Show this to the other person. Their phone scans it (Guest Book → Add → Scan, or the camera).</Text>
          {qr ? (
            <View style={styles.qrBox}>
              <Animated.Image source={{uri: qr}} style={[styles.qrImage, {opacity}]} accessibilityLabel="Swap invite QR" />
              {/* the QR's bottom border counts down to its next code (Brad, 2026-10-12) */}
              <CountdownBar period={inv.PERIOD_MS / 1000} style={styles.qrBar} />
            </View>
          ) : <Text style={styles.dim}>Drawing the QR…</Text>}
          <Text style={styles.dim}>The code changes every 30 seconds, so a photo of it soon stops working. It works only while this sheet is open, and once one phone links, no other can find this one.</Text>
        </>
      ) : null}

      {phase === 'swap' && view.step === 'connecting' ? <Text style={styles.line}>Finding the other phone over Bluetooth…</Text> : null}

      {phase === 'swap' && view.step === 'press' ? (
        <>
          <Text style={styles.line}>Your OnlyKey proves it is yours by opening what the other phone sealed to it.</Text>
          {/*
            NO CODE THAT MIGHT NOT BE ASKED (Brad, 2026-10-13: the 3 digits sat under the press sheet).
            The lib hands the challenge digits over on every press, but they are wanted only when the
            key is set to Challenge Code. The soft key's press sheet says which; for a hard key the
            app cannot know, so both are said.
          */}
          {backend === 'embedded' ? (
            <Text style={styles.line}>Confirm on the press sheet when it opens.</Text>
          ) : view.digits?.length ? (
            <Text style={styles.line}>Press any button on your OnlyKey. If it asks for a code, press {view.digits.join(' - ')}.</Text>
          ) : (
            <Text style={styles.line}>Press a button on your OnlyKey when it asks.</Text>
          )}
        </>
      ) : null}

      {phase === 'swap' && view.step === 'linked' && choosing ? (
        <>
          <Btn title="‹ Back" onPress={() => setChoosing(false)} />
          <Text style={styles.head}>Add their keys to which contact?</Text>
          {gb.contacts.length ? (
            [...gb.contacts]
              .sort((x: Contact, y: Contact) => String(x.name).localeCompare(String(y.name)))
              .map((c: Contact) => (
                <Choice
                  key={c.id}
                  title={c.name}
                  info={`${c.keys.length} key${c.keys.length === 1 ? '' : 's'}: ${[...new Set(c.keys.map((k: any) => k.format))].join(', ')}`}
                  selected={false}
                  onPress={() => void save(c)}
                />
              ))
          ) : (
            <Text style={styles.dim}>No contacts yet - save them as a new contact instead.</Text>
          )}
        </>
      ) : null}

      {phase === 'swap' && view.step === 'linked' && !choosing ? (
        <>
          <Text style={styles.ok}>Linked with {view.peerId}. Its OnlyKey proved itself.</Text>
          {/* the radio's state, said plainly: it ends as soon as nothing more will cross */}
          {view.link === 'done' ? <Text style={styles.dim}>Swap complete - the Bluetooth link is closed.</Text> : null}
          {view.link === 'left' ? <Text style={styles.dim}>They closed the swap - the Bluetooth link is closed.</Text> : null}
          {view.link === 'dropped' ? <Text style={styles.warn}>The Bluetooth link dropped.</Text> : null}
          <Text style={styles.dim}>{view.sent ? `You gave ${picked.size} key${picked.size === 1 ? '' : 's'}.` : view.link === 'open' ? (view.sending ? `Giving your keys… ${Math.floor((view.sending.have * 100) / view.sending.want)}%` : 'Giving your keys…') : 'Your keys did not go before the link ended.'}</Text>
          {/* your card going out: what the other phone has acknowledged (swapLink, 10% steps) */}
          {!view.sent && view.sending ? (
            <View style={styles.track}>
              <View style={[styles.fill, {width: `${Math.floor((view.sending.have * 100) / view.sending.want)}%`}]} />
            </View>
          ) : null}

          <Text style={styles.head}>From them</Text>
          {/* promise their keys only while a link can still bring them */}
          {!received && view.link === 'open' && !view.receiving ? <Text style={styles.dim}>Waiting for their keys…</Text> : null}
          {/* a large card on its way: how much is in (swapLink reportProgress, 10% steps) */}
          {!received && view.receiving ? (
            <>
              <Text style={styles.dim}>{`Receiving their keys… ${Math.floor((view.receiving.have * 100) / view.receiving.want)}%`}</Text>
              <View style={styles.track}>
                <View style={[styles.fill, {width: `${Math.floor((view.receiving.have * 100) / view.receiving.want)}%`}]} />
              </View>
            </>
          ) : null}
          {!received && view.link === 'left' ? <Text style={styles.dim}>They closed the swap before their keys came.</Text> : null}
          {!received && (view.link === 'dropped' || view.link === 'done') ? <Text style={styles.dim}>Their keys did not come before the link ended - swap again to get them.</Text> : null}
          {received && !arrived ? <Text style={styles.dim}>Reading their keys…</Text> : null}
          {arrived ? (
            <>
              {arrived.map(f => (
                <View key={`${f.format}:${f.fingerprint}`} style={styles.key}>
                  <Text style={styles.line}>{f.label || f.format}</Text>
                  <Text style={styles.mono}>{f.format}  ·  {f.fingerprint}</Text>
                </View>
              ))}
              {!arrived.length ? <Text style={styles.dim}>They sent no keys this app can read.</Text> : null}
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
                  {gb.contacts.length ? <Btn title="Add to an existing contact" onPress={() => setChoosing(true)} /> : null}
                </>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      {phase === 'swap' && view.step === 'failed' ? <Text style={styles.warn}>{view.message}</Text> : null}

      <Btn title={saved || view.step === 'failed' ? 'Done' : 'Close - keep nothing'} onPress={onClose} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  line: {color: theme.text, fontSize: 14, lineHeight: 20, marginBottom: 8},
  dim: {color: theme.textSecondary, fontSize: 13, lineHeight: 19, marginBottom: 8},
  head: {color: theme.text, fontSize: 15, fontWeight: '600', marginTop: 12, marginBottom: 6},
  ok: {color: theme.ok, fontSize: 14, lineHeight: 20, marginBottom: 8},
  warn: {color: theme.warn, fontSize: 14, lineHeight: 20, marginBottom: 8},
  mono: {color: theme.textSecondary, fontFamily: 'monospace', fontSize: 11},
  key: {paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border},
  qrBox: {alignSelf: 'stretch', marginVertical: 8},
  track: {height: 6, borderRadius: 3, backgroundColor: theme.inputBg, overflow: 'hidden', marginBottom: 8},
  fill: {height: '100%', borderRadius: 3, backgroundColor: theme.accentHover},
  qrImage: {alignSelf: 'stretch', aspectRatio: 1, backgroundColor: '#fff'},
  qrBar: {marginTop: 0, height: 8, borderRadius: 0},
  input: {color: theme.text, fontSize: 15, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 8, backgroundColor: theme.inputBg, borderRadius: 8, borderWidth: 1, borderColor: theme.border},
});
