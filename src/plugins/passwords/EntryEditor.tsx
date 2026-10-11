import React, {useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';

import {generatePassword} from '../../passwordGenerator';
import {Btn, Section, Segmented} from '../../ui/components';
import {theme} from '../../ui/theme';

/*
 * One entry, new or edited. The kinds are the ones this release writes (lib passwords/src/
 * manager.js KINDS); the lib checks every field again before sealing, so this form only has to
 * be convenient. A new password comes from the app's generator (src/passwordGenerator.ts: the
 * phone's CSPRNG, every chosen class present).
 */

const KINDS = ['login', 'note', 'card'] as const;
type Kind = (typeof KINDS)[number];
const KIND_LABEL: Record<Kind, string> = {login: 'Login', note: 'Note', card: 'Card'};
const GENERATED = {length: 20, upper: true, lower: true, digits: true, symbols: true};

type Input = {
  id?: string;
  kind: Kind;
  title: string;
  username?: string;
  password?: string;
  urls?: string[];
  notes?: string;
};

export function EntryEditor({
  entry,
  onSave,
  onDelete,
}: {
  entry: (Input & {id: string}) | null;
  onSave: (input: Input) => void;
  onDelete?: () => void;
}) {
  const [kind, setKind] = useState<Kind>(entry?.kind ?? 'login');
  const [title, setTitle] = useState(entry?.title ?? '');
  const [username, setUsername] = useState(entry?.username ?? '');
  const [password, setPassword] = useState(entry?.password ?? '');
  const [show, setShow] = useState(!entry);
  const [urls, setUrls] = useState((entry?.urls ?? []).join('\n'));
  const [notes, setNotes] = useState(entry?.notes ?? '');

  const save = () => {
    const opt = (s: string) => (s.trim() ? s : undefined);
    onSave({
      ...(entry ? {id: entry.id} : {}),
      kind,
      title: title.trim(),
      username: kind === 'login' ? opt(username.trim()) : undefined,
      password: kind !== 'note' ? opt(password) : undefined,
      urls: kind === 'login' ? urls.split('\n').map(u => u.trim()).filter(Boolean) : undefined,
      notes: opt(notes),
    });
  };

  return (
    <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
      <Section title={entry ? KIND_LABEL[kind] : 'New'}>
        {entry ? null : <Segmented options={KINDS} value={kind} onChange={setKind} />}
        <Field label="Title" value={title} onChange={setTitle} placeholder="GitHub" />
        {kind === 'login' ? <Field label="Username" value={username} onChange={setUsername} placeholder="name or email" /> : null}
        {kind !== 'note' ? (
          <>
            <Field label={kind === 'card' ? 'Number or PIN' : 'Password'} value={password} onChange={setPassword} secure={!show} mono />
            <View style={styles.buttons}>
              <Btn title={show ? 'Hide' : 'Show'} onPress={() => setShow(s => !s)} />
              {kind === 'login' ? (
                <Btn
                  title="Generate"
                  onPress={() => {
                    setPassword(generatePassword(GENERATED));
                    setShow(true);
                  }}
                />
              ) : null}
            </View>
          </>
        ) : null}
        {kind === 'login' ? <Field label="Sites (one per line)" value={urls} onChange={setUrls} placeholder="https://github.com" multiline /> : null}
        <Field label="Notes" value={notes} onChange={setNotes} multiline />
        <View style={styles.buttons}>
          <Btn title="Save" tone="primary" disabled={!title.trim()} onPress={save} />
          {onDelete ? <Btn title="Delete" tone="danger" onPress={onDelete} /> : null}
        </View>
      </Section>
    </ScrollView>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secure,
  multiline,
  mono,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  placeholder?: string;
  secure?: boolean;
  multiline?: boolean;
  mono?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secure}
        multiline={multiline}
        /* no autofill service (Google's or ours) offers to save what is typed here */
        importantForAutofill="no"
        style={[styles.input, multiline && styles.multi, mono && styles.mono]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  pad: {padding: 16},
  field: {marginTop: 8},
  label: {color: theme.textDim, fontSize: 12},
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
  multi: {minHeight: 72, textAlignVertical: 'top'},
  mono: {fontFamily: theme.mono},
  buttons: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
});
