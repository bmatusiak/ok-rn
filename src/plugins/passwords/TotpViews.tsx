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

/* a code the OnlyKey's own TOTP slots can hold: Google Authenticator's kind */
export const slotReady = (t: any) =>
  !!t && (t.type ?? 'totp') === 'totp' && (t.algo ?? 'SHA1') === 'SHA1' && (t.digits ?? 6) === 6 && (t.period ?? 30) === 30 && !t.encoder;

export function TotpCode({
  totp,
  act,
  copy,
  title = 'Authenticator code',
  onCounter,
  onToSlot,
}: {
  totp: any;
  act: Act;
  copy: (text: string, what: string) => Promise<void>;
  title?: string;
  /*
   * HOTP: saves the raised counter. The spec's order: the counter moves forward and is saved
   * BEFORE the code is shown, so a code is never shown twice. Absent (an entry sealed again):
   * the counter cannot be stepped from here.
   */
  onCounter?: (next: number) => Promise<void>;
  /* "Put on a key slot", for a code the key's own TOTP slots can hold */
  onToSlot?: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const bt = useSharedBtKeyboard();
  const canType = bt.state === 'connected' && bt.forwarding;
  const hotp = totp?.type === 'hotp';
  /* HOTP: the code shown after Next code / a Resync pick, and the next few for Resync */
  const [shown, setShown] = useState<{code: string; counter: number} | null>(null);
  const [resync, setResync] = useState(false);

  let r: {code: string; remaining: number | null} | null = null;
  let error: string | null = null;
  try {
    r = hotp ? (shown ? {code: shown.code, remaining: null} : null) : totpLib.codeOf(totp, now);
  } catch (e: any) {
    error = String(e?.message ?? e).replace(/^passwords: /, '');
  }

  const counter = totp?.counter ?? 0;
  /* use counter n: save n + 1 first, then show n's code */
  const take = (n: number) =>
    act(async () => {
      await onCounter!(n + 1);
      setShown({code: totpLib.codeOf({...totp, counter: n}).code, counter: n});
      setResync(false);
    });

  return (
    <Section title={title}>
      {error ? <Text style={[styles.body, {color: theme.error}]}>{error}</Text> : null}
      {hotp && !shown ? (
        <Text style={styles.dim}>A counter code: the next one is #{counter}. Each code is used once.</Text>
      ) : null}
      {r ? (
        <>
          <Text style={styles.code}>{grouped(r.code)}</Text>
          {r.remaining !== null ? (
            <>
              <TotpProgress period={totp.period ?? 30} />
              <Text style={[styles.dim, r.remaining <= 5 && {color: theme.warn}]}>{r.remaining} s left</Text>
            </>
          ) : (
            <Text style={styles.dim}>code #{shown?.counter}</Text>
          )}
          <View style={styles.buttons}>
            <Btn title="Copy code" tone="primary" onPress={() => act(() => copy(r!.code, 'Code'))} />
            {canType ? <Btn title="Type code" onPress={() => act(() => bt.typeSecret(r!.code, {then: null}))} /> : null}
          </View>
        </>
      ) : null}
      {hotp ? (
        onCounter ? (
          <>
            <View style={styles.buttons}>
              <Btn title="Next code" tone={shown ? 'default' : 'primary'} onPress={() => take(counter)} />
              <Btn title={resync ? 'Resync ▲' : 'Resync ▼'} onPress={() => setResync(x => !x)} />
            </View>
            {resync ? (
              <>
                <Text style={styles.dim}>Out of step? The server wants one of these - pick it, and the counter jumps past it.</Text>
                {[0, 1, 2, 3, 4].map(i => (
                  <View key={i} style={styles.buttons}>
                    <Btn title={`#${counter + i}  ${grouped(totpLib.codeOf({...totp, counter: counter + i}).code)}`} onPress={() => take(counter + i)} />
                  </View>
                ))}
              </>
            ) : null}
          </>
        ) : (
          <Text style={styles.dim}>Sealed again with its own key: edit it to step the counter.</Text>
        )
      ) : null}
      {onToSlot && slotReady(totp) ? (
        <View style={styles.buttons}>
          <Btn title="Put on a key slot" onPress={onToSlot} />
        </View>
      ) : null}
      {totp?.issuer ? <Text style={styles.dim}>{totp.issuer}</Text> : null}
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
