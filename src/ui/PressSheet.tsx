/**
 * THE PRESS SHEET: every press is asked HERE, and nowhere else (Brad, 2026-10-10: "the confirm
 * button ... needs to be removed, so the sheet is the notifier with press button"; "blind
 * presses is a blocker, without it, it voids all security").
 *
 * Two kinds of press, each with what it is for (src/pressAsk.ts):
 *   - a VENDOR press (ssh, gpg, decrypt, an Edge approval): what the FIRMWARE says it was handed
 *     ("the firmware is the thing that is signing") - the operation, the key, the identity named
 *     from the Key Chain by the label the firmware holds, the message's fingerprint. Nothing from
 *     the computer that asks: "the confirm sheet should only get the data from firmware, the cli
 *     should not be aware that we are checking the press" (Brad, 2026-10-10).
 *   - a WEBAUTHN press (a passkey): the site, and on a register the user, from the request.
 *
 * An agent's budget keeps its own sheet (EdgeRequestSheet), which asks for its press itself;
 * this one stays out of the way while that one is up.
 *
 * A CODE IS NEVER SHOWN. The 3 digits come from the computer that asked; a phone that displayed
 * them would let a bad request supply its own code and the person just copy it in. So code mode
 * says where the code is, and the keypad is on the sheet.
 */
import React, {useEffect, useRef, useState} from 'react';
import {Modal, PixelRatio, ScrollView, StyleSheet, Text, View} from 'react-native';
import OkEmu, {type KeyWaiting} from '../transport/OkEmu';
import NativeOkEmu from '../../specs/NativeOkEmu';
import {describeWaiting} from '../hooks/useKeyWaiting';
import {onSheet, type SheetState} from '../edgeAgents';
import {
  fidoAskNow, firmwarePressFor, latestPressAt, nameOfLabel, onPressAsk, startPressRecords,
  type FidoAsk, type FirmwarePress,
} from '../pressAsk';
import {consentRefusal} from '../debugGuard';
import {currentNet} from '../net';
import {Btn} from './components';
import {theme} from './theme';

/* the core firmware closes every wait at 20 s (okcore.cpp Usertimeout) */
const WAIT_MS = 20_000;
const OKSIGN = 0xed;
const OKDECRYPT = 0xf0;

const sameWait = (a: KeyWaiting | null, b: KeyWaiting | null) =>
  a !== null && b !== null && a.what === b.what && a.opcode === b.opcode && a.slot === b.slot;

const keyName = (slot: number) =>
  slot >= 1 && slot <= 4 ? `RSA slot ${slot}` :
  slot >= 101 && slot <= 116 ? `ECC slot ${slot - 100}` :
  (slot >= 201 && slot <= 203) || (slot >= 221 && slot <= 223) ? `a derived key (code ${slot})` : `slot ${slot}`;
const opName = (opcode: number, what: string) => (opcode === OKSIGN ? 'Sign' : opcode === OKDECRYPT ? 'Decrypt' : what === 'hmac' ? 'HMAC' : 'Use');
/* the same format the CLI prints beside its prompt (lib protocol/challenge.js), so the two read side by side */
const {challenge: {subjectFingerprint: fingerprint}} = require('node-onlykey-lib/protocol');

/* the Key Chain's answer for the firmware's label */
type Who = {label: string; listed: boolean; name: string | null};
type Fido = {needed: boolean; canPress: boolean; confirm: () => void};

export function PressSheet({waiting, fido}: {waiting: KeyWaiting | null; fido: Fido}) {
  useEffect(() => startPressRecords(), []);
  /* the Edge request sheet asks for its own press: this one waits while that one is up */
  const [edge, setEdge] = useState<SheetState | null>(null);
  useEffect(() => onSheet(setEdge), []);
  const edgeAsking = edge !== null && edge.phase !== 'done';
  /* a firmware record or a FIDO request can land a moment after the wait is seen: redraw on each */
  const [tick, setTick] = useState(0);
  useEffect(() => onPressAsk(() => setTick(t => t + 1)), []);

  /*
   * One wait = one sheet, and its start (the countdown). Two signs in a row on the same slot (a
   * certificate's two signatures) can look like ONE wait to a 400 ms poll that never sees the gap
   * between them - the second sheet then showed "Pressed" with no button. The firmware hands over
   * a record with every sign, so a new record while waiting is a new wait.
   */
  const [wait, setWait] = useState<{w: KeyWaiting; since: number} | null>(null);
  const last = useRef<KeyWaiting | null>(null);
  const lastRecord = useRef(0);
  useEffect(() => {
    const record = latestPressAt();
    if (!waiting) {
      last.current = null;
      lastRecord.current = record;
      setWait(null);
      return;
    }
    const fresh = record > lastRecord.current;
    if (sameWait(last.current, waiting) && !fresh) {
      setWait(prev => (prev ? {...prev, w: waiting} : prev)); /* the code's progress, same wait */
      return;
    }
    last.current = waiting;
    lastRecord.current = record;
    setWait({w: waiting, since: Date.now()});
  }, [waiting, tick]);
  const [fidoSince, setFidoSince] = useState(0);
  useEffect(() => { setFidoSince(fido.needed ? Date.now() : 0); }, [fido.needed]);

  const fw: FirmwarePress | null = wait ? firmwarePressFor(wait.w, wait.since) : null;
  /* the identity the firmware holds, looked up in the Key Chain (undefined below: still looking) */
  const [named, setNamed] = useState<{label: string; listed: boolean; name: string | null} | null>(null);
  useEffect(() => {
    if (!fw?.label) return;
    let alive = true;
    void nameOfLabel(fw.label).then(r => { if (alive) setNamed({label: fw.label!, ...r}); });
    return () => { alive = false; };
  }, [fw?.label]);

  const since = fido.needed ? fidoSince : wait?.since ?? 0;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);

  /* no double taps: the buttons wake 1 s after the sheet appears, and one tap is all (EdgeRequestSheet) */
  const [ready, setReady] = useState(false);
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    setReady(false);
    setPressed(false);
    const t = setTimeout(() => setReady(true), 1000);
    return () => clearTimeout(t);
  }, [since]);

  const showFido = fido.needed;
  const showVendor = !showFido && !!wait && !(wait.w.what === 'edge' && edgeAsking);
  if (!showFido && !showVendor) return null;
  const left = Math.max(0, Math.ceil((since + WAIT_MS - now) / 1000));
  const hush = () => { try { NativeOkEmu.hushPress(); } catch { /* no native side (jest, an old build) */ } };

  return (
    <Modal transparent animationType="slide" visible onRequestClose={() => undefined}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={styles.body}>
            {currentNet() === 'test' ? <Text style={[styles.title, {color: theme.io}]}>TESTNET</Text> : null}
            {showFido ? (
              <FidoBody ask={fidoAskNow()} />
            ) : (
              <VendorBody w={wait!.w} fw={fw} named={fw?.label && named?.label === fw.label ? named : undefined} />
            )}

            {pressed ? (
              <Text style={[styles.op, {color: theme.warn}]}>Pressed - the key is answering…</Text>
            ) : (
              <Text style={[styles.countdown, left <= 10 && {color: theme.error}]}>
                {`${!showFido && wait!.w.mode === 'code' ? 'Enter the code' : 'Press'} within 0:${String(left).padStart(2, '0')}`}
              </Text>
            )}

            {showFido ? (
              fido.canPress ? (
                !pressed ? (
                  <View style={styles.row}>
                    <Locate what={`passkey ${fidoAskNow()?.command ?? '?'} ${fidoAskNow()?.rpId ?? '?'}`}>
                      <Btn large title="Press the soft key" tone="primary" disabled={!ready} onPress={() => { if (!ready || pressed) return; hush(); setPressed(true); fido.confirm(); }} />
                    </Locate>
                  </View>
                ) : null
              ) : (
                <Text style={styles.op}>Press any button on the key itself.</Text>
              )
            ) : (
              <VendorButtons w={wait!.w} what={vendorWhat(wait!.w, fw, fw?.label && named?.label === fw.label ? named : undefined)} ready={ready} pressed={pressed} onPress={(button: string) => {
                const w = wait!.w;
                if (!ready || (w.mode === 'press' && pressed) || (w.what === 'edge' && consentRefusal())) return;
                hush();
                if (w.mode === 'press') setPressed(true);
                void OkEmu.pressQueue(button);
              }} />
            )}
            <Text style={styles.dim}>This phone is also the key, so its press proves less than a hard key's.</Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/*
 * WHERE THE BUTTON IS, said by the phone (debug builds only; Brad, 2026-10-10: "this is why i
 * want the sheet, to keep us from being blind"). A script driving the phone over adb waits for
 * this line - the sheet is up, these are its words, the button is HERE in screen pixels - and
 * taps there, instead of tapping where a button used to be on whatever screen is showing.
 */
export function Locate({what, children}: {what: string; children: React.ReactNode}) {
  const ref = useRef<any>(null);
  return (
    <View ref={ref} collapsable={false} onLayout={() => {
      if (!__DEV__) return;
      /* measured once the sheet has slid in and settled: at its first layout the Edge sheet's Approve read ~195 px high */
      setTimeout(() => ref.current?.measureInWindow((x: number, y: number, w: number, h: number) => {
        const r = PixelRatio.get();
        console.log(`[press] sheet up: ${what} - button at ${Math.round((x + w / 2) * r)},${Math.round((y + h / 2) * r)}`);
      }), 800);
    }}>
      {children}
    </View>
  );
}

function FidoBody({ask}: {ask: FidoAsk | null}) {
  const register = ask?.command === 'makeCredential';
  return (
    <>
      <Text style={[styles.title, {color: theme.warn}]}>{register ? 'Register a passkey' : 'Sign in with a passkey'}</Text>
      <View style={styles.reason}>
        <Text style={styles.op}>{ask?.rpId ? ask.rpId : 'A site (it did not say which)'}</Text>
        {register && ask?.user ? <Text style={styles.dim}>{`as ${ask.user}`}</Text> : null}
      </View>
      <Text style={styles.dim}>The site named in the request the key is answering. If it is not where you are signing in, let it run out.</Text>
    </>
  );
}

function VendorBody({w, fw, named}: {w: KeyWaiting; fw: FirmwarePress | null; named: Who | undefined}) {
  return (
    <>
      <Text style={[styles.title, {color: theme.warn}]}>A press is needed</Text>
      {fw ? (
        <View style={styles.scope}>
          <Text style={styles.dim}>The key was asked to</Text>
          <Text style={styles.op}>
            {`${opName(fw.opcode, w.what)} with ${fw.label ? (named === undefined ? '…' : named.name ?? (named.listed ? 'an unnamed identity in your Key Chain' : 'an identity not in your Key Chain')) : keyName(fw.slot)}`}
          </Text>
          {fw.label && named && !named.listed ? <Text style={[styles.dim, {color: theme.error}]}>{`identity ${fingerprint(fw.label)} - nobody listed it. If you did not ask for it, let it run out.`}</Text> : null}
          <Text style={styles.dim}>{`${keyName(fw.slot)} · message ${fingerprint(fw.subject)}`}</Text>
        </View>
      ) : (
        <View style={styles.reason}>
          <Text style={styles.op}>{describeWaiting(w)}</Text>
        </View>
      )}
    </>
  );
}

/* the facts the sheet shows, in one line for the debug log */
function vendorWhat(w: KeyWaiting, fw: FirmwarePress | null, named: Who | undefined): string {
  const who = fw ? (fw.label ? named === undefined ? 'naming…' : named.name ?? `${named.listed ? 'unnamed' : 'unlisted'} ${fw.label.slice(0, 8)}` : keyName(fw.slot)) : 'no firmware record';
  return `${w.what} slot ${w.slot} ${who}`;
}

function VendorButtons({w, what, ready, pressed, onPress}: {w: KeyWaiting; what: string; ready: boolean; pressed: boolean; onPress: (b: string) => void}) {
  /* spec rule 10, the app's lock: an Edge approval is not pressed here while debugging is on (debugGuard) */
  const refusal = w.what === 'edge' ? consentRefusal() : null;
  return (
    <>
      {refusal ? <Text style={[styles.op, {color: theme.error}]}>{refusal}</Text> : null}
      {w.mode === 'press' && !pressed ? (
        <View style={styles.row}>
          <Locate what={what}>
            <Btn large title="Press the soft key" tone="primary" disabled={!ready || refusal !== null} onPress={() => onPress('1')} />
          </Locate>
        </View>
      ) : null}
      {w.mode !== 'press' ? (
        <>
          <Text style={styles.dim}>
            {w.mode === 'code' ? `Enter the code the computer shows (${w.entered} of 3 in).` : 'Press a button, or enter the code the computer shows.'}
          </Text>
          <View style={styles.keypad}>
            {['1', '2', '3', '4', '5', '6'].map(b => (
              <Btn key={b} large title={b} disabled={!ready || refusal !== null} onPress={() => onPress(b)} />
            ))}
          </View>
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end'},
  sheet: {
    backgroundColor: theme.surface, borderTopLeftRadius: 14, borderTopRightRadius: 14,
    borderTopWidth: 2, borderColor: theme.warn, maxHeight: '88%',
  },
  /* room under the buttons: in debug builds React Native's warning toasts sit along the bottom and catch taps */
  body: {padding: 16, paddingBottom: 64, gap: 8},
  title: {fontWeight: '600', fontSize: 17},
  op: {color: theme.text, fontSize: theme.fontSize, lineHeight: theme.lineHeight},
  dim: {color: theme.textDim, fontSize: 13, lineHeight: 19},
  reason: {backgroundColor: theme.inputBg, borderRadius: theme.radius, padding: 10, gap: 4},
  scope: {borderWidth: 1, borderColor: theme.border, borderRadius: theme.radius, padding: 8, gap: 2},
  row: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10},
  keypad: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  countdown: {color: theme.warn, fontSize: 20, fontWeight: '700', marginTop: 6},
});
