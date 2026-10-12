import React, {useEffect, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';

import {totp as totpLib} from 'node-onlykey-lib/passwords';
import {useSharedBtKeyboard} from '../../hooks/BtKeyboardContext';
import {Btn, Section} from '../../ui/components';
import {theme} from '../../ui/theme';

/*
 * AN AUTHENTICATOR CODE (Brad, 2026-10-11: "we can do authenticator topt for github in
 * passwords"): the code for now, from the entry's sealed setup key (lib passwords/src/totp.js,
 * RFC 6238), with the seconds it has left. Copy goes through the app's clipboard (cleared after
 * 45 s - longer than a code lives); Type sends it over Bluetooth like a password.
 */

type Act = (fn: () => void | Promise<void>) => void;

/*
 * THE TIME LEFT, as a bar (Brad, 2026-10-11: "i want to add a progress bar"): full when a code
 * starts, empty when it changes; yellow in its last 5 s. Its own clock, so a screen can drop it in
 * anywhere - the picker has one at its top for every code it lists (they share the 30 s window).
 */
export function TotpProgress({period = 30}: {period?: number}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const left = period - ((now / 1000) % period);
  return (
    <View style={styles.track}>
      <View style={[styles.fill, {width: `${(left / period) * 100}%`, backgroundColor: left <= 5 ? theme.warn : theme.ok}]} />
    </View>
  );
}

/** "123456" -> "123 456"; Steam's 5 characters stay as they are */
const grouped = (code: string) => (/^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : /^\d{8}$/.test(code) ? `${code.slice(0, 4)} ${code.slice(4)}` : code);

export function TotpCode({
  totp,
  act,
  copy,
  title = 'Authenticator code',
}: {
  totp: any;
  act: Act;
  copy: (text: string, what: string) => Promise<void>;
  title?: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const bt = useSharedBtKeyboard();
  const canType = bt.state === 'connected' && bt.forwarding;

  let r: {code: string; remaining: number | null} | null = null;
  let error: string | null = null;
  try {
    r = totpLib.codeOf(totp, now);
  } catch (e: any) {
    error = String(e?.message ?? e).replace(/^passwords: /, '');
  }

  return (
    <Section title={title}>
      {error ? <Text style={[styles.body, {color: theme.error}]}>{error}</Text> : null}
      {r ? (
        <>
          <Text style={styles.code}>{grouped(r.code)}</Text>
          {r.remaining !== null ? (
            <>
              <TotpProgress period={totp.period ?? 30} />
              <Text style={[styles.dim, r.remaining <= 5 && {color: theme.warn}]}>{r.remaining} s left</Text>
            </>
          ) : (
            <Text style={styles.dim}>counter {totp.counter ?? 0}</Text>
          )}
          <View style={styles.buttons}>
            <Btn title="Copy code" tone="primary" onPress={() => act(() => copy(r!.code, 'Code'))} />
            {canType ? <Btn title="Type code" onPress={() => act(() => bt.typeSecret(r!.code, {then: null}))} /> : null}
          </View>
          {totp.issuer ? <Text style={styles.dim}>{totp.issuer}</Text> : null}
        </>
      ) : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  body: {color: theme.text, fontSize: 14, lineHeight: 20},
  code: {color: theme.text, fontSize: 34, fontFamily: theme.mono, letterSpacing: 2, marginTop: 4},
  dim: {color: theme.textDim, fontSize: 12, marginTop: 2},
  buttons: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  track: {height: 4, borderRadius: 2, backgroundColor: theme.inputBg, overflow: 'hidden', marginTop: 8},
  fill: {height: 4, borderRadius: 2},
});
