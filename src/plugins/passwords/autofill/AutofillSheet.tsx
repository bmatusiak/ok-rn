import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Alert, NativeModules, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';

import {chooseTarget, pressKeyButton, readKeyState, targetLabel, type Target} from '../../../credprovider/flow';
import {supportsKnown} from '../../../firmwareFeatures';
import {useSecureScreen} from '../../../hooks/useSecureScreen';
import {getOnlyKey} from '../../../onlykey';
import {Btn, Section} from '../../../ui/components';
import {EdgeList, type EdgeListItem} from '../../../ui/EdgeList';
import {Keypad} from '../../../ui/Keypad';
import {theme} from '../../../ui/theme';
import type {Manager, Okcrypto} from '../stores';
import {derived, mnemonic, totp as totpLib} from 'node-onlykey-lib/passwords';
import {nameDerivedDerive} from '../DerivedViews';
import {openEntry} from '../innerKeys';
import {namePhraseDerive} from '../PhraseViews';
import {stores, storesChanged, type PhraseOkcrypto} from '../usePasswordManager';
import {TotpProgress} from '../TotpViews';
import {formName, hostOf, matching, matchingCodes, type FormTarget} from './match';

/*
 * THE AUTOFILL SHEET (root OkRNAutofill, android/autofill AutofillAuthActivity): in front of the
 * browser or app whose form asked. Brad, 2026-10-11: always open OnlyKey's sheet - Chrome's row
 * carries no values, the person picks here.
 *
 *  1. the key: the hard key if one is on the bus, else the soft key (started if it was not -
 *     Chrome can wake the app cold); a locked key is unlocked here, as the passkey sheet does;
 *  2. the store: the same `stores` the Passwords tab uses (one JS runtime, the app's), so a store
 *     the tab opened is open here; else touch-free, else "Open with OnlyKey";
 *  3. the entries saved for this site (or app) - match.ts; every other entry only behind a warning
 *     naming the site, for a site saved under another address;
 *  4. a pick fills the form and closes the sheet; Cancel leaves the form as it was.
 */

type Native = {
  getPendingRequest(): Promise<
    | (Omit<FormTarget, 'certs'> & {mode: 'fill' | 'save' | 'phrase' | 'code'; username: boolean; password: boolean; savedUsername?: string; savedPassword?: string; certs?: string})
    | null
  >;
  fill(username: string | null, password: string | null): Promise<boolean>;
  done(): Promise<boolean>;
  cancel(): Promise<boolean>;
};
const OkAutofill: Native | undefined = NativeModules.OkAutofill;

type Entry = {id: string; kind: string; title: string; username?: string; password?: string; urls?: string[]; inner?: unknown; recipe?: any; totp?: any};

type Step =
  | {kind: 'starting'}
  | {kind: 'unlock'; target: Target; state: string}
  | {kind: 'button'; target: Target}
  | {kind: 'opening'; target: Target}
  | {kind: 'open'; target: Target; manager: Manager}
  | {kind: 'error'; message: string};

export default function AutofillSheet() {
  /* no screenshots of the sheet in a release build (titles, usernames; a phrase passes through it) - App's rule, BLOCK_SCREENSHOTS */
  useSecureScreen(!__DEV__);
  const [form, setForm] = useState<FormTarget | null>(null);
  /* a save: what the person typed into the form, kept here only until Save or Not now */
  const [saving, setSaving] = useState<{username: string; password: string} | null>(null);
  /* a wallet's phrase box: the words of the phrase picked here */
  const [phrase, setPhrase] = useState(false);
  /* a one-time-code box: the code of the entry picked here, as it is now */
  const [codeBox, setCodeBox] = useState(false);
  /* an entry sealed with a passphrase, waiting for it here before it fills */
  const [askPass, setAskPass] = useState<{entry: Entry; use: (open: Entry) => Promise<void>} | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [step, setStep] = useState<Step>({kind: 'starting'});
  const [showAll, setShowAll] = useState(false);
  const [digits, setDigits] = useState(0);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    OkAutofill?.cancel().catch(() => {});
  }, []);

  /* the store, once the key is unlocked */
  const openStore = useCallback(async (target: Target, withKey: boolean) => {
    const app = await getOnlyKey(target.backend);
    /* unknown means no (the tab's rule too): the key connected above, so it has said what it is */
    if (!supportsKnown(app.device.capabilities, 'deviceVault')) {
      throw new Error(`the ${targetLabel(target)} has not said it has the password vault (firmware 3.1.0 or newer)`);
    }
    const okcrypto = app.okcrypto as Okcrypto;
    setStep({kind: 'opening', target});
    const r = withKey
      ? await stores.openWithKey(target.backend, okcrypto)
      : await stores.tryOpen(target.backend, okcrypto);
    setStep(r ? {kind: 'open', target, manager: r.manager} : {kind: 'button', target});
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!OkAutofill) throw new Error('this build has no Autofill');
      const req = await OkAutofill.getPendingRequest();
      if (!req) throw new Error('there is no form waiting');
      if (!alive) return;
      setForm({domain: req.domain, packageName: req.packageName, certs: (req.certs ?? '').split(',').filter(Boolean)});
      if (req.mode === 'save') setSaving({username: req.savedUsername ?? '', password: req.savedPassword ?? ''});
      if (req.mode === 'phrase') setPhrase(true);
      if (req.mode === 'code') setCodeBox(true);
      const target = await chooseTarget();
      const state = await readKeyState(target);
      if (!alive) return;
      if (state.state !== 'unlocked') return setStep({kind: 'unlock', target, state: state.state});
      await openStore(target, false);
    })().catch(e => alive && setStep({kind: 'error', message: String(e?.message ?? e)}));
    return () => {
      alive = false;
    };
  }, [openStore]);

  /* the unlock pad: each digit goes to the key; it unlocks itself when the PIN matches */
  const onDigit = useCallback(
    async (target: Target, button: number) => {
      setDigits(n => n + 1);
      await pressKeyButton(target, button).catch(() => {});
      if (checkTimer.current) clearTimeout(checkTimer.current);
      checkTimer.current = setTimeout(async () => {
        checkTimer.current = null;
        const state = await readKeyState(target).catch(() => null);
        if (state?.state === 'unlocked') openStore(target, false).catch(e => setStep({kind: 'error', message: String(e?.message ?? e)}));
      }, 400);
    },
    [openStore],
  );

  /* the store's press flag (a sealed entry's own derive uses it too) */
  const pressOf = async (backend: Target['backend'], okcrypto: Okcrypto) =>
    (await stores.readMeta(await stores.identify(backend, okcrypto)))?.press ?? true;

  /*
   * An entry with its secrets: sealed with the key - one more press now; with a passphrase - asked
   * here first (askPass); plain - as it is.
   */
  const withSecrets = (e: Entry, use: (open: Entry) => Promise<void>) =>
    (async () => {
      if (!e.inner || step.kind !== 'open') return use(e);
      if ((e.inner as any).seal === 'entry-passphrase') return setAskPass({entry: e, use});
      const okcrypto = (await getOnlyKey(step.target.backend)).okcrypto as Okcrypto;
      return use(await openEntry(e, okcrypto as any, await pressOf(step.target.backend, okcrypto)));
    })().catch(err => setStep({kind: 'error', message: String(err?.message ?? err)}));

  const pick = (sealed: Entry) =>
    withSecrets(sealed, async e => {
      let password = e.password ?? null;
      /* a derived password: made again from the key now, checked against its recipe */
      if (e.kind === 'derived' && step.kind === 'open') {
        const okcrypto = (await getOnlyKey(step.target.backend)).okcrypto as unknown as PhraseOkcrypto;
        nameDerivedDerive(derived.nameOf(e.recipe));
        password = await derived.openRecipe({okcrypto, recipe: e.recipe});
      }
      await OkAutofill?.fill(e.username ?? null, password);
    });

  /*
   * LINK THIS APP (spec "Matching": an unknown app, the person picks an entry, the app is linked
   * with its certificate after a confirmation naming it). An app form only; a web page is matched
   * by its address, never linked.
   */
  const linkThen = (e: Entry, then: (e: Entry) => void) => {
    if (!form || form.domain || step.kind !== 'open') return then(e);
    const cert = form.certs?.[0];
    if (!cert) {
      Alert.alert('This app could not be checked', `${form.packageName}'s signing certificate could not be read, so it is not linked. Fill once anyway?`, [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Fill once', onPress: () => then(e)},
      ]);
      return;
    }
    const manager = step.manager;
    Alert.alert(
      `Use "${e.title}" with this app?`,
      `${form.packageName} (certificate ${cert.slice(0, 16)}…). OnlyKey fills it into this app from now on; another app with the same name but another certificate gets nothing.`,
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Link and fill',
          onPress: () =>
            (async () => {
              const apps = [...((e as any).androidApps ?? []), {package: form.packageName, cert}];
              await manager.put({...(manager.get(e.id) as any), androidApps: apps});
              storesChanged();
              then(e);
            })().catch(err => setStep({kind: 'error', message: String(err?.message ?? err)})),
        },
      ],
    );
  };

  const name = form ? formName(form) : '';
  let body: React.ReactNode;
  if (askPass && step.kind === 'open') {
    body = (
      <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
        <Section title={askPass.entry.title}>
          <Text style={styles.body}>Sealed with a passphrase: enter it to fill.</Text>
          <TextInput
            value={passphrase}
            onChangeText={setPassphrase}
            placeholder="Passphrase"
            placeholderTextColor={theme.textDim}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            importantForAutofill="no"
            style={styles.input}
          />
          <View style={styles.bar}>
            <Btn
              title="Open and fill"
              tone="primary"
              disabled={!passphrase}
              onPress={() =>
                (async () => {
                  const okcrypto = (await getOnlyKey(step.target.backend)).okcrypto as Okcrypto;
                  const open = await openEntry(askPass.entry, okcrypto as any, await pressOf(step.target.backend, okcrypto), passphrase);
                  setPassphrase('');
                  await askPass.use(open);
                })().catch(err => setStep({kind: 'error', message: String(err?.message ?? err)}))
              }
            />
            <Btn title="Back" onPress={() => { setPassphrase(''); setAskPass(null); }} />
          </View>
        </Section>
      </ScrollView>
    );
  } else if (step.kind === 'open' && saving && form) {
    /*
     * SAVE: the login typed into the form, into this store - an update when the site already has
     * an entry with that username, else a new login under the site's address. Nothing is kept on
     * Not now.
     */
    const all = (step.manager.list() as Entry[]).filter(e => e.kind === 'login' && !e.inner);
    const same = matching(all, form).find(e => (e.username ?? '') === saving.username);
    const unchanged = !!same && same.password === saving.password;
    const finish = () => {
      storesChanged();
      setSaving(null);
      OkAutofill?.done().catch(() => {});
    };
    const keep = () =>
      (same
        ? step.manager.put({...same, password: saving.password})
        : step.manager.put({
            kind: 'login',
            title: name,
            username: saving.username || undefined,
            password: saving.password,
            urls: [form.domain ? 'https://' + hostOf(form.domain) : 'android://' + form.packageName],
          })
      )
        .then(finish)
        .catch((e: any) => setStep({kind: 'error', message: String(e?.message ?? e)}));
    body = (
      <ScrollView contentContainerStyle={styles.pad}>
        <Section title={unchanged ? 'Already saved' : same ? `Update ${same.title}` : `Save to OnlyKey`}>
          <Text style={styles.body}>
            {unchanged
              ? `OnlyKey already has this password for ${saving.username || name}.`
              : same
                ? `Replace the saved password for ${saving.username || 'this login'} on ${name}? The old one goes to its history.`
                : `Keep ${saving.username || 'this login'} for ${name}, sealed to the ${targetLabel(step.target)}?`}
          </Text>
          <View style={styles.bar}>
            {unchanged ? null : <Btn title={same ? 'Update password' : 'Save'} tone="primary" onPress={() => void keep()} />}
            <Btn title={unchanged ? 'Close' : 'Not now'} onPress={finish} />
          </View>
        </Section>
      </ScrollView>
    );
  } else if (step.kind === 'open' && codeBox && form) {
    /*
     * A 2FA CODE BOX: the codes saved for this site (a login carrying one, or an authenticator
     * entry with the site in its Sites) - the code is computed at the pick, so it is the current one.
     */
    const all = (step.manager.list() as Entry[]).filter(e => e.totp || (e.inner && (e.kind === 'totp' || e.kind === 'login')));
    const mine = matchingCodes(all, form);
    const others = all.filter(e => !mine.includes(e));
    const fillCode = (sealed: Entry) =>
      withSecrets(sealed, async e => {
        await OkAutofill?.fill(null, totpLib.codeOf(e.totp).code);
      });
    const items: EdgeListItem[] = [{key: 's-mine', kind: 'section', title: `Codes for ${name}`, right: String(mine.length)}];
    if (!mine.length) items.push({key: 'none', kind: 'row', tone: 'dim', title: `No code saved for ${name}`, subtitle: 'Add the site to an authenticator entry (its Sites), or a setup key to its login.'});
    for (const e of mine) items.push({key: e.id, kind: 'row', title: e.title, subtitle: e.username || e.totp?.issuer, onPress: () => void fillCode(e)});
    if (showAll) {
      items.push({key: 's-all', kind: 'section', title: 'Other codes', right: String(others.length)});
      items.push({key: 'warn', kind: 'row', tone: 'warn', title: `Not saved for ${name}`, subtitle: `Fill one of these only if you know ${name} is where it belongs.`});
      for (const e of others) items.push({key: 'o-' + e.id, kind: 'row', title: e.title, subtitle: e.totp?.issuer, onPress: () => linkThen(e, x => void fillCode(x))});
    }
    /* one bar at the top for the whole list (Brad, 2026-10-11: "for autofill, we just need 1
       progress bar at the top"): the codes listed share a window - the first one's period */
    const period = (mine[0] ?? others[0])?.totp?.period ?? 30;
    body = (
      <View style={styles.root}>
        <View style={styles.progress}>
          <TotpProgress period={period} />
        </View>
        <EdgeList items={items} />
        <View style={styles.bar}>
          {!showAll && others.length ? <Btn title={`Other codes (${others.length})`} onPress={() => setShowAll(true)} /> : null}
          <Btn title="Cancel" onPress={cancel} />
        </View>
      </View>
    );
  } else if (step.kind === 'open' && phrase && form) {
    /*
     * A WALLET'S PHRASE BOX: an app asks for a recovery phrase - the classic scam is exactly this,
     * so the app's name leads. The picked phrase is made again from the key and checked against
     * its recipe (mnemonic.openRecipe) before a word leaves; a mismatch fills nothing.
     */
    const phrases = (step.manager.list() as Entry[]).filter(e => e.kind === 'mnemonic' && e.recipe);
    const fillPhrase = (e: Entry) =>
      (async () => {
        const okcrypto = (await getOnlyKey(step.target.backend)).okcrypto as unknown as PhraseOkcrypto;
        namePhraseDerive(mnemonic.nameOf(e.recipe));
        const words = await mnemonic.openRecipe({okcrypto, recipe: e.recipe});
        await OkAutofill?.fill(null, words.join(' '));
      })().catch(err => setStep({kind: 'error', message: String(err?.message ?? err)}));
    const items: EdgeListItem[] = [
      {
        key: 'who',
        kind: 'row',
        tone: 'warn',
        title: `${form.packageName || 'An app'} asks for a wallet phrase`,
        subtitle: 'Fill a phrase only into the wallet it belongs to. Anything else asking for one is after your coins.',
      },
      {key: 's-phrases', kind: 'section', title: 'Your wallet phrases', right: String(phrases.length)},
    ];
    if (!phrases.length) items.push({key: 'none', kind: 'row', tone: 'dim', title: 'No wallet phrases yet', subtitle: 'Make one on the Passwords tab: + Phrase.'});
    for (const e of phrases) {
      items.push({
        key: e.id,
        kind: 'row',
        title: e.title,
        subtitle: `${e.recipe.out === 'bip39-12' ? 12 : 24} words, from "${mnemonic.nameOf(e.recipe)}"`,
        onPress: () => void fillPhrase(e),
      });
    }
    body = (
      <View style={styles.root}>
        <EdgeList items={items} />
        <View style={styles.bar}>
          <Btn title="Cancel" onPress={cancel} />
        </View>
      </View>
    );
  } else if (step.kind === 'open') {
    const all = (step.manager.list() as Entry[]).filter(e => (e.kind === 'login' && (e.inner || e.password || e.username)) || e.kind === 'derived');
    const mine = form ? matching(all, form) : [];
    const others = all.filter(e => !mine.includes(e));
    const items: EdgeListItem[] = [{key: 's-mine', kind: 'section', title: `Saved for ${name}`, right: String(mine.length)}];
    if (!mine.length) items.push({key: 'none', kind: 'row', tone: 'dim', title: `Nothing saved for ${name}`});
    for (const e of mine) {
      items.push({key: e.id, kind: 'row', title: e.title, subtitle: e.username, onPress: () => pick(e)});
    }
    if (showAll) {
      items.push({key: 's-all', kind: 'section', title: 'Other entries', right: String(others.length)});
      items.push({
        key: 'warn',
        kind: 'row',
        tone: 'warn',
        title: `Not saved for ${name}`,
        subtitle: `Fill one of these only if you know ${name} is where it belongs. A look-alike address is how phishing works.`,
      });
      for (const e of others) {
        items.push({key: 'o-' + e.id, kind: 'row', title: e.title, subtitle: [e.username, e.urls?.[0] && hostOf(e.urls[0])].filter(Boolean).join(' · '), onPress: () => linkThen(e, x => void pick(x))});
      }
    }
    body = (
      <View style={styles.root}>
        <EdgeList items={items} />
        <View style={styles.bar}>
          {!showAll && others.length ? <Btn title={`Other entries (${others.length})`} onPress={() => setShowAll(true)} /> : null}
          <Btn title="Cancel" onPress={cancel} />
        </View>
      </View>
    );
  } else {
    body = (
      <ScrollView contentContainerStyle={styles.pad}>
        <Section title={phrase ? 'Wallet phrase' : name ? `${saving ? 'Save for' : 'Fill'} ${name}` : 'OnlyKey'}>
          {step.kind === 'starting' || step.kind === 'opening' ? (
            <Text style={styles.body}>{step.kind === 'opening' && step.target.hard ? 'Press a button on your OnlyKey if it asks…' : 'Opening your passwords…'}</Text>
          ) : step.kind === 'unlock' ? (
            <>
              <Text style={styles.body}>
                The {targetLabel(step.target)} is {step.state}.{' '}
                {step.target.canPress ? 'Enter its PIN - it unlocks the moment the PIN matches.' : 'Unlock it on the key itself.'}
              </Text>
              {step.target.canPress ? (
                <>
                  <Text style={styles.dim}>{'•'.repeat(digits)}</Text>
                  <Keypad onPress={b => void onDigit(step.target, b)} />
                </>
              ) : null}
            </>
          ) : step.kind === 'button' ? (
            <>
              <Text style={styles.body}>Your passwords are sealed to the {targetLabel(step.target)}. Opening asks the key once.</Text>
              <Btn
                title="Open with OnlyKey"
                tone="primary"
                onPress={() => openStore(step.target, true).catch(e => setStep({kind: 'error', message: String(e?.message ?? e)}))}
              />
            </>
          ) : (
            <Text style={[styles.body, {color: theme.error}]}>{step.message}</Text>
          )}
          <Btn title="Cancel" onPress={cancel} />
        </Section>
      </ScrollView>
    );
  }
  /*
   * ITS OWN SafeAreaProvider, all four edges: this root is mounted by AutofillAuthActivity, not by
   * App, so it inherits no insets - without one the list's header drew over the status bar clock
   * and Cancel sat in the gesture bar (the Pixel, 2026-10-11). As CredProviderScreen does.
   */
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
        {body}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: theme.bg},
  root: {flex: 1},
  pad: {padding: 16},
  bar: {flexDirection: 'row', gap: 8, padding: 16, flexWrap: 'wrap'},
  progress: {paddingHorizontal: 16, paddingBottom: 8},
  input: {marginTop: 8, color: theme.text, fontSize: 14, paddingHorizontal: 10, paddingVertical: 9, borderRadius: theme.radius, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.inputBg},
  body: {color: theme.text, fontSize: 14, lineHeight: 20},
  dim: {color: theme.textDim, fontSize: 18, letterSpacing: 4, marginTop: 8},
});
