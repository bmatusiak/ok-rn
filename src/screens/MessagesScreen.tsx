import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Btn, Section, Segmented} from '../ui/components';
import {NOT_IN_CONFIG_MODE, ON, type ConfigState} from '../ui/configModeNotes';
import {ListPicker, type PickItem} from '../ui/ListPicker';
import {missingNote, supports} from '../firmwareFeatures';
import {theme} from '../ui/theme';
import {pluginRecipientSources} from '../plugins';
import {armDeviceKey, readDeviceKeys, type DeviceKey} from '../pgpOps';
import {openKeyChainWizard, QUANTUM_SAFE_PGP} from '../keyChainNav';
import type {RecipientContact, RecipientSource} from '../plugins/recipients';
import {indexSigners, signedBy} from '../signers';
import {bytes as okbytes} from 'node-onlykey-lib';
/*
 * The crypto subtree is NOT on the library's root export, on purpose - keeping
 * it off means a caller wanting bytes or the protocol does not pull @noble in.
 * `crypto` here is the pure half; the 1.2 MB openpgp fork is a separate entry
 * point and is required lazily inside the handler below.
 */
import okpure from 'node-onlykey-lib/crypto';
import NativeShare from '../../specs/NativeShare';
import NativeSecrets from '../../specs/NativeSecrets';
import {useActiveKey, useKeyName} from '../hooks/KeyContext';
import type {EmuSession} from '../hooks/useOkEmu';

/**
 * Encrypt, decrypt, sign and verify PGP messages and files.
 *
 * These are the four pages the desktop app's Tools tab linked out to -
 * `/app/encrypt`, `/app/decrypt`, `/app/encrypt-file`, `/app/decrypt-file`.
 * They are here now, so the link board can point at a tab instead of at a web
 * page that cannot reach this key anyway.
 *
 * ## Other people come from Guest Book (Brad, 2026-10-18)
 *
 * "Encrypt decrypt tab should be guest book focused ... 1. users trade pubkey using guestbook,
 * 2. user then uses encrypt/decrypt tab ... guestbook will be how we get and store pubkey."
 * So this screen never takes someone else's key by paste or look-up any more (Keybase,
 * ProtonMail and URL live in Guest Book → Add): Encrypt picks people from a scrolling list (the
 * shared ListPicker - "not a pile of buttons"), and Decrypt / Verify name who signed by matching
 * the signature's key against everyone in Guest Book. Picking someone checks that one person's
 * keys at their sources first (Brad: refresh "only ... on a single contact ... or if i select the
 * contact to use to encrypt or decrypt"). The app is in its first design, so the old paste box
 * is gone, not kept beside the list.
 *
 * ## The fork is loaded LAZILY, and that is deliberate
 *
 * `node-onlykey-lib/crypto/pgp` is a 1.2 MB module. Requiring it at the top of
 * this file would put it in the bundle for everyone who opens the app,
 * including the majority who never come to this screen. It is required inside
 * the handler instead, on the first press.
 *
 * It also cannot be required until `src/installWebCrypto.js` has run, because
 * OpenPGP.js v6 reads WebCrypto at module scope and Hermes has none - see
 * FINDING-the-openpgp-fork-does-not-load-under-hermes.md. index.js imports the
 * installer before App, so by the time a screen exists the shim is in place.
 */

type Mode = 'encrypt' | 'decrypt' | 'sign' | 'verify';

const MODES: Mode[] = ['encrypt', 'decrypt', 'sign', 'verify'];

/**
 * Which of the web app's sub-tabs this screen is standing in for.
 *
 * The web app's top nav is Encrypt and Decrypt, each with the same four
 * kinds under it - Message, File, PQC-PGP, AGE (apps.onlykey.io
 * src/plugins/pages/mode-tabs.js). ok-rn follows that layout so someone who
 * knows the web app finds things where they already are. Three of the four
 * are this screen with a narrower view; AGE is CryptoScreen's age panel.
 */
export type MessagesPart = 'message' | 'file' | 'pqc';
export type Direction = 'encrypt' | 'decrypt';

/*
 * The modes each view offers. Encrypt holds encrypt and sign, Decrypt holds
 * decrypt and verify - the two directions of the web app's pages. A file is
 * encrypted or decrypted only: signing a file is not something this screen
 * has ever done, so offering it would be a button that fails.
 */
function modesFor(direction?: Direction, part?: MessagesPart): Mode[] {
  if (!direction) return MODES;
  if (part === 'file') return [direction];
  return direction === 'encrypt' ? ['encrypt', 'sign'] : ['decrypt', 'verify'];
}

/* the result page's title */
const RESULT_TITLE: Record<Mode, string> = {encrypt: 'Encrypted', decrypt: 'Decrypted', sign: 'Signed', verify: 'Signature check'};

/** The section title for a view, named as the web app's sub-tab is. */
const PART_TITLE: Record<MessagesPart, string> = {message: 'Message', file: 'File', pqc: 'PQC-PGP'};

/* one person, from whichever source holds them (Guest Book today) */
type Person = RecipientContact & {pick: string; source: RecipientSource};

export function MessagesScreen({
  emu,
  configMode,
  direction,
  part,
}: {
  /** Encrypt or Decrypt tab. Unset: every mode, as the old Messages tab had. */
  direction?: Direction;
  /** The sub-tab. Unset: every panel, as the old Messages tab had. */
  part?: MessagesPart;
  emu: EmuSession;
  /** Signing and decryption are refused in config mode - okcore.cpp:347. */
  configMode: ConfigState;
  /* Accepted from the tab and unused: nothing on this screen writes to the key any more. */
  onWantConfigMode?: () => void;
}) {
  /* The ACTIVE key, for the composite key that lives on the device. */
  const getKey = useActiveKey();
  const keyName = useKeyName();

  const modes = modesFor(direction, part);
  const [mode, setMode] = useState<Mode>(modes[0]);
  /* PQC-PGP: your key is the composite key on the device, and you encrypt to +PQC keys only. */
  const pqcPart = part === undefined || part === 'pqc';
  /* Picking a file is the File sub-tab's job; the old tab offered it on encrypt. */
  const filePicking = part === undefined ? mode === 'encrypt' : part === 'file';
  /* The name a decrypted file is saved under, from the message or the file. */
  const [outName, setOutName] = useState<string | null>(null);
  /* decrypt and sign need YOUR key; encrypt and verify need other people's */
  const needsMyKey = mode === 'decrypt' || mode === 'sign';

  /*
   * THE COMPOSITE KEY ON THE DEVICE: decrypt and sign THROUGH it - openpgp's
   * private-key operations are routed to the key by the fork's hardware
   * hooks, and the private half never exists on the phone.
   *
   * MADE IN KEY CHAIN, NOT HERE (Brad, 2026-10-12: "a redesign on the better
   * user frendly flow that does not take away from security"). Key Chain's
   * Wizard makes it and keeps its public certificate (the key cannot give it
   * back); here the kept ones are picked from a list.
   */
  const [kept, setKept] = useState<DeviceKey[]>([]);
  useEffect(() => {
    readDeviceKeys().then(setKept, () => {});
  }, []);
  const [myDeviceKey, setMyDeviceKey] = useState<string | null>(null);
  const deviceKey = pqcPart ? kept.find(k => k.id === myDeviceKey) ?? null : null;
  const [challenge, setChallenge] = useState<number[] | null>(null);
  /* Message / File: your private key, pasted (it is yours, not someone else's) */
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * THE RESULT IS ITS OWN PAGE (Brad, 2026-10-18: "lets have results for encrypt decrypt go to a
   * new view with back button"). A run that works opens it - what happened (who it is for, who
   * signed it), the text, Copy and Share; ‹ Back returns to the form with its inputs kept. A run
   * that fails stays on the form with the reason under it.
   */
  const [resultOpen, setResultOpen] = useState(false);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  /* ---- people, from Guest Book -------------------------------------------------------------- */
  const sources = pluginRecipientSources();
  const [people, setPeople] = useState<Person[]>([]);
  const loadPeople = useCallback(() => {
    /* you first, as a phone's contacts app puts its owner at the top; then everyone else */
    Promise.all(
      sources.map(s =>
        Promise.all([s.me(), s.pgpContacts()]).then(([me, list]) => (me ? [me, ...list] : list).map(c => ({...c, pick: `${s.name}:${c.id}`, source: s}))),
      ),
    ).then(all => setPeople(all.flat()), () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(loadPeople, [loadPeople]);
  const [to, setTo] = useState<string[]>([]);
  const [toNote, setToNote] = useState<string | null>(null);
  /* the keys used for a person here: PQC-PGP encrypts to their +PQC keys only */
  const keysFor = useCallback((p: Person) => (pqcPart ? p.keys.filter(k => k.composite) : p.keys), [pqcPart]);
  const pickable = useMemo(() => people.filter(p => keysFor(p).length), [people, keysFor]);
  const toItems: PickItem[] = pickable.map(p => {
    const keys = keysFor(p);
    const ok = keys.filter(k => k.verified).length;
    return {
      key: p.pick,
      title: p.name,
      detail: `${p.id === 'me' ? 'your keys' : ok === keys.length ? '✓ verified' : ok ? `! ${ok} of ${keys.length} verified` : '! unverified'}${keys.some(k => k.composite) ? ' · +PQC' : ''}`,
      detailTone: ok === keys.length ? 'ok' : 'warn',
    };
  });
  const picked = pickable.filter(p => to.includes(p.pick));
  const unverified = picked.filter(p => keysFor(p).some(k => !k.verified)).map(p => p.name);

  /*
   * PICKING SOMEONE CHECKS THEM: that one person's keys at their sources, now. A changed key is
   * not used until it is accepted in Guest Book, so this encrypts to the key you already have and
   * says what the check found.
   */
  const pickPeople = useCallback(
    (next: string[]) => {
      const added = people.filter(p => next.includes(p.pick) && !to.includes(p.pick));
      setTo(next);
      /* your own keys have no source to check: they are on this phone */
      for (const p of added.filter(x => x.id !== 'me')) {
        setToNote(`Checking ${p.name}'s keys…`);
        p.source
          .refresh(p.id)
          .then(
            changes => setToNote(changes.length ? changes.join('\n') : null),
            e => setToNote(`${p.name}: could not check their keys (${String(e?.message ?? e)}) - using the key you have.`),
          )
          .finally(loadPeople);
      }
    },
    [people, to, loadPeople],
  );

  /*
   * Faded when the attached key's firmware has no post-quantum support, which
   * is EVERY released firmware - see src/firmwareFeatures.ts. Only the
   * composite-key section is gated: the rest of this screen is ordinary PGP
   * with keys the phone holds, and that works on any key at all.
   */
  const pqc = supports(emu.capabilities, 'postQuantum');

  /*
   * A file picked to encrypt, kept as BYTES.
   *
   * Not decoded to text and re-encoded: a file that is not valid UTF-8 does not
   * survive that, and neither does one with CRLF line endings, because openpgp
   * normalises those for text messages and the conversion is not reversible.
   */
  const [file, setFile] = useState<{name: string; bytes: Uint8Array} | null>(null);

  const reset = useCallback(() => {
    setOutput('');
    setStatus(null);
    setError(null);
  }, []);

  const run = useCallback(async () => {
    reset();
    setBusy(true);
    let disarm: (() => void) | null = null;
    try {
      // Lazy, and only reachable once the WebCrypto shim is installed.
      const openpgp = require('node-onlykey-lib/crypto/pgp');
      const messages = okpure.messages;
      /* everyone's keys, to check a signature against - and who each key id belongs to */
      const everyone = people.flatMap(p => p.keys);
      const signers = await indexSigners(openpgp, people);

      if (mode === 'encrypt') {
        const recipients = picked.flatMap(p => keysFor(p).map(k => k.text));
        if (!recipients.length) throw new Error('Pick who to encrypt to.');
        /* you, by your name on this screen: "to you", not "to Me - Pixel" */
        const names = picked.map(p => (p.id === 'me' ? 'you' : p.name)).join(', ');
        if (file) {
          const armored = await messages.encryptFile(openpgp, {data: file.bytes, filename: file.name, recipients, armor: true});
          setOutput(String(armored));
          setStatus(`Encrypted ${file.name} (${file.bytes.length} bytes) to ${names}.`);
        } else {
          if (!input) throw new Error('nothing to encrypt');
          const armored = await messages.encryptText(openpgp, {text: input, recipients});
          setOutput(String(armored));
          setStatus(
            picked.length > 1
              ? `Encrypted to ${names}. Any one of them can read it.`
              : picked[0].id === 'me'
                ? 'Encrypted to you. Only your key can read it.'
                : `Encrypted to ${names}. Only they can read it.`,
          );
        }
        setResultOpen(true);
        return;
      }

      if (mode === 'verify') {
        if (!input.trim()) throw new Error('paste a signed message');
        if (!everyone.length) throw new Error('Nobody in your Guest Book to check the signature against.');
        const result = await messages.verifyText(openpgp, {armored: input, verifyWith: everyone.map(k => k.text)});
        setOutput(typeof result.data === 'string' ? result.data : '');
        setStatus(signedBy(result.signatures, signers) || 'There is no signature on this message.');
        setResultOpen(true);
        return;
      }

      /* PQC-PGP: your key on the device, armed for this one decrypt or signature (src/pgpOps.ts) */
      let hardware: unknown = null;
      if (pqcPart) {
        if (!deviceKey) throw new Error('Pick your key first.');
        const armed = await armDeviceKey(getKey, deviceKey, setChallenge);
        hardware = armed.privateKey;
        disarm = armed.disarm;
      } else if (!privateKey.trim()) {
        throw new Error('Your private key is empty.');
      }

      if (mode === 'decrypt') {
        if (!input.trim()) throw new Error('paste a PGP message, or pick a file');
        const kind = messages.classifyArmor(input);
        if (kind !== 'message') {
          throw new Error(`that is a ${kind}, not a PGP message`);
        }
        const result = await messages.decryptMessage(openpgp, {
          armored: input,
          decryptWith: hardware ?? privateKey,
          passphrase: passphrase || null,
          verifyWith: everyone.length ? everyone.map(k => k.text) : null,
        });

        /*
         * A decrypted FILE is bytes and may not be text at all, so it is
         * offered as a file rather than printed into a box that would show
         * mojibake.
         */
        setOutput(typeof result.data === 'string' ? result.data : '');
        /*
         * Decrypt > File saves under the name the sender gave the file, as
         * the web app's decrypt-file page does; failing that, the picked
         * file's name without its .asc/.gpg/.pgp.
         */
        setOutName(
          result.filename && result.filename !== 'msg.txt'
            ? result.filename
            : file
              ? file.name.replace(/\.(asc|gpg|pgp)$/i, '')
              : null,
        );
        const who = signedBy(result.signatures, signers) || 'Not signed - nothing says who sent it.';
        setStatus(
          result.filename && result.filename !== 'msg.txt'
            ? `Decrypted "${result.filename}". ${who}`
            : `Decrypted. ${who}`,
        );
        setResultOpen(true);
        return;
      }

      // sign
      if (!input) throw new Error('nothing to sign');
      const signed = await messages.signText(openpgp, {text: input, signWith: hardware ?? privateKey, passphrase: passphrase || null});
      setOutput(String(signed));
      setStatus('Signed. The text stays readable inside the signature.');
      setResultOpen(true);
    } catch (e) {
      setError(translate(String((e as Error)?.message ?? e)));
    } finally {
      setChallenge(null);
      disarm?.();
      setBusy(false);
    }
  }, [mode, privateKey, passphrase, input, file, reset, pqcPart, deviceKey, getKey, people, picked, keysFor]);

  /** Press the challenge digits through the key's console, when it takes presses. */
  const pressChallenge = useCallback(async () => {
    if (!challenge) return;
    for (const digit of challenge) await emu.press(digit);
  }, [challenge, emu]);

  const pickFile = useCallback(async () => {
    reset();
    try {
      const got = await NativeShare.pickTextFile('*/*');
      if (!got.picked) {
        return;
      }
      setFile({name: got.name, bytes: okbytes.utf8ToBytes(got.content)});
      if (mode === 'decrypt') {
        /*
         * DECRYPT > FILE reads the picked file as the message. The picker
         * returns text, so this opens an ARMORED file (.asc, or a .gpg saved
         * with armour, which is what Encrypt > File here produces). A binary
         * .gpg needs a byte picker - not built yet, and the error says so
         * rather than decrypting garbage.
         */
        if (!got.content.includes('-----BEGIN PGP')) {
          setFile(null);
          throw new Error(`${got.name} is not an armored PGP file - binary .gpg files cannot be opened here yet`);
        }
        setInput(got.content);
        setStatus(`Picked ${got.name}. It will be decrypted.`);
      } else {
        setInput('');
        setStatus(`Picked ${got.name}. It will be encrypted as a file.`);
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, [reset, mode]);

  const share = useCallback(async () => {
    if (!output) {
      return;
    }
    try {
      await NativeShare.shareFile(
        mode === 'encrypt' ? (file ? `${file.name}.asc` : 'message.asc') : outName ?? 'message.txt',
        output,
        mode === 'encrypt' ? 'application/pgp-encrypted' : 'text/plain',
        'PGP',
      );
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, [output, mode, file, outName]);

  const copy = useCallback(async () => {
    if (!output) {
      return;
    }
    // Sixty seconds, as everywhere else that copies something sensitive.
    await NativeSecrets.copySensitive(output, 60000);
    setCopyNote('Copied. The clipboard clears itself in a minute.');
  }, [output]);

  if (resultOpen) {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.topbar}>
          <Btn
            title="‹ Back"
            onPress={() => {
              setResultOpen(false);
              setCopyNote(null);
              reset();
            }}
          />
        </View>
        <Section title={RESULT_TITLE[mode]}>
          {status ? <Text style={styles.resultStatus}>{status}</Text> : null}
          {/* Copy / Share above the text: an armored message runs pages long */}
          {output ? (
            <>
              <View style={styles.row}>
                <Btn title="Copy" onPress={copy} />
                <Btn title="Share" onPress={share} />
              </View>
              {copyNote ? <Text style={styles.hint}>{copyNote}</Text> : null}
              <Text style={styles.output} selectable>
                {output}
              </Text>
            </>
          ) : null}
        </Section>
      </ScrollView>
    );
  }

  const noPeople = sources.length
    ? pqcPart
      ? 'Nobody in your Guest Book has a +PQC key yet. Swap keys with them in Guest Book.'
      : 'Nobody in your Guest Book has a PGP key yet. Swap keys with them, or add one, in Guest Book.'
    : 'Guest Book is not in this build, so there is nobody to pick.';

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <Section title={part ? PART_TITLE[part] : 'Messages'}>
        {modes.length > 1 ? (
          <Segmented
            options={modes}
            value={mode}
            onChange={next => {
              setMode(next);
              setFile(null);
              setInput('');
              reset();
            }}
          />
        ) : null}
        <Text style={styles.hint}>
          {mode === 'encrypt'
            ? 'Pick who can read it from your Guest Book. Their keys get there when you swap keys in person, scan one, or look one up in Guest Book.'
            : mode === 'verify'
              ? 'The signature is checked against everyone in your Guest Book, and the signer is named.'
              : mode === 'decrypt'
                ? 'Opening needs your key. A signature on the message is checked against your Guest Book.'
                : 'Signing needs your key. Anyone with your public key can check it.'}
        </Text>
      </Section>

      {mode === 'encrypt' ? (
        <Section title="To">
          <ListPicker
            label="To"
            placeholder="Pick people"
            sheetTitle={pqcPart ? 'Encrypt to (+PQC keys)' : 'Encrypt to'}
            tone="guestbook"
            multi
            items={toItems}
            selected={to}
            onChange={pickPeople}
            onOpen={loadPeople}
            empty={noPeople}
          />
          {unverified.length ? (
            <Text style={styles.warn}>
              Not verified: {unverified.join(', ')}. Compare their fingerprint in Guest Book before you trust it.
            </Text>
          ) : null}
          {toNote ? <Text style={styles.hint}>{toNote}</Text> : null}
        </Section>
      ) : null}

      {needsMyKey && pqcPart ? (
        <Section title={`Your key on the device — ${keyName}`} faded={!pqc}>
          {pqc ? null : <Text style={styles.hint}>{missingNote('postQuantum')}</Text>}
          <Text style={styles.hint}>
            A post-quantum composite key (ML-DSA-65 + Ed25519, ML-KEM-768 + X25519) kept on the key.
            Decrypting and signing happen on the key, one button challenge per half.
          </Text>
          <ListPicker
            label="Key"
            placeholder="Pick your key"
            sheetTitle="Your +PQC keys"
            items={kept.map(k => ({key: k.id, title: k.name, detail: `RSA slot ${k.slot}`}))}
            selected={myDeviceKey ? [myDeviceKey] : []}
            onChange={keys => setMyDeviceKey(keys[0] ?? null)}
            empty="No +PQC key on this OnlyKey yet - make one in Key Chain."
            disabled={!pqc}
          />
          <Btn
            title={kept.length ? 'Make another in Key Chain' : 'Make one in Key Chain'}
            disabled={!pqc}
            onPress={() => void openKeyChainWizard(QUANTUM_SAFE_PGP)}
          />
          {challenge ? (
            <>
              <Text style={styles.status}>The key is waiting: press {challenge.join(' - ')} on it.</Text>
              {emu.canPress === true ? <Btn title="Press them for me" onPress={pressChallenge} /> : null}
            </>
          ) : null}
        </Section>
      ) : null}

      {needsMyKey && !pqcPart ? (
        <Section title="Your private key">
          <TextInput
            style={[styles.input, styles.key]}
            value={privateKey}
            onChangeText={setPrivateKey}
            placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
            placeholderTextColor={theme.textDim}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            value={passphrase}
            onChangeText={setPassphrase}
            placeholder="Passphrase, if the key has one"
            placeholderTextColor={theme.textDim}
            secureTextEntry
            autoCapitalize="none"
          />
        </Section>
      ) : null}

      <Section
        title={part === 'file' ? (mode === 'encrypt' ? 'File to encrypt' : 'Encrypted file') : mode === 'encrypt' && !part ? 'Message or file' : 'Input'}
        unavailable={configMode === ON ? NOT_IN_CONFIG_MODE : null}>
        {part === 'file' && !file ? (
          <Text style={styles.body}>
            {mode === 'encrypt' ? 'Pick the file to encrypt.' : 'Pick the .asc file to decrypt.'}
          </Text>
        ) : file ? (
          <View style={styles.row}>
            <Text style={styles.body}>
              {file.name} — {file.bytes.length} bytes
            </Text>
            <Btn title="Clear" onPress={() => { setFile(null); if (mode === 'decrypt') setInput(''); }} />
          </View>
        ) : (
          <TextInput
            style={[styles.input, styles.body_input]}
            value={input}
            onChangeText={setInput}
            placeholder={mode === 'encrypt' || mode === 'sign' ? 'Type a message' : 'Paste the PGP block here'}
            placeholderTextColor={theme.textDim}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
        )}
        <View style={styles.row}>
          <Btn
            title={busy ? 'Working…' : titleFor(mode)}
            tone="primary"
            onPress={run}
            disabled={busy || (mode === 'encrypt' && !picked.length)}
          />
          {filePicking ? <Btn title="Pick a file" onPress={pickFile} /> : null}
        </View>
      </Section>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {status ? <Text style={styles.status}>{status}</Text> : null}

    </ScrollView>
  );
}

function titleFor(mode: Mode): string {
  return mode[0].toUpperCase() + mode.slice(1);
}

/**
 * Turn openpgp's wording into something that names the likely cause.
 *
 * Its messages are accurate and describe the wrong layer - "no decryption key
 * packets found" is true of a public key pasted where a private one was asked
 * for, and sends people looking at the message instead of at the box above it.
 */
function translate(message: string): string {
  if (/decryption key/i.test(message)) {
    return `${message} — is that a PRIVATE key, and does it match the message?`;
  }
  if (/Misformed armored text|Unknown ASCII armor/i.test(message)) {
    return `${message} — the block looks truncated; paste it whole, headers included.`;
  }
  if (/Incorrect key passphrase|passphrase/i.test(message)) {
    return `${message} — the key is locked and the passphrase did not open it.`;
  }
  return message;
}

const styles = StyleSheet.create({
  root: {flex: 1},
  content: {padding: 16, gap: 16, paddingBottom: 48},

  hint: {color: theme.textDim, fontSize: 11, lineHeight: 16, marginTop: 8},
  warn: {color: theme.warn, fontSize: 12, lineHeight: 17, marginTop: 8},
  body: {color: theme.textSecondary, fontSize: 13, flex: 1},
  status: {color: theme.textSecondary, fontSize: 12, lineHeight: 18},
  error: {color: theme.error, fontSize: 13, lineHeight: 20},

  input: {
    color: theme.text,
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    marginTop: 8,
  },
  key: {minHeight: 90, fontFamily: 'monospace', fontSize: 11},
  body_input: {minHeight: 110},

  output: {
    color: theme.textSecondary,
    fontFamily: 'monospace',
    fontSize: 10,
    lineHeight: 14,
    marginTop: 8,
  },
  topbar: {flexDirection: 'row', alignItems: 'center'},
  resultStatus: {color: theme.text, fontSize: 14, lineHeight: 20, marginTop: 4},
  row: {flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap'},
});
