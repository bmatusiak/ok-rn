import React, {useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';

import {totp as totpLib} from 'node-onlykey-lib/passwords';
import {generatePassword} from '../../passwordGenerator';
import {Btn, Section} from '../../ui/components';
import {theme} from '../../ui/theme';

/*
 * One entry, new or edited. The kinds are the ones this release writes (lib passwords/src/
 * manager.js KINDS); the lib checks every field again before sealing, so this form only has to
 * be convenient. A new password comes from the app's generator (src/passwordGenerator.ts: the
 * phone's CSPRNG, every chosen class present).
 */

const KINDS = ['login', 'note', 'card', 'totp'] as const;
type Kind = (typeof KINDS)[number];
const KIND_LABEL: Record<Kind, string> = {login: 'Login', note: 'Note', card: 'Card', totp: 'Authenticator'};
const GENERATED = {length: 20, upper: true, lower: true, digits: true, symbols: true};

type Input = {
  id?: string;
  kind: Kind;
  title: string;
  username?: string;
  password?: string;
  urls?: string[];
  notes?: string;
  totp?: any;
};

export function EntryEditor({
  entry,
  newKind = 'login',
  onSave,
  onDelete,
}: {
  entry: (Input & {id: string}) | null;
  /* a new entry's kind, chosen on the + Add page */
  newKind?: Kind;
  onSave: (input: Input) => void;
  onDelete?: () => void;
}) {
  const kind: Kind = entry?.kind ?? newKind;
  const [title, setTitle] = useState(entry?.title ?? '');
  const [username, setUsername] = useState(entry?.username ?? '');
  const [password, setPassword] = useState(entry?.password ?? '');
  const [show, setShow] = useState(!entry);
  const [urls, setUrls] = useState((entry?.urls ?? []).join('\n'));
  const [notes, setNotes] = useState(entry?.notes ?? '');
  /* an authenticator's setup key, or the whole otpauth:// link (the QR code's text) */
  const [otp, setOtp] = useState<string>(entry?.totp?.secret ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const opt = (s: string) => (s.trim() ? s : undefined);
    /* the code: a pasted otpauth:// link brings its own settings (and a title); a bare key keeps
       the entry's settings, or the usual 6 digits / 30 s / SHA1 */
    let code: any;
    let named = title.trim();
    try {
      const raw = otp.trim();
      if (raw && /^otpauth:\/\//i.test(raw)) {
        const r = totpLib.parseOtpauth(raw);
        code = r.totp;
        if (!named) named = r.issuer || r.account;
      } else if (raw) {
        code = totpLib.shapeTotp({...(entry?.totp ?? {}), secret: raw});
      }
    } catch (e: any) {
      return setError(String(e?.message ?? e).replace(/^passwords: /, ''));
    }
    if (kind === 'totp' && !code) return setError('the setup key (or the otpauth:// link) is needed');
    if (!named) return setError('a title is needed');
    setError(null);
    onSave({
      ...(entry ? {id: entry.id} : {}),
      kind,
      title: named,
      ...(code ? {totp: code} : {}),
      username: kind === 'login' ? opt(username.trim()) : undefined,
      password: kind === 'login' || kind === 'card' ? opt(password) : undefined,
      /* the sites a login (or an authenticator's code) is filled on - Autofill matches on these */
      urls: kind === 'login' || kind === 'totp' ? urls.split('\n').map(u => u.trim()).filter(Boolean) : undefined,
      notes: opt(notes),
    });
  };

  return (
    <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
      <Section title={entry ? KIND_LABEL[kind] : `New ${KIND_LABEL[kind].toLowerCase()}`}>
        <Field label="Title" value={title} onChange={setTitle} placeholder="GitHub" />
        {kind === 'login' ? <Field label="Username" value={username} onChange={setUsername} placeholder="name or email" /> : null}
        {kind === 'login' || kind === 'card' ? (
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
        {kind === 'login' || kind === 'totp' ? <Field label="Sites (one per line)" value={urls} onChange={setUrls} placeholder="https://github.com" multiline /> : null}
        {kind === 'totp' || kind === 'login' ? (
          <Field
            label={kind === 'totp' ? 'Setup key, or the otpauth:// link' : 'Authenticator setup key (optional)'}
            value={otp}
            onChange={setOtp}
            placeholder="JBSW Y3DP EHPK 3PXP"
            secure={!show}
            mono
          />
        ) : null}
        <Field label="Notes" value={notes} onChange={setNotes} multiline />
        {error ? <Text style={[styles.label, {color: theme.error}]}>{error}</Text> : null}
        <View style={styles.buttons}>
          <Btn title="Save" tone="primary" disabled={!title.trim() && !/^otpauth:/i.test(otp.trim())} onPress={save} />
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
