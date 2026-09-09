import React, {useCallback, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Btn, Section, Segmented} from '../ui/components';
import {theme} from '../ui/theme';
import {getOnlyKey} from '../onlykey';
import {PinScreen} from './PinScreen';
import {useConfigMode} from '../hooks/useConfigMode';
import type {EmuSession} from '../hooks/useOkEmu';

/*
 * Loading keys onto the device.
 *
 * THIS IS NOT ONE ACTION, and the screen is shaped around that rather than
 * hiding it. Three firmware facts compose into a flow that cannot complete in
 * one sitting (FINDING-loading-a-key-requires-config-mode.md):
 *
 *   OKSETPRIV is accepted only in config mode      okcore.cpp:452
 *   entering config mode LOCKS the device          OnlyKey.ino:914-926
 *   OKSIGN is not on the config-mode allowlist     okcore.cpp:347
 *   and configmode is never cleared but by a boot  okcore.cpp:161
 *
 * So: hold button 6, enter the PIN again, write the keys, restart. The desktop
 * app tells you to do the hold yourself because on hardware it cannot press
 * your key. Here the app IS the key, so it does the hold - which is the one
 * place in this codebase that deliberately asks for the gesture band.
 *
 * Saying all of that up front is the point. The alternative is someone loading
 * a key, watching it succeed, and finding the slot empty when they try to use
 * it - which is what happens if you stop before the restart.
 */

/** Where the firmware will accept a key. RSA 1-4, ECC 101-110. */
const RSA_SLOTS = [1, 2, 3, 4];
const ECC_SLOTS = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];

/* Segmented renders the value, so these read as labels. */
const MODES = ['PGP', 'Raw hex'] as const;
type Mode = (typeof MODES)[number];

export function KeysScreen({emu}: {emu: EmuSession}) {
  const [mode, setMode] = useState<Mode>('PGP');
  const [slot, setSlot] = useState<number>(101);
  const [passphrase, setPassphrase] = useState('');
  const [armored, setArmored] = useState('');
  const [hex, setHex] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const locked = emu.device !== 'unlocked';

  /*
   * The config-mode sequence lives in one place: it is three firmware quirks
   * deep (the hold locks the device, the unlock is never announced, and the
   * mode ends only at a restart) and the Backup screen needs exactly the same
   * thing to set a passphrase.
   */
  const config = useConfigMode(emu.device);
  const loadPgp = useCallback(async () => {
    setBusy('pgp');
    setError(null);
    setStatus(null);
    try {
      /*
       * Required lazily. The PGP fork is 1.2 MB parsed and nothing else in the
       * app needs it, so importing at module scope would make every launch pay
       * for a screen most people never open.
       */
      const openpgp = require('node-onlykey-lib/crypto/pgp');

      let key = await openpgp.readPrivateKey({armoredKey: armored.trim()});
      if (!key.isDecrypted()) {
        if (!passphrase) {
          setError('This key is encrypted. Enter its passphrase.');
          return;
        }
        key = await openpgp.decryptKey({privateKey: key, passphrase});
      }

      const {device} = await getOnlyKey();
      const applied = await device.loadPgpKey(key);
      setLoaded(true);
      setStatus(
        `Loaded ${applied
          .map((a: {role: string; slot: number}) => `${a.role} into slot ${a.slot}`)
          .join(' and ')}.`,
      );
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [armored, passphrase]);

  const loadHex = useCallback(async () => {
    setBusy('hex');
    setError(null);
    setStatus(null);
    try {
      const clean = hex.replace(/\s/g, '');
      if (!clean || clean.length % 2) {
        setError('A raw key is an even number of hex characters.');
        return;
      }
      const bytes = new Uint8Array(clean.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
      }
      if (bytes.some(Number.isNaN)) {
        setError('That is not hex.');
        return;
      }

      const {device} = await getOnlyKey();
      /*
       * Type 1 is Ed25519 for an ECC slot; for RSA the type is the key size in
       * 64-byte units, which prepareKey derives from the material. Raw entry is
       * the escape hatch, so the type follows the slot rather than being asked
       * for - anyone with a reason to want another type has a PEM.
       */
      const type = slot >= 101 ? 1 : bytes.length / 128;
      await device.loadKey(slot, {type, key: bytes});
      setLoaded(true);
      setStatus(`Wrote ${bytes.length} bytes to slot ${slot}.`);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [hex, slot]);

  const wipe = useCallback(async () => {
    setBusy('wipe');
    setError(null);
    setStatus(null);
    try {
      const {device} = await getOnlyKey();
      await device.wipeKey(slot);
      setStatus(`Wiped slot ${slot}.`);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [slot]);

  /* Config mode locks the key; the PIN has to go back in before anything else. */
  if (config.entered && !config.ready) {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        <Section title="Config mode">
          <Text style={styles.body}>
            The key locked itself on entering config mode. Enter your PIN to
            carry on loading keys.
          </Text>
        </Section>
        <PinScreen onPress={emu.press} />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <Section title="Keys">
        <Text style={styles.body}>
          Private keys for signing and decryption, used by OnlyKey Agent and the
          web app. They are written to the device and never read back.
        </Text>
      </Section>

      {/* Above the form, because a message under three screens of fields is a
          message nobody reads. */}
      {status ? <Text style={styles.status}>{status}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {!config.ready ? (
        <Section title="Config mode is required">
          <Text style={styles.body}>
            The firmware only accepts a key while the device is in config mode,
            and getting there locks it. The whole sequence is:
          </Text>
          <Text style={styles.steps}>
            1. hold button 6 — the app does this{'\n'}
            2. the key locks, and you enter your PIN again{'\n'}
            3. the keys are written{'\n'}
            4. restart the app — config mode ends only at a restart, and while
            it is on the key will not sign or type anything
          </Text>
          <Btn
            title={config.entering ? 'Holding…' : 'Enter config mode'}
            tone="primary"
            disabled={config.entering || locked}
            onPress={config.enter}
          />
          {locked ? (
            <Text style={styles.note}>Unlock the key first.</Text>
          ) : null}
        </Section>
      ) : (
        <Section title="Config mode">
          <Text style={styles.body}>
            Keys can be written. The key will not sign or type anything until
            the app is restarted.
          </Text>
        </Section>
      )}

      <Section title="Load a key">
        <Segmented
          value={mode}
          options={MODES}
          onChange={setMode}
        />

        {mode === 'PGP' ? (
          <>
            <Text style={styles.note}>
              An armoured OpenPGP private key. Its subkeys are assigned by the
              usual convention — the decryption subkey to slot 101, the signing
              key to 102.
            </Text>
            <Text style={styles.label}>Passphrase (if the key has one)</Text>
            <TextInput
              value={passphrase}
              onChangeText={setPassphrase}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="—"
              placeholderTextColor={theme.textDim}
              style={styles.input}
            />
            <Text style={styles.label}>Key</Text>
            <TextInput
              value={armored}
              onChangeText={setArmored}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
              placeholderTextColor={theme.textDim}
              style={[styles.input, styles.textarea]}
            />
            <Btn
              title={busy === 'pgp' ? 'Loading…' : 'Load PGP key'}
              tone="primary"
              disabled={busy !== null || !config.ready || !armored.trim()}
              onPress={loadPgp}
            />
          </>
        ) : (
          <>
            <Text style={styles.note}>
              The escape hatch: raw key bytes as hex, written to the slot you
              pick. No parsing, no checking beyond the length.
            </Text>
            <SlotPicker slot={slot} onChange={setSlot} />
            <Text style={styles.label}>Key bytes</Text>
            <TextInput
              value={hex}
              onChangeText={setHex}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="a1b2c3…"
              placeholderTextColor={theme.textDim}
              style={[styles.input, styles.textarea, styles.mono]}
            />
            <Btn
              title={busy === 'hex' ? 'Writing…' : 'Write to slot'}
              tone="primary"
              disabled={busy !== null || !config.ready || !hex.trim()}
              onPress={loadHex}
            />
          </>
        )}
      </Section>

      <Section title="Wipe a slot">
        <Text style={styles.note}>
          Erases the key in one slot. Irreversible, and it also needs config
          mode.
        </Text>
        <SlotPicker slot={slot} onChange={setSlot} />
        <Btn
          title={busy === 'wipe' ? 'Wiping…' : `Wipe slot ${slot}`}
          tone="danger"
          disabled={busy !== null || !config.ready}
          onPress={wipe}
        />
      </Section>

      {loaded ? (
        <Section title="Restart to finish">
          <Text style={styles.body}>
            The key is written but cannot be used yet: config mode blocks
            signing, and it ends only when the firmware restarts. Restart the
            app to leave it.
          </Text>
        </Section>
      ) : null}
    </ScrollView>
  );
}

function SlotPicker({slot, onChange}: {slot: number; onChange: (n: number) => void}) {
  return (
    <View style={styles.picker}>
      <Text style={styles.label}>Slot</Text>
      <View style={styles.chips}>
        {[...RSA_SLOTS, ...ECC_SLOTS].map(n => (
          <Btn
            key={n}
            title={String(n)}
            tone={n === slot ? 'primary' : 'default'}
            onPress={() => onChange(n)}
          />
        ))}
      </View>
      <Text style={styles.note}>
        1–4 are RSA, 101–110 are ECC.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  content: {padding: 16, gap: 16, paddingBottom: 48},

  body: {color: theme.textSecondary, fontSize: theme.fontSize, lineHeight: theme.lineHeight},
  steps: {color: theme.textSecondary, fontSize: 13, lineHeight: 22},
  note: {color: theme.textDim, fontSize: 12, lineHeight: 18},
  label: {color: theme.textSecondary, fontSize: 12, marginTop: 4},

  status: {color: theme.ok, fontSize: 13, lineHeight: 20},
  error: {color: theme.error, fontSize: 13, lineHeight: 20},

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
  textarea: {minHeight: 120, textAlignVertical: 'top'},
  mono: {fontFamily: theme.mono, fontSize: 12},

  picker: {gap: 8},
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 6},
});
