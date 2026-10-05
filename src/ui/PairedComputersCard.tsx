/*
 * PART T, T4: "Paired computers" in the Bluetooth tab (Brad, 2026-10-04:
 * "approved CLI devices get listed in the Bluetooth tab - that is where the
 * Bluetooth communication toggles are").
 *
 * It sits under the API switch because pairing gates exactly that: the vendor
 * (API) link onlykey-js --ble and Edge requests use. WebAuthn and the keyboard
 * do not pass through it.
 *
 * What it shows, from src/btTransit.ts:
 *   - a status line: Encrypted, or in testing mode with the switch on,
 *     "Transit OFF (testing)" in red;
 *   - anything the person must hear about, in red: a copied pairing (the
 *     alarm), a pairing revoked for a new name or Bluetooth address, one that
 *     expired;
 *   - the paired computers: name, the code shown at pairing, last used, On/Off,
 *     Revoke;
 *   - "Pair a computer": opens the window (about two minutes), shows the
 *     6-digit code, Pair, then a confirm.
 *
 * UI is Brad's call: screenshots before this is committed.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {Alert, StyleSheet, Switch, Text, View} from 'react-native';
import {Btn, Section} from './components';
import {theme} from './theme';
import {btTransit, NOTICE_TEXT, type BtTransit, type Notice, type PairedComputer, type PairingView} from '../btTransit';

function ago(ms: number | null, now: number): string {
  if (!ms) return 'never used';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'used just now';
  if (s < 3600) return `used ${Math.round(s / 60)} min ago`;
  if (s < 86400) return `used ${Math.round(s / 3600)} h ago`;
  return `used ${Math.round(s / 86400)} d ago`;
}

export function PairedComputersCard({testing = false, gate = btTransit}: {testing?: boolean; gate?: BtTransit}) {
  const [list, setList] = useState<PairedComputer[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [pairing, setPairing] = useState<PairingView>({stage: 'closed'});
  const [transitOff, setTransitOff] = useState(false);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    setList(await gate.list());
    setNotices(await gate.notices());
    setPairing(gate.pairing());
    setTransitOff(gate.transitOff());
  }, [gate]);

  useEffect(() => {
    void refresh();
    return gate.subscribe(() => void refresh());
  }, [gate, refresh]);

  /*
   * THE PAIRING WINDOW LIVES ONLY WHILE THIS CARD IS ON SCREEN (Brad, 2026-10-05).
   * When the card goes away - our Bluetooth switched off hides it, or another tab
   * - an open window would keep answering pairing requests with nobody looking.
   */
  useEffect(() => () => gate.closePairWindow(), [gate]);

  /* the countdown while the window is open */
  const open = pairing.stage === 'waiting' || pairing.stage === 'code' || pairing.stage === 'approved';
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => {
      setNow(Date.now());
      setPairing(gate.pairing());
    }, 1000);
    return () => clearInterval(t);
  }, [open, gate]);

  const left = 'until' in pairing ? Math.max(0, Math.ceil((pairing.until - now) / 1000)) : 0;
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;

  const approve = (name: string) =>
    Alert.alert(
      `Pair ${name}?`,
      `${name} will be able to talk to the key over Bluetooth, encrypted. Every use of the key still needs your approval or a press.`,
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Pair', onPress: () => gate.approvePairing()},
      ],
    );

  const revoke = (c: PairedComputer) =>
    Alert.alert(`Revoke ${c.name}?`, 'It gets no answer from this phone until it is paired again.', [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Revoke', style: 'destructive', onPress: () => void gate.revoke(c.id)},
    ]);

  return (
    <Section title="Paired computers">
      {transitOff ? (
        <Text style={styles.off}>Transit OFF (testing) - plaintext from any computer is answered</Text>
      ) : (
        <Text style={styles.on}>Encrypted - only the computers below get an answer</Text>
      )}

      {notices.map(n => (
        <Text key={`${n.kind}-${n.id}-${n.at}`} style={styles.alarm}>
          {NOTICE_TEXT[n.kind](n.name)}
        </Text>
      ))}
      {notices.length ? <Btn title="Clear these" onPress={() => void gate.clearNotices()} /> : null}

      {list.length === 0 ? (
        <Text style={styles.note}>No computer is paired. Software on a computer gets no answer until it is.</Text>
      ) : (
        list.map(c => (
          <View key={c.id} style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.name}>{c.name}</Text>
              <Text style={styles.sub}>
                code {c.code} · {ago(c.lastUsed, now)} · {c.on ? 'on' : 'off - no answer'}
              </Text>
            </View>
            <Switch value={c.on} onValueChange={on => void gate.setOn(c.id, on)} />
            <Btn title="Revoke" tone="danger" onPress={() => revoke(c)} />
          </View>
        ))
      )}

      {/* testing mode only (T6): make the next connection renew without waiting six days */}
      {testing
        ? list.map(c => (
            <Btn
              key={`age-${c.id}`}
              title={`Test: make ${c.name}'s renewal due`}
              onPress={() => void gate.ageForTest(c.id, 6 * 24 * 60 * 60 * 1000 + 60_000)}
            />
          ))
        : null}

      {pairing.stage === 'closed' || pairing.stage === 'paired' || pairing.stage === 'failed' ? (
        <>
          {/* only while that pairing still exists: a revoke or an alarm right after must not leave it saying "paired" */}
          {pairing.stage === 'paired' && list.some(c => c.name === pairing.name) ? (
            <Text style={styles.on}>{pairing.name} is paired.</Text>
          ) : null}
          {pairing.stage === 'failed' ? <Text style={styles.error}>Not paired: {pairing.reason}.</Text> : null}
          <Btn title="Pair a computer" tone="primary" onPress={() => gate.openPairWindow()} />
        </>
      ) : (
        <View style={styles.panel}>
          {pairing.stage === 'waiting' ? (
            <>
              <Text style={styles.strong}>Waiting for the computer ({clock})</Text>
              <Text style={styles.step}>1.  Make it the Target above, with API on.</Text>
              <Text style={styles.step}>
                2.  On it, run <Text style={styles.mono}>onlykey-js --ble pair</Text>
              </Text>
            </>
          ) : null}
          {pairing.stage === 'code' ? (
            <>
              <Text style={styles.strong}>{pairing.name} shows a code ({clock})</Text>
              <Text style={styles.code}>{pairing.code}</Text>
              <Text style={styles.note}>Pair only if the computer shows the same six digits.</Text>
              <Btn title="Pair" tone="primary" onPress={() => approve(pairing.name)} />
            </>
          ) : null}
          {pairing.stage === 'approved' ? (
            <Text style={styles.strong}>Waiting for {pairing.name} to confirm… ({clock})</Text>
          ) : null}
          <Btn title="Cancel" onPress={() => gate.closePairWindow()} />
        </View>
      )}

      {testing ? (
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={transitOff ? styles.offLabel : styles.name}>Transit off (testing only)</Text>
            <Text style={styles.sub}>Answer plaintext from the target. Never in a release build.</Text>
          </View>
          <Switch value={transitOff} onValueChange={v => void gate.setTransitOff(v)} />
        </View>
      ) : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  on: {color: theme.ok, fontSize: 13, marginBottom: 6},
  off: {color: theme.error, fontSize: 13, fontWeight: '600', marginBottom: 6},
  offLabel: {color: theme.error, fontSize: 14, fontWeight: '600'},
  alarm: {color: theme.error, fontSize: 13, lineHeight: 18, marginVertical: 4},
  note: {color: theme.textDim, fontSize: 12, lineHeight: 17, marginVertical: 4},
  error: {color: theme.error, fontSize: 12, lineHeight: 17, marginVertical: 4},
  row: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8},
  rowText: {flex: 1},
  name: {color: theme.text, fontSize: 14},
  sub: {color: theme.textDim, fontSize: 11},
  panel: {gap: 6, paddingVertical: 6},
  strong: {color: theme.text, fontSize: 14, fontWeight: '600'},
  step: {color: theme.textDim, fontSize: 14, lineHeight: 20, paddingLeft: 4},
  mono: {fontFamily: theme.mono, color: theme.textSecondary},
  code: {color: theme.text, fontSize: 36, fontFamily: theme.mono, letterSpacing: 6, textAlign: 'center', marginVertical: 8},
});
