import React, {useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';

import {mnemonic} from 'node-onlykey-lib/passwords';
import {useSharedBtKeyboard} from '../../hooks/BtKeyboardContext';
import {nameDerive} from '../../pressAsk';
import {Btn, Section, Segmented} from '../../ui/components';
import {theme} from '../../ui/theme';
import type {Manager} from './stores';
import type {PhraseOkcrypto} from './usePasswordManager';

/*
 * WALLET PHRASES (Brad, 2026-10-11: "i give it a derived name, it generates a bip39, so it can be
 * re-derived using same backup if lost"; the spec's "Wallet mnemonics"). The words come from the
 * key's derive on the name (node-onlykey-lib passwords/src/mnemonic.js) and are never stored: an
 * entry keeps the recipe and a check value. Creating one shows the words ONCE and asks three of
 * them back - the paper copy is the recovery that needs no key. They are never copied to the
 * clipboard; Type sends them over Bluetooth one word at a time; Autofill fills a wallet's phrase
 * box from the sheet.
 */

type PhraseKey = () => Promise<{okcrypto: PhraseOkcrypto; press: boolean}>;
type Act = (fn: () => void | Promise<void>) => void;
type Out = 'bip39-12' | 'bip39-24';
const OUTS: readonly Out[] = ['bip39-12', 'bip39-24'];
const OUT_LABEL: Record<Out, string> = {'bip39-12': '12 words', 'bip39-24': '24 words'};

/* the press sheet names a phrase's derive by its name (a press can be asked for it) */
export const namePhraseDerive = (name: string) => nameDerive(mnemonic.labelOf(name), `Wallet phrase "${name.trim()}"`);

declare const crypto: {getRandomValues<T extends Uint32Array>(array: T): T};

/** Three distinct word positions to ask back, at random. */
function askPositions(count: number): number[] {
  const out = new Set<number>();
  const buf = new Uint32Array(1);
  while (out.size < 3) {
    crypto.getRandomValues(buf);
    out.add(buf[0] % count);
  }
  return [...out].sort((a, b) => a - b);
}

export function PhraseGrid({words}: {words: string[]}) {
  return (
    <View style={styles.grid}>
      {words.map((w, i) => (
        <View key={i} style={styles.cell}>
          <Text style={styles.num}>{i + 1}</Text>
          <Text style={styles.word}>{w}</Text>
        </View>
      ))}
    </View>
  );
}

/** A new phrase: name -> words shown once -> three asked back -> saved as a recipe. */
export function NewPhrase({
  manager,
  phraseKey,
  act,
  onSaved,
}: {
  manager: Manager;
  phraseKey: PhraseKey;
  act: Act;
  onSaved: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [out, setOut] = useState<Out>('bip39-24');
  const [made, setMade] = useState<{words: string[]; recipe: any} | null>(null);
  const [asking, setAsking] = useState<number[] | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  const existing = (manager.list() as any[]).find(
    e => e.kind === 'mnemonic' && e.recipe?.label === 'mnemonic:' + name.trim() && e.recipe?.out === out,
  );

  const create = () =>
    act(async () => {
      setError(null);
      const {okcrypto, press} = await phraseKey();
      namePhraseDerive(name);
      setMade(await mnemonic.deriveMnemonic({okcrypto, name, out, press}));
    });

  if (!made) {
    return (
      <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
        <Section title="New wallet phrase">
          <Text style={styles.body}>
            The words come from this OnlyKey and the name you give. The same name on this key - or on a key restored from
            its backup - always gives the same words, so a lost wallet can be made again. Nothing of the phrase is stored here.
          </Text>
          <Text style={styles.label}>Name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="wallet-1"
            placeholderTextColor={theme.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            importantForAutofill="no"
            style={styles.input}
          />
          <Text style={styles.dim}>Write the name down too: it is half of the recipe.</Text>
          <Segmented options={OUTS.map(o => OUT_LABEL[o])} value={OUT_LABEL[out]} onChange={v => setOut(v === '12 words' ? 'bip39-12' : 'bip39-24')} />
          {existing ? <Text style={[styles.dim, {color: theme.warn}]}>"{existing.title}" is already this phrase.</Text> : null}
          <View style={styles.buttons}>
            <Btn title="Make the phrase" tone="primary" disabled={!name.trim()} onPress={create} />
          </View>
        </Section>
      </ScrollView>
    );
  }

  if (!asking) {
    return (
      <ScrollView contentContainerStyle={styles.pad}>
        <Section title={`${name.trim()} - ${made.words.length} words`}>
          <Text style={styles.body}>Write these down, in order, on paper. They are shown here once.</Text>
          <PhraseGrid words={made.words} />
          <View style={styles.buttons}>
            <Btn title="I wrote them down" tone="primary" onPress={() => setAsking(askPositions(made.words.length))} />
          </View>
        </Section>
      </ScrollView>
    );
  }

  const right = asking.every(i => (answers[i] ?? '').trim().toLowerCase() === made.words[i]);
  const save = () =>
    act(async () => {
      if (!right) return setError('Not quite - check the paper copy.');
      const e = await manager.put({kind: 'mnemonic', title: name.trim(), recipe: made.recipe});
      setMade(null);
      onSaved(e.id);
    });
  return (
    <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
      <Section title="Check your copy">
        <Text style={styles.body}>From the paper, type these words.</Text>
        {asking.map(i => (
          <View key={i}>
            <Text style={styles.label}>Word {i + 1}</Text>
            <TextInput
              value={answers[i] ?? ''}
              onChangeText={t => setAnswers(a => ({...a, [i]: t}))}
              autoCapitalize="none"
              autoCorrect={false}
              importantForAutofill="no"
              style={styles.input}
            />
          </View>
        ))}
        {error ? <Text style={[styles.dim, {color: theme.error}]}>{error}</Text> : null}
        <View style={styles.buttons}>
          <Btn title="Save" tone="primary" onPress={save} />
          <Btn title="Show the words again" onPress={() => setAsking(null)} />
        </View>
      </Section>
    </ScrollView>
  );
}

/** A saved phrase: re-derived and checked on Show; typed one word at a time. */
export function PhraseEntry({entry, phraseKey, act}: {entry: any; phraseKey: PhraseKey; act: Act}) {
  const [words, setWords] = useState<string[] | null>(null);
  const [next, setNext] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const bt = useSharedBtKeyboard();
  const canType = bt.state === 'connected' && bt.forwarding;

  const show = () =>
    act(async () => {
      setError(null);
      const {okcrypto} = await phraseKey();
      namePhraseDerive(mnemonic.nameOf(entry.recipe));
      try {
        setWords(await mnemonic.openRecipe({okcrypto, recipe: entry.recipe}));
        setNext(0);
      } catch (e: any) {
        setError(String(e?.message ?? e));
      }
    });
  const typeNext = () =>
    act(async () => {
      if (!words) return;
      await bt.typeSecret(words[next], {then: null});
      setNext(n => n + 1);
    });

  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <Section title="Wallet phrase">
        <Text style={styles.body}>
          {entry.recipe.out === 'bip39-12' ? '12' : '24'} words from the name "{mnemonic.nameOf(entry.recipe)}"
          {entry.recipe.press ? ', made with a press' : ''}. Made again from the key each time; checked against the saved check
          before it is shown.
        </Text>
        {error ? <Text style={[styles.body, {color: theme.error}]}>{error}</Text> : null}
        {words ? <PhraseGrid words={words} /> : null}
        <View style={styles.buttons}>
          {words ? <Btn title="Hide" onPress={() => setWords(null)} /> : <Btn title="Show words" tone="primary" onPress={show} />}
        </View>
      </Section>
      {words ? (
        <Section title="Type on the computer">
          {canType ? (
            next < words.length ? (
              <>
                <Text style={styles.dim}>One word at a time, into whatever has focus on {bt.host || 'the computer'}.</Text>
                <View style={styles.buttons}>
                  <Btn title={`Type word ${next + 1}`} onPress={typeNext} />
                  {next > 0 ? <Btn title="Start over" onPress={() => setNext(0)} /> : null}
                </View>
              </>
            ) : (
              <Text style={styles.dim}>All {words.length} words typed.</Text>
            )
          ) : (
            <Text style={styles.dim}>Connect a computer on the Bluetooth tab, with typing switched on, to type here.</Text>
          )}
        </Section>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  pad: {padding: 16},
  body: {color: theme.text, fontSize: 14, lineHeight: 20},
  dim: {color: theme.textDim, fontSize: 12, lineHeight: 17, marginTop: 6},
  label: {color: theme.textDim, fontSize: 12, marginTop: 10},
  input: {
    marginTop: 4,
    color: theme.text,
    fontSize: 15,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.inputBg,
  },
  buttons: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  grid: {flexDirection: 'row', flexWrap: 'wrap', marginTop: 12},
  cell: {width: '33.33%', flexDirection: 'row', alignItems: 'baseline', paddingVertical: 6, gap: 6},
  num: {color: theme.textDim, fontSize: 12, width: 20, textAlign: 'right'},
  word: {color: theme.text, fontSize: 16, fontFamily: theme.mono},
});
