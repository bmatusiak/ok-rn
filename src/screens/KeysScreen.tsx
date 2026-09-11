import React, {useCallback, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Btn, Section, Segmented} from '../ui/components';
import {theme} from '../ui/theme';
import {device as okdevice} from 'node-onlykey-lib';
import {useActiveKey, useKeyName} from '../hooks/KeyContext';
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

/**
 * The key types OKSETPRIV accepts, from the library rather than retyped here.
 *
 * A raw scalar carries no indication of its curve - 32 bytes is Ed25519,
 * Curve25519, P-256 and secp256k1 alike - so the device is told, and getting it
 * wrong produces a key it accepts and that then verifies nowhere.
 */
const RAW_TYPES = okdevice.keys.RAW_KEY_TYPES;

/**
 * The global Yubico credential's three fields.
 *
 * All three are hex here. The per-slot form takes MODHEX for the public id and
 * hex for the other two, which is the trap the desktop app falls into: three
 * adjacent fields where only the first has a different alphabet.
 */
const YUBI_FIELDS = [
  {name: 'publicId' as const, label: 'Public Identity (6 bytes hex)', placeholder: '0123456789ab'},
  {name: 'privateId' as const, label: 'Private Identity (6 bytes hex)', placeholder: '0123456789ab'},
  {
    name: 'secretKey' as const,
    label: 'Secret Key (16 bytes hex)',
    placeholder: '00112233445566778899aabbccddeeff',
  },
];

/** What picking each type actually means, in a line. */
function describeType(name: string): string {
  const spec = RAW_TYPES.find(t => t.name === name);
  if (!spec) {
    return '';
  }
  if (spec.hmacOnly) {
    return (
      `${spec.bytes} bytes, and only slots ` +
      `${okdevice.slots.HMAC_SLOTS.join(' and ')} take one. Writing it also ` +
      'clears that slot’s button-press requirement — the firmware ' +
      'does that silently.'
    );
  }
  return `${spec.bytes} bytes. The device is told the type; it cannot tell from the bytes.`;
}

export function KeysScreen({emu}: {emu: EmuSession}) {
  /* The ACTIVE key, not whichever one this file used to assume. */
  const getKey = useActiveKey();
  /* Named in every panel that states a fact about it. See useKeyName. */
  const keyName = useKeyName();

  const [mode, setMode] = useState<Mode>('PGP');
  const [slot, setSlot] = useState<number>(101);
  const [passphrase, setPassphrase] = useState('');
  const [armored, setArmored] = useState('');
  const [hex, setHex] = useState('');
  const [keyType, setKeyType] = useState<string>(RAW_TYPES[0].name);
  const [yubi, setYubi] = useState({publicId: '', privateId: '', secretKey: ''});
  const [yubiErrors, setYubiErrors] = useState<Record<string, string>>({});
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
  const config = useConfigMode(emu);
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

      const {device} = await getKey();
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
  }, [getKey, armored, passphrase]);

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

      const {device} = await getKey();
      /*
       * The type is ASKED FOR on an ECC or HMAC slot, not inferred.
       *
       * It cannot be inferred: 32 bytes is an Ed25519 scalar, a Curve25519
       * scalar, a P-256 scalar and a secp256k1 scalar, and the device is simply
       * told which. Guessing Ed25519 - which this did - writes a key that the
       * device accepts and that then signs nothing anyone can verify.
       *
       * RSA is the exception and stays inferred, because there the type IS the
       * size: the key length in 64-byte units.
       */
      const chosen = RAW_TYPES.find(t => t.name === keyType) ?? RAW_TYPES[0];
      const isRsaSlot = slot < 100;
      const type = isRsaSlot ? bytes.length / 128 : chosen.type;

      if (!isRsaSlot && bytes.length !== chosen.bytes) {
        setError(
          `${chosen.name} wants ${chosen.bytes} bytes and this is ${bytes.length}. ` +
            'The device takes whatever it is given, so the wrong length is ' +
            'written and fails later rather than now.',
        );
        return;
      }

      const result = await device.loadKey(slot, {type, key: bytes});
      setLoaded(true);

      /*
       * The device does NOT report this, and it matters: after an HMAC key
       * write, anything that can reach the keyboard interface gets HMAC-SHA1
       * responses from that slot with no button press at all.
       */
      setStatus(
        result.clearedPressRequirement
          ? `Wrote ${bytes.length} bytes to slot ${slot}. This ALSO cleared the ` +
            'button-press requirement on that slot — the firmware does it ' +
            'silently on every HMAC key write.'
          : `Wrote ${bytes.length} bytes to slot ${slot}.`,
      );
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [getKey, hex, slot]);

  /*
   * Validated BEFORE anything is sent, and every problem is reported at once.
   *
   * The desktop app converts the public id inline, throws on a hex digit where
   * modhex was wanted, and lets the throw escape - so the button does nothing,
   * says nothing, and leaves the rejected values in place. See
   * onlykey-testing/FINDING-app-yubico-silent-discard.md.
   */
  const writeYubi = useCallback(async () => {
    setBusy('yubi');
    setError(null);
    setStatus(null);
    setYubiErrors({});
    try {
      const {device} = await getKey();
      const check = device.validateYubiCredential(yubi, {global: true});
      if (!check.ok) {
        const marked: Record<string, string> = {};
        for (const problem of check.errors) {
          marked[problem.field] = problem.message;
        }
        setYubiErrors(marked);
        setError('The credential was not sent — see the fields above.');
        return;
      }

      const result = await device.setYubiAuth(yubi);
      setStatus(`Yubico credential written. The device said: ${result.response}`);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [getKey, yubi]);

  const wipe = useCallback(async () => {
    setBusy('wipe');
    setError(null);
    setStatus(null);
    try {
      const {device} = await getKey();
      await device.wipeKey(slot);
      setStatus(`Wiped slot ${slot}.`);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [getKey, slot]);

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
        <PinScreen onPress={emu.press} canPress={emu.canPress} model={emu.model} />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <Section title={`Keys — ${keyName}`}>
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
            {slot >= 100 ? (
              <>
                <Text style={styles.label}>Key type</Text>
                <Segmented
                  value={keyType}
                  options={RAW_TYPES.map(t => t.name)}
                  onChange={setKeyType}
                />
                <Text style={styles.note}>
                  {describeType(keyType)}
                </Text>
              </>
            ) : null}
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

      <Section title="Yubico OTP (legacy)">
        <Text style={styles.note}>
          The device-global Yubico credential — the desktop app&apos;s Advanced
          tab. All three fields are HEX here; the per-slot form is the one that
          takes modhex.
        </Text>

        {YUBI_FIELDS.map(field => (
          <View key={field.name}>
            <Text style={styles.label}>{field.label}</Text>
            <TextInput
              value={yubi[field.name]}
              onChangeText={next => setYubi(prev => ({...prev, [field.name]: next}))}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={field.placeholder}
              placeholderTextColor={theme.textDim}
              style={[styles.input, styles.mono]}
            />
            {/*
              Per FIELD, because that is the whole point. The desktop throws
              inside its click handler on the first bad value, the throw escapes
              into event dispatch, and the button appears to do nothing at all.
            */}
            {yubiErrors[field.name] ? (
              <Text style={styles.fieldError}>{yubiErrors[field.name]}</Text>
            ) : null}
          </View>
        ))}

        <Btn
          title={busy === 'yubi' ? 'Writing…' : 'Write Yubico credential'}
          tone="primary"
          disabled={busy !== null || !config.ready}
          onPress={writeYubi}
        />
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
  /* Under the field it belongs to, not in the page-wide error line. */
  fieldError: {color: theme.error, fontSize: 11, lineHeight: 16, marginTop: 4},
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
