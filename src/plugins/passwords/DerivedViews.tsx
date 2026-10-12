import React, {useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';

import {derived} from 'node-onlykey-lib/passwords';
import {useSharedBtKeyboard} from '../../hooks/BtKeyboardContext';
import {MAX_LENGTH, MIN_LENGTH} from '../../passwordGenerator';
import {nameDerive} from '../../pressAsk';
import {Btn, KeyValue, Section} from '../../ui/components';
import {theme} from '../../ui/theme';
import type {Manager} from './stores';
import type {PhraseOkcrypto} from './usePasswordManager';

/*
 * DERIVED PASSWORDS (PASSWORD-MANAGER-SPEC.md "Derived passwords"): a password made from this
 * OnlyKey and a name, never stored - the entry keeps its recipe (lib passwords/src/derived.js), so
 * a key restored from the backup gives it again. Show re-derives it and checks it against the
 * recipe before it is shown; rotating means another name.
 */

type DeriveKey = () => Promise<{okcrypto: PhraseOkcrypto; press: boolean}>;
type Act = (fn: () => void | Promise<void>) => void;
type Klass = 'upper' | 'lower' | 'digits' | 'symbols';
const CLASSES: {key: Klass; label: string}[] = [
  {key: 'upper', label: 'A-Z'},
  {key: 'lower', label: 'a-z'},
  {key: 'digits', label: '0-9'},
  {key: 'symbols', label: '#$%'},
];

/* the press sheet names this derive by its name (a press can be asked for it) */
export const nameDerivedDerive = (name: string) => nameDerive(derived.labelOf(name), `Derived password "${name.trim()}"`);

export function NewDerived({
  manager,
  deriveKey,
  act,
  onSaved,
}: {
  manager: Manager;
  deriveKey: DeriveKey;
  act: Act;
  onSaved: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [urls, setUrls] = useState('');
  const [length, setLength] = useState(20);
  const [classes, setClasses] = useState<Klass[]>(['upper', 'lower', 'digits', 'symbols']);
  const toggle = (k: Klass) => setClasses(c => (c.includes(k) ? (c.length > 1 ? c.filter(x => x !== k) : c) : [...c, k]));

  const save = () =>
    act(async () => {
      const {okcrypto, press} = await deriveKey();
      nameDerivedDerive(name);
      const {recipe} = await derived.derivePasswordFor({okcrypto, name, length, classes, press});
      const e = await manager.put({
        kind: 'derived',
        title: title.trim() || name.trim(),
        username: username.trim() || undefined,
        urls: urls.split('\n').map(u => u.trim()).filter(Boolean),
        recipe,
      });
      onSaved(e.id);
    });

  return (
    <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
      <Section title="New derived password">
        <Text style={styles.body}>
          Made from this OnlyKey and a name: the same name gives the same password again, on this key or one restored from its
          backup. Nothing of the password is stored here. A new password for the same site = a new name (github-2).
        </Text>
        <Field label="Name it is made from" value={name} onChange={setName} placeholder="github" />
        <Field label="Title" value={title} onChange={setTitle} placeholder="GitHub (the name, if empty)" />
        <Field label="Username" value={username} onChange={setUsername} placeholder="name or email" />
        <Field label="Sites (one per line)" value={urls} onChange={setUrls} placeholder="https://github.com" multiline />
        <View style={styles.buttons}>
          <Btn title="−" label="shorter" onPress={() => setLength(n => Math.max(MIN_LENGTH, n - 1))} />
          <Text style={styles.length}>{length} characters</Text>
          <Btn title="+" label="longer" onPress={() => setLength(n => Math.min(MAX_LENGTH, n + 1))} />
        </View>
        <View style={styles.buttons}>
          {CLASSES.map(c => (
            <Btn key={c.key} title={c.label} tone={classes.includes(c.key) ? 'primary' : 'default'} onPress={() => toggle(c.key)} />
          ))}
        </View>
        <Text style={styles.dim}>The length and the kinds of character are part of the recipe: changing them later makes another password.</Text>
        <View style={styles.buttons}>
          <Btn title="Make it" tone="primary" disabled={!name.trim()} onPress={save} />
        </View>
      </Section>
    </ScrollView>
  );
}

export function DerivedEntry({
  entry,
  deriveKey,
  act,
  copy,
}: {
  entry: any;
  deriveKey: DeriveKey;
  act: Act;
  copy: (text: string, what: string) => Promise<void>;
}) {
  const [password, setPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bt = useSharedBtKeyboard();
  const canType = bt.state === 'connected' && bt.forwarding;

  /* the password, made again and checked; held only while this page is open */
  const get = async (): Promise<string> => {
    if (password) return password;
    const {okcrypto} = await deriveKey();
    nameDerivedDerive(derived.nameOf(entry.recipe));
    try {
      const p = await derived.openRecipe({okcrypto, recipe: entry.recipe});
      setPassword(p);
      return p;
    } catch (e: any) {
      setError(String(e?.message ?? e));
      throw e;
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <Section title="Derived password">
        {entry.username ? <KeyValue label="Username" value={entry.username} /> : null}
        <KeyValue label="Password" value={password ?? '•••••••••• (made from the key)'} />
        {entry.urls?.length ? <KeyValue label={entry.urls.length > 1 ? 'Sites' : 'Site'} value={entry.urls.join('\n')} /> : null}
        <KeyValue label="Made from" value={`"${derived.nameOf(entry.recipe)}", ${entry.recipe.length} characters`} />
        {error ? <Text style={[styles.body, {color: theme.error}]}>{error}</Text> : null}
        <View style={styles.buttons}>
          {password ? <Btn title="Hide" onPress={() => setPassword(null)} /> : <Btn title="Show password" onPress={() => act(async () => void (await get()))} />}
          <Btn title="Copy password" tone="primary" onPress={() => act(async () => copy(await get(), 'Password'))} />
          {entry.username ? <Btn title="Copy username" onPress={() => act(() => copy(entry.username, 'Username'))} /> : null}
        </View>
      </Section>
      {canType ? (
        <Section title="Type on the computer">
          <View style={styles.buttons}>
            {entry.username ? <Btn title="Type username + Tab" onPress={() => act(() => bt.typeSecret(entry.username, {then: 'tab'}))} /> : null}
            <Btn title="Type password" tone="primary" onPress={() => act(async () => bt.typeSecret(await get(), {then: null}))} />
            <Btn title="Type password + Enter" onPress={() => act(async () => bt.typeSecret(await get(), {then: 'enter'}))} />
          </View>
        </Section>
      ) : null}
    </ScrollView>
  );
}

function Field({label, value, onChange, placeholder, multiline}: {label: string; value: string; onChange: (s: string) => void; placeholder?: string; multiline?: boolean}) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        importantForAutofill="no"
        multiline={multiline}
        style={[styles.input, multiline && styles.multi]}
      />
    </View>
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
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.inputBg,
  },
  multi: {minHeight: 60, textAlignVertical: 'top'},
  buttons: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center'},
  length: {color: theme.text, fontSize: 14, marginTop: 10, minWidth: 110, textAlign: 'center'},
});
