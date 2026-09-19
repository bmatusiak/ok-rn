import React, {useCallback, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Btn, Section, Segmented} from '../ui/components';
import {missingNote, supports} from '../firmwareFeatures';
import type {Overrides} from '../capabilityOverride';
import {theme} from '../ui/theme';
import {ConfigModeBlocked} from '../ui/ConfigModeBlocked';
import {lookup, type Found, type Source} from '../keySearch';
import {splitPublicKeys, summarizeKey, type KeySummary} from '../armoredKeys';
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
 *
 * ## Keys are PASTED, for now
 *
 * The device holds composite private keys and can decrypt with them, but
 * nothing persists a key between launches yet, so there is no "my key" to
 * offer. Pasting a key is also exactly what the web pages do. When storage
 * lands, this screen gains a key picker and the paste box becomes the fallback
 * rather than the only route.
 */

type Mode = 'encrypt' | 'decrypt' | 'sign' | 'verify';

const MODES: Mode[] = ['encrypt', 'decrypt', 'sign', 'verify'];

/** What each mode calls the key box, so the label is never wrong for the task. */
const KEY_LABEL: Record<Mode, string> = {
  encrypt: "Recipient's public key",
  decrypt: 'Your private key',
  sign: 'Your private key',
  verify: "Signer's public key",
};

/* Where a public key can be looked up - the web app's search page's three. */
/**
 * The recipient keys in the box, as a list.
 *
 * The web app encrypts to several people at once and this took one key;
 * the library's encryptText has always accepted an array. A box with no
 * armour headers is passed through as-is so the error a caller gets is
 * openpgp's own ("Misformed armored text"), which says more about a
 * mangled paste than anything invented here would.
 */
function recipientKeys(text: string): string | string[] {
  const blocks = splitPublicKeys(text);
  return blocks.length ? blocks : text;
}

const SOURCES: Source[] = ['keybase', 'protonmail', 'url'];
const SOURCE_LABEL: Record<Source, string> = {keybase: 'Keybase', protonmail: 'ProtonMail', url: 'URL'};
const SOURCE_PLACEHOLDER: Record<Source, string> = {
  keybase: 'username or name',
  protonmail: 'address, or 0x + key id',
  url: 'https://…/key.asc',
};

/** RSA slots 1-4 are where a composite key lives, as the reference CLI's setpqc puts it. */
const RSA_SLOTS = ['1', '2', '3', '4'] as const;

export function MessagesScreen({
  emu,
  configMode = false,
  overrides,
}: {
  emu: EmuSession;
  /** Signing and decryption are refused in config mode - okcore.cpp:347. */
  configMode?: boolean;
  /** Forced capabilities, if any. See src/capabilityOverride.ts. */
  overrides?: Overrides;
}) {
  /* The ACTIVE key, for the composite key that lives on the device. */
  const getKey = useActiveKey();
  const keyName = useKeyName();

  const [mode, setMode] = useState<Mode>('encrypt');

  /*
   * THE COMPOSITE KEY ON THE DEVICE.
   *
   * The web app's composite page ends by printing a CLI command to copy,
   * because a browser cannot load a private key onto the key. This app can:
   * generate (on the phone, with the vendored fork), load the 160-byte seed
   * blob into an RSA slot over the vendor interface (OKSETPRIV, type 0x67,
   * the same op and the same slots python-onlykey's setpqc uses), and then
   * decrypt and sign THROUGH the device - openpgp's private-key operations
   * are routed to it by the fork's hardware hooks, and the private material
   * never exists on the phone once the blob is gone.
   */
  const [generated, setGenerated] = useState<{armoredPublicKey: string} | null>(null);
  const blobRef = React.useRef<Uint8Array | null>(null);
  const [rsaSlot, setRsaSlot] = useState<(typeof RSA_SLOTS)[number]>('1');
  const [onDevice, setOnDevice] = useState(false);
  const [challenge, setChallenge] = useState<number[] | null>(null);
  const [keyText, setKeyText] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  /*
   * ONLINE LOOKUP, and only on the press. The web app searches Keybase and
   * ProtonMail for a recipient's key; this app is air-gapped by default, so
   * the network is touched exactly when "Look up online" is pressed and
   * never because a screen opened or a box changed (src/keySearch.ts). One
   * match fills the key box; several are listed for the person to pick.
   */
  /*
   * WHAT THAT KEY ACTUALLY IS. A key fetched by pressing one button has had
   * nothing verify it, and a box of base64 cannot be compared with a
   * fingerprint someone read out to you. The web app's search page shows
   * this beside every result; here it is on request, for whatever is in the
   * box - fetched or pasted.
   */
  const [summaries, setSummaries] = useState<KeySummary[] | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const describeKeys = useCallback(async () => {
    setSummaryError(null);
    setSummaries(null);
    try {
      const openpgp = require('node-onlykey-lib/crypto/pgp');
      const blocks = splitPublicKeys(keyText);
      if (!blocks.length) throw new Error('No public key block in the box.');
      setSummaries(await Promise.all(blocks.map(b => summarizeKey(openpgp, b))));
    } catch (e) {
      setSummaryError(String((e as Error)?.message ?? e));
    }
  }, [keyText]);

  const [lookupSource, setLookupSource] = useState<Source>('keybase');
  const [lookupQuery, setLookupQuery] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupFound, setLookupFound] = useState<Found[] | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const runLookup = useCallback(async () => {
    setLookupBusy(true);
    setLookupError(null);
    setLookupFound(null);
    try {
      const found = await lookup(lookupSource, lookupQuery, url => fetch(url));
      setLookupFound(found);
      if (found.length === 1) setKeyText(found[0].armored);
    } catch (e) {
      setLookupError(String((e as Error)?.message ?? e));
    } finally {
      setLookupBusy(false);
    }
  }, [lookupSource, lookupQuery]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * Faded when the attached key's firmware has no post-quantum support, which
   * is EVERY released firmware - see src/firmwareFeatures.ts. Only the
   * composite-key section is gated: the rest of this screen is ordinary PGP
   * with keys the phone holds, and that works on any key at all.
   */
  const pqc = supports(emu.capabilities, 'postQuantum', overrides);

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
    try {
      // Lazy, and only reachable once the WebCrypto shim is installed.
      const openpgp = require('node-onlykey-lib/crypto/pgp');
      const messages = okpure.messages;

      if (!keyText.trim()) {
        throw new Error(`${KEY_LABEL[mode]} is empty`);
      }

      /*
       * DEVICE-BACKED: the pasted key is the PUBLIC half, and the fork is
       * handed a placeholder private key whose secret scalars are marked
       * hardware-backed. Its hooks then call the device for the X25519 and
       * ML-KEM halves of a decrypt and both halves of a signature; the
       * device raises a three-button challenge for each and this screen
       * shows the digits. The hooks are cleared afterwards so a later
       * generate is not hijacked (see composite_pgp.js on hooks.signer).
       */
      let deviceKey: unknown = null;
      if (onDevice && (mode === 'decrypt' || mode === 'sign')) {
        const {okcrypto} = await getKey();
        const pub = await openpgp.readKey({armoredKey: keyText});
        deviceKey = openpgp.createHardwarePrivateKey(pub);
        okcrypto.registerPgpHooks(openpgp, Number(rsaSlot));
        okcrypto.on('challenge', ({digits}: {digits: number[]}) => setChallenge(digits));
      }

      if (mode === 'encrypt') {
        if (file) {
          const armored = await messages.encryptFile(openpgp, {
            data: file.bytes,
            filename: file.name,
            recipients: recipientKeys(keyText),
            armor: true,
          });
          setOutput(String(armored));
          setStatus(`Encrypted ${file.name} (${file.bytes.length} bytes).`);
        } else {
          if (!input) throw new Error('nothing to encrypt');
          const to = recipientKeys(keyText);
          const armored = await messages.encryptText(openpgp, {
            text: input,
            recipients: to,
          });
          setOutput(String(armored));
          setStatus(
            to.length > 1
              ? `Encrypted to ${to.length} keys. Any one of them can read it.`
              : 'Encrypted. Only the holder of that key can read it.',
          );
        }
        return;
      }

      if (mode === 'decrypt') {
        if (!input.trim()) throw new Error('paste a PGP message, or pick a file');
        const kind = messages.classifyArmor(input);
        if (kind !== 'message') {
          throw new Error(`that is a ${kind}, not a PGP message`);
        }
        const result = await messages.decryptMessage(openpgp, {
          armored: input,
          decryptWith: deviceKey ?? keyText,
          passphrase: passphrase || null,
        });

        /*
         * A decrypted FILE is bytes and may not be text at all, so it is
         * offered as a file rather than printed into a box that would show
         * mojibake.
         */
        setOutput(typeof result.data === 'string' ? result.data : '');
        const signed = describeSignatures(result.signatures);
        setStatus(
          result.filename && result.filename !== 'msg.txt'
            ? `Decrypted "${result.filename}".${signed}`
            : `Decrypted.${signed}`,
        );
        return;
      }

      if (mode === 'sign') {
        if (!input) throw new Error('nothing to sign');
        const signed = await messages.signText(openpgp, {
          text: input,
          signWith: deviceKey ?? keyText,
          passphrase: passphrase || null,
        });
        setOutput(String(signed));
        setStatus('Signed. The text stays readable inside the signature.');
        return;
      }

      // verify
      if (!input.trim()) throw new Error('paste a signed message');
      const result = await messages.verifyText(openpgp, {
        armored: input,
        verifyWith: keyText,
      });
      setOutput(typeof result.data === 'string' ? result.data : '');
      setStatus(
        result.valid
          ? `Signature is GOOD (${result.signatures.length} checked).`
          : `Signature is NOT valid.${describeSignatures(result.signatures)}`,
      );
    } catch (e) {
      setError(translate(String((e as Error)?.message ?? e)));
    } finally {
      setChallenge(null);
      if (onDevice) {
        try { require('node-onlykey-lib/crypto/pgp').clearHardwareHooks(); } catch { /* not loaded */ }
      }
      setBusy(false);
    }
  }, [mode, keyText, passphrase, input, file, reset, onDevice, rsaSlot, getKey]);

  /** Generate a composite key on the phone; the blob waits in memory for a load. */
  const generate = useCallback(async () => {
    reset();
    setBusy(true);
    try {
      const openpgp = require('node-onlykey-lib/crypto/pgp');
      const {okcrypto} = await getKey();
      const result = await okcrypto.composite.generateCompositeKey(openpgp, {
        userId: {name: 'OnlyKey', email: 'onlykey@example.invalid'},
      });
      blobRef.current = result.blob;
      setGenerated({armoredPublicKey: String(result.armoredPublicKey)});
      setKeyText(String(result.armoredPublicKey));
      setStatus('Generated. Load it onto the key, then only the key can use it.');
    } catch (e) {
      setError(translate(String((e as Error)?.message ?? e)));
    } finally {
      setBusy(false);
    }
  }, [getKey, reset]);

  /**
   * Load the blob into an RSA slot. OKSETPRIV is allowed only in config mode
   * (or on a key that has never been set up); outside it the device answers
   * "Error not in config mode" and the library reports that by name.
   * On success the blob is zeroed here: from then on the key is the only
   * holder.
   */
  const load = useCallback(async () => {
    const blob = blobRef.current;
    if (!blob) return;
    reset();
    setBusy(true);
    try {
      const {device, okcrypto} = await getKey();
      await device.loadKey(Number(rsaSlot), {type: okcrypto.composite.PQC_KEY_TYPE_BYTE, key: blob});
      blob.fill(0);
      blobRef.current = null;
      setOnDevice(true);
      setStatus(`Loaded into RSA slot ${rsaSlot}. The private half now exists only on the key.`);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [getKey, reset, rsaSlot]);

  /** Press the challenge digits through the key's console, when it takes presses. */
  const pressChallenge = useCallback(async () => {
    if (!challenge) return;
    for (const digit of challenge) await emu.press(digit);
  }, [challenge, emu]);

  const pickFile = useCallback(async () => {
    reset();
    try {
      const picked = await NativeShare.pickTextFile('*/*');
      if (!picked.picked) {
        return;
      }
      setFile({name: picked.name, bytes: okbytes.utf8ToBytes(picked.content)});
      setInput('');
      setStatus(`Picked ${picked.name}. It will be encrypted as a file.`);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, [reset]);

  const share = useCallback(async () => {
    if (!output) {
      return;
    }
    try {
      await NativeShare.shareFile(
        mode === 'encrypt' ? 'message.asc' : 'message.txt',
        output,
        mode === 'encrypt' ? 'application/pgp-encrypted' : 'text/plain',
        'PGP',
      );
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, [output, mode]);

  const copy = useCallback(async () => {
    if (!output) {
      return;
    }
    // Sixty seconds, as everywhere else that copies something sensitive.
    await NativeSecrets.copySensitive(output, 60000);
    setStatus('Copied. The clipboard clears itself in a minute.');
  }, [output]);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <ConfigModeBlocked active={configMode} what="sign or decrypt">
      <Section title="Messages">
        <Segmented
          options={MODES}
          value={mode}
          onChange={next => {
            setMode(next);
            setFile(null);
            reset();
          }}
        />
        <Text style={styles.hint}>
          PGP over composite post-quantum keys. Encrypting needs only the other
          person's public key; reading needs a private one.
        </Text>
      </Section>

      <Section title={`Composite key on the device — ${keyName}`} faded={!pqc}>
        {pqc ? null : <Text style={styles.hint}>{missingNote('postQuantum')}</Text>}
        <Text style={styles.hint}>
          A post-quantum composite key (ML-DSA-65 + Ed25519, ML-KEM-768 +
          X25519) made here and kept on the key. Decrypting and signing then
          happen on the key, one button challenge per half.
        </Text>
        <View style={styles.row}>
          <Btn
            title={busy ? 'Working…' : 'Generate'}
            onPress={generate}
            disabled={busy || !pqc}
          />
          <Btn
            title="Load onto the key"
            tone="primary"
            disabled={busy || !pqc || !blobRef.current}
            onPress={load}
          />
        </View>
        <Text style={styles.hint}>RSA slot to hold it</Text>
        <Segmented options={RSA_SLOTS} value={rsaSlot} onChange={setRsaSlot} />
        {generated ? (
          <Text style={styles.hint}>
            The public key is in the key box below; copy it from there. Loading
            needs config mode on the key.
          </Text>
        ) : null}
        <Btn
          title={onDevice ? 'Using the key on the device for decrypt and sign' : 'Use the key on the device for decrypt and sign'}
          tone={onDevice ? 'primary' : undefined}
          disabled={!pqc}
          onPress={() => setOnDevice(v => !v)}
        />
        {onDevice ? (
          <Text style={styles.hint}>
            Paste the composite PUBLIC key below; the private half is on RSA
            slot {rsaSlot}.
          </Text>
        ) : null}
        {challenge ? (
          <>
            <Text style={styles.status}>
              The key is waiting: press {challenge.join(' - ')} on it.
            </Text>
            {emu.canPress === true ? (
              <Btn title="Press them for me" onPress={pressChallenge} />
            ) : null}
          </>
        ) : null}
      </Section>

      <Section title={KEY_LABEL[mode]}>
        {mode === 'encrypt' || mode === 'verify' ? (
          <View style={styles.lookup}>
            <Text style={styles.lookupHint}>
              Paste the key below, or look it up online — only when you press
              the button; this app never goes online on its own.
            </Text>
            <Segmented
              value={SOURCE_LABEL[lookupSource]}
              options={SOURCES.map(s => SOURCE_LABEL[s])}
              onChange={label => setLookupSource(SOURCES.find(s => SOURCE_LABEL[s] === label) ?? 'keybase')}
            />
            <TextInput
              style={styles.input}
              value={lookupQuery}
              onChangeText={setLookupQuery}
              placeholder={SOURCE_PLACEHOLDER[lookupSource]}
              placeholderTextColor={theme.textDim}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Btn
              title={lookupBusy ? 'Looking…' : 'Look up online'}
              disabled={lookupBusy || !lookupQuery.trim()}
              onPress={() => void runLookup()}
            />
            {lookupError ? <Text style={styles.lookupError}>{lookupError}</Text> : null}
            {lookupFound && lookupFound.length === 0 ? (
              <Text style={styles.lookupHint}>Nothing found there.</Text>
            ) : null}
            {lookupFound && lookupFound.length > 1
              ? lookupFound.map(f => (
                  <Btn
                    key={f.where}
                    title={`Use ${f.label}`}
                    tone={keyText === f.armored ? 'primary' : 'default'}
                    onPress={() => setKeyText(f.armored)}
                  />
                ))
              : null}
            {lookupFound && lookupFound.length === 1 ? (
              <Text style={styles.lookupHint}>Filled in from {lookupFound[0].where}</Text>
            ) : null}
          </View>
        ) : null}
        <TextInput
          style={[styles.input, styles.key]}
          value={keyText}
          onChangeText={setKeyText}
          placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
          placeholderTextColor={theme.textDim}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
        />
        {mode === 'encrypt' || mode === 'verify' ? (
          <>
            <Btn
              title="What is this key?"
              disabled={!keyText.trim()}
              onPress={() => void describeKeys()}
            />
            <Text style={styles.lookupHint}>
              Nothing has verified a key you fetched. Compare the fingerprint
              with one you were given some other way before you trust it.
              {mode === 'encrypt'
                ? ' Paste more than one key to encrypt to several people.'
                : ''}
            </Text>
            {summaryError ? <Text style={styles.lookupError}>{summaryError}</Text> : null}
            {summaries
              ? summaries.map((k, i) => (
                  <View key={k.fingerprint} style={styles.keyCard}>
                    <Text style={styles.keyCardTitle}>
                      {summaries.length > 1 ? `${i + 1}. ` : ''}
                      {k.users.length ? k.users.join(', ') : 'no user id on this key'}
                    </Text>
                    <Text style={styles.keyCardLine}>{k.fingerprint}</Text>
                    <Text style={styles.lookupHint}>
                      {k.algorithm}
                      {k.created ? `, created ${k.created}` : ''}
                    </Text>
                  </View>
                ))
              : null}
          </>
        ) : null}
        {mode === 'decrypt' || mode === 'sign' ? (
          <TextInput
            style={styles.input}
            value={passphrase}
            onChangeText={setPassphrase}
            placeholder="Passphrase, if the key has one"
            placeholderTextColor={theme.textDim}
            secureTextEntry
            autoCapitalize="none"
          />
        ) : null}
      </Section>

      <Section title={mode === 'encrypt' ? 'Message or file' : 'Input'}>
        {file ? (
          <View style={styles.row}>
            <Text style={styles.body}>
              {file.name} — {file.bytes.length} bytes
            </Text>
            <Btn title="Clear" onPress={() => setFile(null)} />
          </View>
        ) : (
          <TextInput
            style={[styles.input, styles.body_input]}
            value={input}
            onChangeText={setInput}
            placeholder={
              mode === 'encrypt' ? 'Type a message' : 'Paste the PGP block here'
            }
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
            disabled={busy}
          />
          {mode === 'encrypt' ? <Btn title="Pick a file" onPress={pickFile} /> : null}
        </View>
      </Section>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {status ? <Text style={styles.status}>{status}</Text> : null}

      {output ? (
        <Section title="Result">
          <Text style={styles.output} selectable>
            {output}
          </Text>
          <View style={styles.row}>
            <Btn title="Copy" onPress={copy} />
            <Btn title="Share" onPress={share} />
          </View>
        </Section>
      ) : null}
      </ConfigModeBlocked>
    </ScrollView>
  );
}

function titleFor(mode: Mode): string {
  return mode[0].toUpperCase() + mode.slice(1);
}

/** A sentence about the signatures, or nothing when there were none. */
function describeSignatures(
  signatures: Array<{valid: boolean; error: string | null}>,
): string {
  if (!signatures || !signatures.length) {
    return '';
  }
  const good = signatures.filter(s => s.valid).length;
  if (good === signatures.length) {
    return ` Signature verified (${good}).`;
  }
  const why = signatures.find(s => s.error)?.error;
  return ` Signature NOT verified${why ? `: ${why}` : ''}.`;
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
  lookup: {marginBottom: 10, gap: 8},
  lookupHint: {color: theme.textDim, fontSize: 11, lineHeight: 16},
  lookupError: {color: theme.warn, fontSize: 12, lineHeight: 17},
  keyCard: {
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
    gap: 3,
  },
  keyCardTitle: {color: theme.text, fontSize: 13, fontWeight: '600'},
  keyCardLine: {color: theme.textSecondary, fontSize: 11, fontFamily: 'monospace'},
  body_input: {minHeight: 110},

  output: {
    color: theme.textSecondary,
    fontFamily: 'monospace',
    fontSize: 10,
    lineHeight: 14,
    marginTop: 8,
  },
  row: {flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap'},
});
