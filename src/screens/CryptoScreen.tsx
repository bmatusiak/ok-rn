import React, {useCallback, useRef, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Btn, Section} from '../ui/components';
import {Keypad} from '../ui/Keypad';
import {theme} from '../ui/theme';
import {bytes as okbytes} from 'node-onlykey-lib';
import {useActiveKey} from '../hooks/KeyContext';
import NativeSecrets from '../../specs/NativeSecrets';
import {useSecureScreen} from '../hooks/useSecureScreen';
import type {EmuSession} from '../hooks/useOkEmu';

/*
 * Secrets the key DERIVES rather than stores.
 *
 * A slot holds a password; this does not. The key computes one from a label and
 * a private key that never leaves it, so the same label always gives the same
 * secret and nothing is stored anywhere - lose the phone and the secret is
 * still recoverable from the key, and the key can be wiped without losing a
 * list of what it held.
 *
 * It is two round trips, which is the shape the web app uses: derive the public
 * key for a label, then derive the shared secret between that key and itself.
 * The second value is what the web app presents as a generated password.
 *
 * ## The press is the user's, not ours
 *
 * The device asks for a touch, and this app could answer it - the buttons are
 * emulated and it presses them elsewhere. It deliberately does not. A user
 * presence check that the software satisfies on the user's behalf is not a
 * check; the whole point is that something outside the software agreed. So the
 * keypad appears and waits.
 *
 * Asking for the touchless variant instead is a device setting, not a call
 * option, and it derives a DIFFERENT key - the firmware mixes a byte into the
 * derivation to keep the two apart (ok_extension.cpp:245). Turning it on is
 * offered under Settings, where it belongs.
 */

/** How long a copied secret stays on the clipboard. */
const CLIPBOARD_TTL_MS = 45000;

/** Long enough to notice, short enough not to be left on screen. */
const REVEAL_MS = 15000;

/*
 * The library's own encoders, not the platform's. Hermes has neither
 * TextEncoder nor TextDecoder, and reaching for one is what broke the vault
 * (FINDING-a-global-that-only-exists-in-the-test-runner.md). These are the
 * same helpers the library uses internally, and they are tested with the
 * globals deleted.
 */
const utf8 = (text: string): Uint8Array => okbytes.utf8ToBytes(text);
const fromUtf8 = (b: Uint8Array): string => okbytes.bytesToUtf8(b);
const base64 = (b: Uint8Array): string => okbytes.toBase64(b);
const unbase64 = (text: string): Uint8Array => okbytes.fromBase64(text);

const hex = (bytes: Uint8Array): string => okbytes.toHex(bytes);

export function CryptoScreen({
  emu,
  blockScreenshots = true,
}: {
  emu: EmuSession;
  blockScreenshots?: boolean;
}) {
  /* The ACTIVE key, not whichever one this file used to assume. */
  const getKey = useActiveKey();

  useSecureScreen(blockScreenshots);

  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [derivedFor, setDerivedFor] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* The vault is a second use of the same derivation, so it gets its own
   * label: the service a credential belongs to, not the site a password is
   * for. They are usually the same string and must not be assumed to be. */
  const [service, setService] = useState('');
  const [plaintext, setPlaintext] = useState('');
  const [blob, setBlob] = useState('');
  const [opened, setOpened] = useState<string | null>(null);

  /* age: an identity is derived, a file is text on the way in and out. */
  const [ageLabel, setAgeLabel] = useState('');
  const [recipient, setRecipient] = useState<string | null>(null);
  const [ageText, setAgeText] = useState('');
  const [ageFile, setAgeFile] = useState('');
  const [agePlain, setAgePlain] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false);

  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const locked = emu.device !== 'unlocked';

  const reveal = useCallback(() => {
    setRevealed(true);
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(() => setRevealed(false), REVEAL_MS);
  }, []);

  const derive = useCallback(async () => {
    const site = label.trim();
    if (!site) {
      setError('A label is what the secret is derived from, so it cannot be empty.');
      return;
    }

    setBusy(true);
    setError(null);
    setStatus(null);
    setSecret(null);
    setRevealed(false);
    try {
      const {okcrypto} = await getKey();

      /*
       * The keypad is shown from the KEEPALIVE, not before it. The device only
       * starts watching its buttons once the ceremony is under way, so a press
       * made earlier is a press that types a slot instead.
       */
      const onKeepAlive = async () => setWaiting(true);

      const pub = await okcrypto.derivePublicKey(site, {
        requirePress: true,
        timeoutMs: 60000,
        onKeepAlive,
      });
      setWaiting(false);

      const shared = await okcrypto.deriveSharedSecret(site, pub.publicKey, {
        requirePress: true,
        timeoutMs: 60000,
        onKeepAlive,
      });
      setWaiting(false);

      /*
       * .secret, not .publicKey. The response carries BOTH - the public key and
       * then the 32-byte secret - and the public one is not the password.
       *
       * Rendered as BASE64URL, not hex. The password the other clients show is
       * a JWK `k` member (build_AESGCM, onlykey-3rd-party.js:95), and RFC 7517
       * says that is unpadded base64url of the raw key. Showing hex gave a
       * different password for the same site with nothing to indicate it - both
       * strings look like a perfectly good password, and only one of them logs
       * you in. Cross-checked against WebCrypto's own JWK export.
       */
      setSecret(okbytes.toBase64Url(shared.secret));
      setDerivedFor(site);
      setStatus(`Derived from "${site}". The key will give the same answer next time.`);
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      /*
       * The one refusal worth translating. The device says the extension is
       * not supported when what is actually clear is a preference bit, and
       * that sends people looking at the wrong thing entirely.
       */
      setError(
        /EXTENSION_NOT_SUPPORTED/i.test(message)
          ? 'The key refused: it says "extension not supported", which means the ' +
              'derived-key challenge setting is off rather than that the firmware ' +
              'lacks the feature. Set it under Settings → Advanced.'
          : message,
      );
    } finally {
      setWaiting(false);
      setBusy(false);
    }
  }, [getKey, label]);

  const copy = useCallback(async () => {
    if (!secret) return;
    try {
      await NativeSecrets.copySensitive(secret, CLIPBOARD_TTL_MS);
      setStatus(`Copied. It clears in ${Math.round(CLIPBOARD_TTL_MS / 1000)} seconds.`);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, [secret]);

  /*
   * Both vault calls derive the key if it is not cached, and deriving needs
   * a touch - so they raise the same keypad the password generator does.
   */
  const vaultOpts = useCallback(
    () => ({
      requirePress: true,
      timeoutMs: 60000,
      onKeepAlive: async () => setWaiting(true),
    }),
    [],
  );

  const seal = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    setOpened(null);
    try {
      const {okcrypto} = await getKey();
      const sealed = await okcrypto.deviceVault.seal(service.trim(), plaintext, vaultOpts());
      setWaiting(false);
      setBlob(sealed);
      setPlaintext('');
      setUnlocked(okcrypto.deviceVault.isUnlocked(service.trim()));
      setStatus('Sealed. Only this key can open it, and only for this service name.');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setWaiting(false);
      setBusy(false);
    }
  }, [getKey, service, plaintext, vaultOpts]);

  const unseal = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    setOpened(null);
    try {
      const {okcrypto} = await getKey();
      const text = await okcrypto.deviceVault.open(service.trim(), blob.trim(), vaultOpts());
      setWaiting(false);
      setOpened(text);
      setUnlocked(okcrypto.deviceVault.isUnlocked(service.trim()));
    } catch (e) {
      const message = String((e as Error)?.message ?? e);

      /*
       * AES-GCM cannot tell a wrong key from a tampered blob, so for a TAG
       * failure this says so and stops. But it must not swallow everything: a
       * device that refused, a channel that died or a malformed blob are
       * different failures with different fixes, and reporting them all as
       * "wrong service name" sends the user to the one place the problem is
       * not. The first version of this did exactly that, and hid its own bug.
       */
      setError(
        /tag|decrypt|auth/i.test(message)
          ? 'That did not open. Either the service name is not the one it was '
            + 'sealed under, or the blob has been altered — there is no way to '
            + 'tell which.'
          : message,
      );
    } finally {
      setWaiting(false);
      setBusy(false);
    }
  }, [getKey, service, blob, vaultOpts]);

  const lock = useCallback(async () => {
    const {okcrypto} = await getKey();
    okcrypto.deviceVault.lock(service.trim());
    setUnlocked(false);
    setOpened(null);
    setStatus('Key forgotten. The next use touches the device again.');
  }, [getKey, service]);

  const ageIdentity = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const {okcrypto} = await getKey();
      const id = await okcrypto.deviceAge.identity(ageLabel.trim(), vaultOpts());
      setWaiting(false);
      setRecipient(id.recipientString);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setWaiting(false);
      setBusy(false);
    }
  }, [getKey, ageLabel, vaultOpts]);

  const ageEncrypt = useCallback(async () => {
    if (!recipient) return;
    setBusy(true);
    setError(null);
    setAgePlain(null);
    try {
      const {okcrypto} = await getKey();
      /*
       * No device call here at all - encrypting to a recipient is public
       * work. The base64 is only so the file can live in a text box.
       */
      const bytes = okcrypto.deviceAge.encrypt(utf8(ageText), recipient);
      setAgeFile(base64(bytes));
      setAgeText('');
      setStatus('Encrypted. Only this key can read it.');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [getKey, recipient, ageText]);

  const ageDecrypt = useCallback(async () => {
    setBusy(true);
    setError(null);
    setAgePlain(null);
    try {
      const {okcrypto} = await getKey();
      const out = await okcrypto.deviceAge.decrypt(
        unbase64(ageFile.trim()),
        ageLabel.trim(),
        vaultOpts(),
      );
      setWaiting(false);
      setAgePlain(fromUtf8(out));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setWaiting(false);
      setBusy(false);
    }
  }, [getKey, ageFile, ageLabel, vaultOpts]);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <Section title="Derived secrets">
        <Text style={styles.body}>
          The key computes a secret from a label and a private key that never
          leaves it. Nothing is stored: the same label always gives the same
          answer, and there is no list of labels on the key to lose or leak.
        </Text>
        <Text style={styles.note}>
          Use something stable and specific — a domain is the usual choice.
          Changing so much as a letter derives an unrelated secret, and there is
          no way to search for the one you meant.
        </Text>

        <TextInput
          value={label}
          onChangeText={setLabel}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="example.com"
          placeholderTextColor={theme.textDim}
          editable={!busy}
          style={styles.input}
        />
        <Btn
          title={busy ? 'Deriving…' : 'Derive'}
          tone="primary"
          disabled={busy || locked || !label.trim()}
          onPress={derive}
        />
        {locked ? <Text style={styles.note}>Unlock the key first.</Text> : null}
      </Section>

      {waiting ? (
        <Section title="The key is waiting for a button">
          <Text style={styles.body}>
            Press any button to approve this derivation. The app will not press
            it for you — a presence check the software answers on your behalf is
            not a check.
          </Text>
          {/* A hard key's buttons are on the key; a pad here could not reach them. */}
          {emu.canPress === true ? <Keypad onPress={emu.press} /> : null}
        </Section>
      ) : null}

      {status ? <Text style={styles.status}>{status}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {secret ? (
        <Section title={`Secret for ${derivedFor}`}>
          <Text style={styles.secret}>
            {revealed ? secret : '•'.repeat(48)}
          </Text>
          <View style={styles.row}>
            <Btn
              title={revealed ? 'Hide' : 'Reveal'}
              onPress={() => (revealed ? setRevealed(false) : reveal())}
            />
            <Btn title="Copy" tone="primary" onPress={copy} />
          </View>
          <Text style={styles.note}>
            Revealed for {Math.round(REVEAL_MS / 1000)} seconds, then hidden
            again. Copying marks it sensitive, so the clipboard preview shows
            dots rather than the value.
          </Text>
        </Section>
      ) : null}

      <Section title="Vault">
        <Text style={styles.body}>
          Seal a note under a key the device derives for a service name. The key
          is never stored anywhere — not on the phone and not on the key — so a
          sealed blob is safe to keep in a normal file, and useless without the
          OnlyKey that made it.
        </Text>
        <Text style={styles.note}>
          The service name is part of the key. Sealing under "github" and trying
          to open under "github.com" fails, and cannot say why.
        </Text>

        <TextInput
          value={service}
          onChangeText={t => {
            setService(t);
            setUnlocked(false);
            setOpened(null);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="service name"
          placeholderTextColor={theme.textDim}
          editable={!busy}
          style={styles.input}
        />

        {unlocked ? (
          <View style={styles.row}>
            <Text style={styles.cached}>key cached</Text>
            <Btn title="Forget it" onPress={lock} />
          </View>
        ) : null}

        <TextInput
          value={plaintext}
          onChangeText={setPlaintext}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          placeholder="something to seal"
          placeholderTextColor={theme.textDim}
          editable={!busy}
          style={styles.textarea}
        />
        <Btn
          title={busy ? 'Working…' : 'Seal'}
          tone="primary"
          disabled={busy || locked || !service.trim() || !plaintext}
          onPress={seal}
        />

        <TextInput
          value={blob}
          onChangeText={setBlob}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          placeholder="a sealed blob, to open"
          placeholderTextColor={theme.textDim}
          editable={!busy}
          style={styles.textarea}
        />
        <Btn
          title={busy ? 'Working…' : 'Open'}
          disabled={busy || locked || !service.trim() || !blob.trim()}
          onPress={unseal}
        />

        {opened !== null ? (
          <>
            <Text style={styles.note}>Opened:</Text>
            <Text style={styles.secret}>{opened}</Text>
          </>
        ) : null}
      </Section>

      <Section title="Encrypted files (age)">
        <Text style={styles.body}>
          An age identity split between this key and the host: the X25519 half
          never leaves the key, and the post-quantum half travels as a seed the
          host expands itself. Both must agree, so a file needs the key AND the
          label to open.
        </Text>

        <TextInput
          value={ageLabel}
          onChangeText={t => {
            setAgeLabel(t);
            setRecipient(null);
            setAgePlain(null);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="identity label"
          placeholderTextColor={theme.textDim}
          editable={!busy}
          style={styles.input}
        />
        <Btn
          title={busy ? 'Working…' : 'Get the recipient'}
          tone="primary"
          disabled={busy || locked || !ageLabel.trim()}
          onPress={ageIdentity}
        />

        {recipient ? (
          <>
            <Text style={styles.note}>
              Anyone can encrypt to this. It is public, and it is the only thing
              a sender needs — no key, no app.
            </Text>
            {/*
              * ABBREVIATED ON PURPOSE. An X-Wing recipient is 1216 bytes, so
              * bech32 makes it about two thousand characters - printed in full
              * it buries every control on the screen and is no more readable
              * for being complete. Nobody transcribes one of these by eye; they
              * copy it.
              */}
            <Text style={styles.secret}>
              {recipient.slice(0, 28)}…{recipient.slice(-12)}
            </Text>
            <Text style={styles.note}>{recipient.length} characters</Text>
            <Btn
              title="Copy the recipient"
              onPress={async () => {
                await NativeSecrets.copySensitive(recipient, CLIPBOARD_TTL_MS);
                setStatus('Recipient copied.');
              }}
            />

            <TextInput
              value={ageText}
              onChangeText={setAgeText}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="something to encrypt"
              placeholderTextColor={theme.textDim}
              editable={!busy}
              style={styles.textarea}
            />
            <Btn
              title={busy ? 'Working…' : 'Encrypt'}
              disabled={busy || !ageText}
              onPress={ageEncrypt}
            />
          </>
        ) : null}

        <TextInput
          value={ageFile}
          onChangeText={setAgeFile}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="an encrypted file, base64"
          placeholderTextColor={theme.textDim}
          editable={!busy}
          style={styles.textarea}
        />
        <Btn
          title={busy ? 'Working…' : 'Decrypt'}
          disabled={busy || locked || !ageLabel.trim() || !ageFile.trim()}
          onPress={ageDecrypt}
        />

        {agePlain !== null ? (
          <>
            <Text style={styles.note}>Decrypted:</Text>
            <Text style={styles.secret}>{agePlain}</Text>
          </>
        ) : null}
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  content: {padding: 16, gap: 16, paddingBottom: 48},

  body: {color: theme.textSecondary, fontSize: theme.fontSize, lineHeight: theme.lineHeight},
  note: {color: theme.textDim, fontSize: 12, lineHeight: 18},
  status: {color: theme.ok, fontSize: 13, lineHeight: 20},
  error: {color: theme.error, fontSize: 13, lineHeight: 20},

  secret: {
    color: theme.text,
    fontSize: 12,
    fontFamily: theme.mono,
    lineHeight: 18,
  },

  row: {flexDirection: 'row', gap: 8, alignItems: 'center'},
  cached: {color: theme.ok, fontSize: 12, flex: 1},

  textarea: {
    minHeight: 72,
    textAlignVertical: 'top',
    color: theme.text,
    fontSize: 12,
    fontFamily: theme.mono,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.inputBg,
  },

  input: {
    color: theme.text,
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.inputBg,
  },
});
