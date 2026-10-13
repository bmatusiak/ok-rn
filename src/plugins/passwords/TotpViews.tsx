import React, {useEffect, useState} from 'react';
import {NativeModules, StyleSheet, Text, View} from 'react-native';

import {totp as totpLib} from 'node-onlykey-lib/passwords';
import {useSharedBtKeyboard} from '../../hooks/BtKeyboardContext';
import {Btn, Section} from '../../ui/components';
import {theme} from '../../ui/theme';
import {CountdownBar, useQuietMotion} from '../../ui/CountdownBar';

export {useQuietMotion};
/* the code's time left, as a bar: the shared countdown (src/ui/CountdownBar.tsx) */
export const TotpProgress = CountdownBar;

/*
 * AN AUTHENTICATOR CODE (Brad, 2026-10-11: "we can do authenticator topt for github in
 * passwords"): the code for now, from the entry's sealed setup key (lib passwords/src/totp.js,
 * RFC 6238), with the seconds it has left. Copy goes through the app's clipboard (cleared after
 * 45 s - longer than a code lives); Type sends it over Bluetooth like a password.
 */

type Act = (fn: () => void | Promise<void>) => void;


/* the clock a code view redraws on: every second, or on 5-second marks in testing mode */
function useCodeClock(): number {
  const quiet = useQuietMotion();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const step = quiet ? 5000 : 1000;
    const t = setTimeout(() => setNow(Date.now()), step - (Date.now() % step) + 20);
    return () => clearTimeout(t);
  }, [now, quiet]);
  return now;
}


/** "123456" -> "123 456"; Steam's 5 characters stay as they are */
const grouped = (code: string) => (/^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : /^\d{8}$/.test(code) ? `${code.slice(0, 4)} ${code.slice(4)}` : code);

/*
 * THE CLOCK (spec "Using a code": "The screen shows a warning if the phone's time is not set
 * automatically, since a skewed clock is the usual reason a code is refused"). Android's own
 * setting, read by the autofill module (AutofillModule.kt isAutoTime, the plugin's Android piece);
 * a build without that module shows nothing rather than guess.
 */
export function ClockWarning() {
  const [auto, setAuto] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    const m = NativeModules.OkAutofill;
    m?.isAutoTime?.().then((v: boolean) => live && setAuto(v)).catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (auto !== false) return null;
  return (
    <Text style={[styles.dim, {color: theme.warn}]}>
      This phone's time is not set automatically, so codes may be refused. Settings › System › Date & time › Set time automatically.
    </Text>
  );
}

/*
 * THE CODE BEFORE SAVING (spec "Adding an account", step 3: "Before saving, the screen shows the
 * current code so it can be compared with the site's confirmation step"). Time-based and Steam
 * only: a counter-based code is used once, and the entry's Next code would show this same first
 * code again - so it shows after saving, through Next code.
 */
export function TotpPreview({totp}: {totp: any}) {
  const now = useCodeClock();
  if (!totp) return null;
  if (totp.type === 'hotp') {
    return <Text style={styles.dim}>A counter code: its first code (#{totp.counter ?? 0}) shows after saving, with Next code - each code is shown once.</Text>;
  }
  const r = totpLib.codeOf(totp, now);
  return (
    <View>
      <Text style={styles.dim}>The code now - compare it with the site's confirmation step:</Text>
      <Text style={styles.code}>{grouped(r.code)}</Text>
      <TotpProgress period={totp.period ?? 30} />
      <Text style={[styles.dim, r.remaining! <= 5 && {color: theme.warn}]}>{r.remaining} s left</Text>
      <ClockWarning />
    </View>
  );
}

/*
 * A CODE IN THE LIST (spec UI: "Show TOTP" from the list; "A code and a countdown ring on the
 * entry and in the list row; the next code is shown in the last 5 seconds"). A counter code shows
 * none - each is used once, through the entry's Next code.
 */
export function TotpRowCode({totp, title, subtitle}: {totp: any; title: string; subtitle?: string}) {
  /*
   * Redrawn only when its text changes - the next code appears 5 s before the window ends, and the
   * code turns over at the end - not every second: a list that repaints all the time never goes
   * idle for the UI tooling (see TotpProgress).
   */
  const [now, setNow] = useState(Date.now());
  const period = totp?.period ?? 30;
  useEffect(() => {
    if (totp?.type === 'hotp') return;
    const left = period - ((now / 1000) % period);
    const wait = left > 5 ? (left - 5) * 1000 : left * 1000 + 20;
    const t = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(t);
  }, [now, period, totp?.type]);
  let code: string | null = null;
  let next: string | null = null;
  let left = 0;
  try {
    if (totp?.type !== 'hotp') {
      const r = totpLib.codeOf(totp, now);
      code = r.code;
      left = r.remaining ?? 0;
      if (left <= 5) next = totpLib.codeOf(totp, now + left * 1000).code;
    }
  } catch {
    code = null;
  }
  return (
    <View>
      <View style={styles.rowLine}>
        <View style={{flex: 1}}>
          <Text style={styles.rowTitle}>{title}</Text>
          {subtitle ? <Text style={styles.dim}>{subtitle}</Text> : null}
        </View>
        {code ? (
          <View style={{alignItems: 'flex-end'}}>
            <Text style={styles.rowCode}>{grouped(code)}</Text>
            {/*
              * Always there, only its text changes. Adding it at 5 s left inserted a child into a
              * row the list had detached (FlatList clips off-screen rows on Android): Fabric threw
              * "addViewAt: failed to insert view ... index=1 count=0", React tore itself down, and
              * a native callback then crashed the app (Pixel, 2026-10-12).
              */}
            <Text style={[styles.dim, {color: theme.warn}]}>{next ? `next ${grouped(next)}` : ''}</Text>
          </View>
        ) : (
          <Text style={styles.dim}>{totp?.type === 'hotp' ? 'counter' : ''}</Text>
        )}
      </View>
      {code ? <TotpProgress period={totp.period ?? 30} /> : null}
    </View>
  );
}

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
  const now = useCodeClock();
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
              <ClockWarning />
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
  rowLine: {flexDirection: 'row', alignItems: 'center', gap: 8},
  rowTitle: {color: theme.text, fontSize: 16},
  rowCode: {color: theme.text, fontSize: 20, fontFamily: theme.mono, letterSpacing: 1},
});
