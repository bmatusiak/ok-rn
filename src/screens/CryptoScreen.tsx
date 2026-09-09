import React, {useCallback, useRef, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Btn, Section} from '../ui/components';
import {Keypad} from '../ui/Keypad';
import {theme} from '../ui/theme';
import {getOnlyKey} from '../onlykey';
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

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

export function CryptoScreen({
  emu,
  blockScreenshots = true,
}: {
  emu: EmuSession;
  blockScreenshots?: boolean;
}) {
  useSecureScreen(blockScreenshots);

  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [derivedFor, setDerivedFor] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      const {okcrypto} = await getOnlyKey();

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
       */
      setSecret(hex(shared.secret));
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
  }, [label]);

  const copy = useCallback(async () => {
    if (!secret) return;
    try {
      await NativeSecrets.copySensitive(secret, CLIPBOARD_TTL_MS);
      setStatus(`Copied. It clears in ${Math.round(CLIPBOARD_TTL_MS / 1000)} seconds.`);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, [secret]);

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
          <Keypad onPress={emu.press} />
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

  row: {flexDirection: 'row', gap: 8},

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
