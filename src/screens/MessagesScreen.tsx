import React, {useCallback, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Btn, Section, Segmented} from '../ui/components';
import {theme} from '../ui/theme';
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

export function MessagesScreen() {
  const [mode, setMode] = useState<Mode>('encrypt');
  const [keyText, setKeyText] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

      if (mode === 'encrypt') {
        if (file) {
          const armored = await messages.encryptFile(openpgp, {
            data: file.bytes,
            filename: file.name,
            recipients: keyText,
            armor: true,
          });
          setOutput(String(armored));
          setStatus(`Encrypted ${file.name} (${file.bytes.length} bytes).`);
        } else {
          if (!input) throw new Error('nothing to encrypt');
          const armored = await messages.encryptText(openpgp, {
            text: input,
            recipients: keyText,
          });
          setOutput(String(armored));
          setStatus('Encrypted. Only the holder of that key can read it.');
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
          decryptWith: keyText,
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
          signWith: keyText,
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
      setBusy(false);
    }
  }, [mode, keyText, passphrase, input, file, reset]);

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

      <Section title={KEY_LABEL[mode]}>
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
