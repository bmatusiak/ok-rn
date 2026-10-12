import React, {useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';

import {totp as totpLib} from 'node-onlykey-lib/passwords';
import {sealOf, type Seal} from './innerKeys';
import {TotpPreview} from './TotpViews';
import {generatePassword, MAX_LENGTH, MIN_LENGTH, type PasswordOptions} from '../../passwordGenerator';
import {Btn, Section, Segmented} from '../../ui/components';
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
const SEAL_LABELS = ['No', 'With the key', 'With a passphrase'] as const;
const SEAL_LABEL_OF: Record<Seal, (typeof SEAL_LABELS)[number]> = {none: 'No', key: 'With the key', passphrase: 'With a passphrase'};
const SEAL_OF_LABEL: Record<(typeof SEAL_LABELS)[number], Seal> = {No: 'none', 'With the key': 'key', 'With a passphrase': 'passphrase'};

/* the generator's start: 20 characters of every class; Options changes it for this entry */
const GENERATED: PasswordOptions = {length: 20, upper: true, lower: true, digits: true, symbols: true};
const CLASSES: {key: 'upper' | 'lower' | 'digits' | 'symbols'; label: string}[] = [
  {key: 'upper', label: 'A-Z'},
  {key: 'lower', label: 'a-z'},
  {key: 'digits', label: '0-9'},
  {key: 'symbols', label: '#$%'},
];

type Input = {
  id?: string;
  kind: Kind;
  title: string;
  username?: string;
  password?: string;
  urls?: string[];
  notes?: string;
  folder?: string;
  tags?: string[];
  totp?: any;
};

const CODE_KINDS = ['Time-based', 'Counter-based', 'Steam'] as const;
type CodeKind = (typeof CODE_KINDS)[number];
const codeKindOf = (t: any): CodeKind => (t?.type === 'hotp' ? 'Counter-based' : t?.encoder === 'steam' ? 'Steam' : 'Time-based');
const ALGO_OPTIONS = ['SHA1', 'SHA256', 'SHA512'] as const;
const DIGIT_OPTIONS = ['6', '7', '8'] as const;

export function EntryEditor({
  entry,
  newKind = 'login',
  onSave,
  onDelete,
}: {
  entry: (Input & {id: string}) | null;
  /* a new entry's kind, chosen on the + Add page */
  newKind?: Kind;
  /* seal: the entry sealed a second time with its own key (innerKeys.ts), or not */
  onSave: (input: Input, seal: {seal: Seal; passphrase?: string}) => void;
  onDelete?: () => void;
}) {
  const kind: Kind = entry?.kind ?? newKind;
  const [title, setTitle] = useState(entry?.title ?? '');
  const [username, setUsername] = useState(entry?.username ?? '');
  const [password, setPassword] = useState(entry?.password ?? '');
  const [show, setShow] = useState(!entry);
  const [urls, setUrls] = useState((entry?.urls ?? []).join('\n'));
  const [notes, setNotes] = useState(entry?.notes ?? '');
  /* filing: one folder, any tags (comma-separated here) - the list filters and searches on them */
  const [folder, setFolder] = useState(entry?.folder ?? '');
  const [tags, setTags] = useState((entry?.tags ?? []).join(', '));
  /* an authenticator's setup key, or the whole otpauth:// link (the QR code's text) */
  const [otp, setOtp] = useState<string>(entry?.totp?.secret ?? '');
  /*
   * A code typed in by hand (spec "Adding an account", "Or type it in"): its kind, and an Advanced
   * fold for algorithm, digits and period. Steam fixes its own (5 characters, SHA1, 30 s) and takes
   * the base64 shared_secret of its .maFile; Counter-based asks the next counter. A link sets all
   * of it by itself.
   */
  const [codeKind, setCodeKind] = useState<CodeKind>(codeKindOf(entry?.totp));
  const [advOpen, setAdvOpen] = useState(false);
  const [algo, setAlgo] = useState<(typeof ALGO_OPTIONS)[number]>(entry?.totp?.algo && entry.totp.algo in {SHA1: 1, SHA256: 1, SHA512: 1} ? entry.totp.algo : 'SHA1');
  const [digits, setDigits] = useState<(typeof DIGIT_OPTIONS)[number]>(['6', '7', '8'].includes(String(entry?.totp?.digits)) ? (String(entry!.totp.digits) as any) : '6');
  const [period, setPeriod] = useState(String(entry?.totp?.period ?? 30));
  const [counter, setCounter] = useState(String(entry?.totp?.counter ?? 0));
  const isLink = /^otpauth:\/\//i.test(otp.trim());

  /* the field's text as a code: a link brings its own settings (and a title); a key takes the choices */
  const readCode = (): {code?: any; named?: string} => {
    const raw = otp.trim();
    if (!raw) return {};
    if (isLink) {
      const r = totpLib.parseOtpauth(raw);
      return {code: r.totp, named: r.issuer || r.account};
    }
    const base = {secret: raw, issuer: entry?.totp?.issuer};
    if (codeKind === 'Steam') return {code: totpLib.shapeTotp({...base, encoder: 'steam'})};
    const common = {...base, algo, digits: Number(digits)};
    if (codeKind === 'Counter-based') {
      const next = Number(counter);
      /* spec: the counter only moves forward - a lower one would show codes already used */
      const was = entry?.totp?.type === 'hotp' ? entry.totp.counter ?? 0 : 0;
      if (Number.isInteger(next) && next < was) throw new Error(`the counter only moves forward (it is at ${was})`);
      return {code: totpLib.shapeTotp({...common, type: 'hotp', counter: next})};
    }
    return {code: totpLib.shapeTotp({...common, period: Number(period)})};
  };
  let preview: any = null;
  let previewError: string | null = null;
  try {
    preview = readCode().code ?? null;
  } catch (e: any) {
    previewError = String(e?.message ?? e).replace(/^passwords: /, '');
  }
  const [error, setError] = useState<string | null>(null);
  /* sealed a second time: with the key (a press each open) or a passphrase (spec: per-entry keys) */
  const [seal, setSeal] = useState<Seal>(sealOf(entry));
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  /* an entry already sealed with a passphrase keeps it unless a new one is typed */
  const keepsPassphrase = sealOf(entry) === 'passphrase' && seal === 'passphrase' && !pass1;
  /* the generator's options (spec UI: "Generator"): length and character classes */
  const [gen, setGen] = useState<PasswordOptions>(GENERATED);
  const [genOpen, setGenOpen] = useState(false);
  const setLength = (n: number) => setGen(g => ({...g, length: Math.max(MIN_LENGTH, Math.min(MAX_LENGTH, n))}));
  /* a class turns off only while another stays on: a password needs at least one */
  const toggle = (k: (typeof CLASSES)[number]['key']) =>
    setGen(g => (g[k] && CLASSES.filter(c => g[c.key]).length === 1 ? g : {...g, [k]: !g[k]}));

  /* the camera reads the setup QR; asked only now. Its text is the otpauth:// link (title and settings in it) */
  const scanQr = async () => {
    try {
      const NativeQrScanner = require('../../../specs/NativeQrScanner').default;
      const text: string | null = await NativeQrScanner.scan("Point the camera at the site's two-factor setup QR");
      if (!text) return;
      if (!/^otpauth:\/\//i.test(text)) return setError('that QR is not an authenticator setup code (otpauth://)');
      setError(null);
      setOtp(text);
    } catch (e: any) {
      setError(/PERMISSION/.test(String(e?.code ?? e?.message)) ? 'the camera was not allowed: Android settings > Apps > OnlyKey > Permissions' : String(e?.message ?? e));
    }
  };

  const save = () => {
    const opt = (s: string) => (s.trim() ? s : undefined);
    /* the code: a link brings its own settings (and a title); a key takes the form's choices */
    let code: any;
    let named = title.trim();
    try {
      const r = readCode();
      code = r.code;
      if (!named && r.named) named = r.named;
    } catch (e: any) {
      return setError(String(e?.message ?? e).replace(/^passwords: /, ''));
    }
    if (kind === 'totp' && !code) return setError('the setup key (or the otpauth:// link) is needed');
    if (!named) return setError('a title is needed');
    if (seal === 'passphrase' && !keepsPassphrase) {
      if (pass1.length < 8) return setError('the passphrase needs 8 characters or more');
      if (pass1 !== pass2) return setError('the two passphrases differ');
    }
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
      folder: opt(folder.trim()),
      tags: tags.split(',').map(t => t.trim()).filter(Boolean),
    }, {seal, passphrase: seal === 'passphrase' && !keepsPassphrase ? pass1 : undefined});
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
                <>
                  <Btn
                    title="Generate"
                    onPress={() => {
                      setPassword(generatePassword(gen));
                      setShow(true);
                    }}
                  />
                  <Btn title={genOpen ? 'Options ▲' : 'Options ▼'} onPress={() => setGenOpen(o => !o)} />
                </>
              ) : null}
            </View>
            {kind === 'login' && genOpen ? (
              <View>
                <View style={styles.buttons}>
                  <Btn title="−" label="shorter" onPress={() => setLength(gen.length - 1)} />
                  <Text style={styles.length}>{gen.length} characters</Text>
                  <Btn title="+" label="longer" onPress={() => setLength(gen.length + 1)} />
                </View>
                <View style={styles.buttons}>
                  {CLASSES.map(c => (
                    <Btn key={c.key} title={c.label} tone={gen[c.key] ? 'primary' : 'default'} onPress={() => toggle(c.key)} />
                  ))}
                </View>
              </View>
            ) : null}
          </>
        ) : null}
        {kind === 'login' || kind === 'totp' ? <Field label="Sites (one per line)" value={urls} onChange={setUrls} placeholder="https://github.com" multiline /> : null}
        {kind === 'totp' || kind === 'login' ? (
          <Field
            label={
              codeKind === 'Steam' && !isLink
                ? "Steam's shared_secret (from its .maFile), or its setup key"
                : kind === 'totp'
                  ? 'Setup key, or the otpauth:// link'
                  : 'Authenticator setup key (optional)'
            }
            value={otp}
            onChange={setOtp}
            placeholder="JBSW Y3DP EHPK 3PXP"
            secure={!show}
            mono
          />
        ) : null}
        {kind === 'totp' || kind === 'login' ? (
          <View style={styles.buttons}>
            {/* the site's setup QR, read with the camera (specs/NativeQrScanner.ts): its otpauth:// link */}
            <Btn title="Scan QR" onPress={() => void scanQr()} />
          </View>
        ) : null}
        {isLink ? <Text style={styles.label}>The link sets the kind of code and its settings.</Text> : null}
        {(kind === 'totp' || (kind === 'login' && otp.trim())) && !isLink ? (
          <>
            <Text style={styles.label}>Kind of code</Text>
            <Segmented options={CODE_KINDS} value={codeKind} onChange={setCodeKind} />
            {codeKind === 'Counter-based' ? <Field label="Next counter (0 for a new account)" value={counter} onChange={setCounter} mono /> : null}
            {codeKind !== 'Steam' ? (
              <View style={styles.buttons}>
                <Btn title={advOpen ? 'Advanced ▲' : 'Advanced ▼'} onPress={() => setAdvOpen(o => !o)} />
              </View>
            ) : (
              <Text style={styles.label}>Steam: 5 characters, SHA1, every 30 s.</Text>
            )}
            {advOpen && codeKind !== 'Steam' ? (
              <>
                <Text style={styles.label}>Algorithm (most sites: SHA1)</Text>
                <Segmented options={ALGO_OPTIONS} value={algo} onChange={setAlgo} />
                <Text style={styles.label}>Digits</Text>
                <Segmented options={DIGIT_OPTIONS} value={digits} onChange={setDigits} />
                {codeKind === 'Time-based' ? <Field label="Period in seconds (most sites: 30)" value={period} onChange={setPeriod} mono /> : null}
              </>
            ) : null}
          </>
        ) : null}
        {preview ? <TotpPreview totp={preview} /> : previewError ? <Text style={[styles.label, {color: theme.error}]}>{previewError}</Text> : null}
        <Field label="Notes" value={notes} onChange={setNotes} multiline />
        <Field label="Folder" value={folder} onChange={setFolder} placeholder="Work" />
        <Field label="Tags (comma-separated)" value={tags} onChange={setTags} placeholder="email, important" />
        <Text style={styles.label}>Seal this entry again</Text>
        <Segmented options={SEAL_LABELS} value={SEAL_LABEL_OF[seal]} onChange={v => setSeal(SEAL_OF_LABEL[v])} />
        <Text style={styles.label}>
          {seal === 'key'
            ? 'Its password, notes and code open only with one more press of the key, each time.'
            : seal === 'passphrase'
              ? 'Its password, notes and code open only with this passphrase too - nothing stores it; forget it and they are gone.'
              : 'Opens with the store, like the rest.'}
        </Text>
        {seal === 'passphrase' ? (
          <>
            <Field label={keepsPassphrase ? 'New passphrase (empty: keep the one it has)' : 'Passphrase'} value={pass1} onChange={setPass1} secure />
            {pass1 ? <Field label="The passphrase again" value={pass2} onChange={setPass2} secure /> : null}
          </>
        ) : null}
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
  buttons: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center'},
  length: {color: theme.text, fontSize: 14, marginTop: 10, minWidth: 110, textAlign: 'center'},
});
