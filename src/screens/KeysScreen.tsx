import React, {useCallback, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Btn, Section, Segmented} from '../ui/components';
import {NEEDS_CONFIG_MODE, ON, type ConfigState} from '../ui/configModeNotes';
import {ConfigModePanel} from '../ui/ConfigModePanel';
import {theme} from '../ui/theme';
import {device as okdevice, bytes as okbytes} from 'node-onlykey-lib';
import {useActiveKey, useBackend, useKeyName} from '../hooks/KeyContext';
import {missingNote, supports} from '../firmwareFeatures';
import type {Overrides} from '../capabilityOverride';
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

/**
 * Where the firmware will accept a key from a host: RSA 1-4, ECC 101-116.
 *
 * This stopped at 110 and six usable slots were unreachable. The firmware
 * takes 101-116 and refuses 117-132 by name - "Error cannot set key in
 * reserved slot (117-132)", okcore.cpp:458-469, which also explains what
 * the reserved range is for (the default backup key at 131, the derived
 * keys at 128/132, all set by other paths). The desktop app offers all
 * sixteen (app.html:1180-1195); the desktop rewrite made the same cut to
 * 110 that this did.
 */
const RSA_SLOTS = [1, 2, 3, 4];
const ECC_SLOTS = [
  101, 102, 103, 104, 105, 106, 107, 108,
  109, 110, 111, 112, 113, 114, 115, 116,
];

/* Segmented renders the value, so these read as labels. */
const MODES = ['PGP', 'SSH', 'Raw hex'] as const;
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
 * The types the DEVICE makes, which is a different list from the ones a
 * person pastes in.
 *
 * Kept apart because the difference is the whole point: a raw key is material
 * the phone has seen, and one of these is a seed made inside the key that
 * never crosses the wire. Putting them in one picker would present that as a
 * formatting choice.
 */
const GENERATED_TYPES = okdevice.keys.GENERATED_KEY_TYPES;

/**
 * How many bytes to read back, by what the slot holds.
 *
 * THE READER HAS TO KNOW. The reply is consecutive 64-byte reports with no
 * length, no tag and no terminator anywhere in it (okcrypto.cpp), so the only
 * thing that ends the read is a count the caller supplies. Ask for too few
 * and the key is truncated silently; too many and it waits out its timeout.
 *
 * So this is a choice a person makes, not something the app can infer - the
 * device does not say what type a slot holds, and a name is not proof of one.
 */
const PUB_KEY_SIZES = [
  {name: 'ECC (32)', bytes: 32, keyType: 0},
  {name: 'ECC point (64)', bytes: 64, keyType: 0},
  {
    name: 'ML-KEM-768',
    bytes: okdevice.keys.PUBLIC_KEY_BYTES[okdevice.keys.KEY_TYPE.MLKEM768],
    keyType: okdevice.keys.KEY_TYPE.MLKEM768,
  },
  {
    name: 'X-Wing',
    bytes: okdevice.keys.PUBLIC_KEY_BYTES[okdevice.keys.KEY_TYPE.XWING],
    keyType: okdevice.keys.KEY_TYPE.XWING,
  },
];

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

export function KeysScreen({
  emu,
  configMode,
  onWantConfigMode,
  overrides,
}: {
  emu: EmuSession;
  /*
   * Everything gated on this tab goes the SAME way: writing a key to a slot,
   * or wiping one, is accepted only in config mode (device/index.js:1632).
   * Reading a key back is not, so "Loaded keys" and "Read a public key" stay
   * live throughout.
   */
  configMode: ConfigState;
  /** Asks App to want config mode. Nothing here writes the flag. */
  onWantConfigMode: () => void;
  /** Forced capabilities, if any. See src/capabilityOverride.ts. */
  overrides?: Overrides;
}) {
  /* The ACTIVE key, not whichever one this file used to assume. */
  const getKey = useActiveKey();
  /* Named in every panel that states a fact about it. See useKeyName. */
  const keyName = useKeyName();
  const backend = useBackend();

  const [mode, setMode] = useState<Mode>('PGP');
  const [slot, setSlot] = useState<number>(101);
  const [passphrase, setPassphrase] = useState('');
  const [armored, setArmored] = useState('');
  const [hex, setHex] = useState('');
  const [ssh, setSsh] = useState('');
  /*
   * The name the device keeps for the slot, which nothing has ever written:
   * python-onlykey can read key names and never sets one, and the desktop
   * app has no control for either. Optional, so an empty box writes no name
   * at all rather than an empty one.
   */
  const [keyName2, setKeyName2] = useState('');
  const [keyType, setKeyType] = useState<string>(RAW_TYPES[0].name);

  /*
   * WHAT THE KEY IS FOR. The firmware keeps three bits in the type byte -
   * backup (0x80), signature (0x40), decryption (0x20), the library's
   * MODIFIER - and a key written without them is stored but refused for
   * the operation it was meant for: the signing suite loads Ed25519 as
   * `1 | 0x40` for exactly that reason. The desktop shows the three as
   * checkboxes; this did not, so every raw key it wrote had no role. Both
   * roles on by default, because a key with neither is a key that does
   * nothing; backup off, because marking a key as the backup key is a
   * decision with consequences on the Backup tab.
   */
  const [roles, setRoles] = useState({backup: false, signature: true, decryption: true});
  /* The PGP path assigns roles itself (decryption to 101, signing to 102); backup is the choice. */
  const [pgpBackup, setPgpBackup] = useState(false);
  const toggleRole = (name: 'backup' | 'signature' | 'decryption') =>
    setRoles(r => ({...r, [name]: !r[name]}));
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
  /*
   * Post-quantum generation, and whether this firmware has it at all - which
   * NO RELEASE DOES, so on a key from a box this section is faded. See
   * src/firmwareFeatures.ts.
   */
  const pqc = supports(emu.capabilities, 'postQuantum', overrides);
  const [genType, setGenType] = useState<string>(GENERATED_TYPES[0].name);
  const [genSlot, setGenSlot] = useState<number>(110);
  const [genChallenge, setGenChallenge] = useState<number[] | null>(null);
  const [pubSlot, setPubSlot] = useState<number>(101);
  const [pubKind, setPubKind] = useState<string>(PUB_KEY_SIZES[0].name);
  const [pubKey, setPubKey] = useState<{slot: number; hex: string; b64: string} | null>(null);
  /*
   * This section reports its OWN outcome, next to its own button.
   *
   * The screen-wide error line renders at the very bottom of a long
   * ScrollView. Pressing Read at the top and having the answer appear several
   * screens below is indistinguishable from nothing happening - which is
   * exactly how it read while this was being checked: the request went out,
   * the device answered "Error no ECC Private Key set in this slot", and the
   * screen looked inert.
   */
  const [pubNote, setPubNote] = useState<string | null>(null);
  const [generated, setGenerated] = useState<{
    slot: number; recipient: string; identity: string;
  } | null>(null);
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
      const applied = await device.loadPgpKey(key, {backup: pgpBackup});
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
  }, [getKey, armored, passphrase, pgpBackup]);

  /*
   * SSH, the desktop Keys panel's other import. The desktop parses with
   * sshpk, which does not run under Hermes; the library now reads the
   * OpenSSH container itself (device/openssh.js) and feeds the converter
   * that was written for sshpk's output. One key, one slot, the roles the
   * raw loader offers - an SSH key has no subkeys to assign by convention.
   */
  const loadSsh = useCallback(async () => {
    setBusy('ssh');
    setError(null);
    setStatus(null);
    try {
      const {device} = await getKey();
      const applied = await device.loadSshKey(ssh.trim(), {
        slot,
        backup: roles.backup,
        signature: roles.signature,
        decryption: roles.decryption,
        /* Null lets the key name itself from its own ssh-keygen comment. */
        label: keyName2.trim() || null,
      });
      setLoaded(true);
      setStatus(
        `Loaded the ${applied.keyType} key${applied.comment ? ` "${applied.comment}"` : ''} into slot ${applied.slot}.`,
      );
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [getKey, ssh, slot, roles, keyName2]);

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
      const {MODIFIER} = okdevice.keys;
      const type = (isRsaSlot ? bytes.length / 128 : chosen.type)
        | (roles.backup ? MODIFIER.BACKUP : 0)
        | (roles.signature ? MODIFIER.SIGNATURE : 0)
        | (roles.decryption ? MODIFIER.DECRYPTION : 0);

      if (!isRsaSlot && bytes.length !== chosen.bytes) {
        setError(
          `${chosen.name} wants ${chosen.bytes} bytes and this is ${bytes.length}. ` +
            'The device takes whatever it is given, so the wrong length is ' +
            'written and fails later rather than now.',
        );
        return;
      }

      const result = await device.loadKey(slot, {type, key: bytes}, {label: keyName2.trim() || null});
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
  }, [getKey, hex, slot, roles, keyName2]);

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

  /*
   * WHAT IS LOADED, which this screen could not say.
   *
   * The firmware keeps a second label list for keys, read with the same
   * message and a different slot byte, and nothing in this app or the
   * library asked for it - so a key could be written and the screen would
   * go on looking exactly as it had. python-onlykey has printed it as
   * `getkeylabels` all along; the desktop app has no control for it either.
   *
   * Only slots that are NAMED are shown. A label is not proof of a key -
   * they live in different places on the device, which is why wiping one
   * used to leave the other - so the list says "named", and the count says
   * how many of the twenty answered.
   */
  const [keyRows, setKeyRows] = useState<
    {slot: number; kind: string; label: string | null}[] | null
  >(null);
  const [keysError, setKeysError] = useState<string | null>(null);
  const refreshKeys = useCallback(async () => {
    setBusy('labels');
    setKeysError(null);
    try {
      const {device} = await getKey();
      const {keys} = await device.readKeyLabels();
      setKeyRows(keys);
    } catch (e) {
      setKeysError(String((e as Error)?.message ?? e));
      setKeyRows(null);
    } finally {
      setBusy(null);
    }
  }, [getKey]);

  const wipe = useCallback(async () => {
    setBusy('wipe');
    setError(null);
    setStatus(null);
    try {
      const {device} = await getKey();
      const result = await device.wipeKey(slot);
      setStatus(`Wiped slot ${slot}. The device said: ${result.response}`);
      if (keyRows) void refreshKeys();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [getKey, slot, keyRows, refreshKeys]);

  /**
   * Read the PUBLIC half of whatever is in a slot.
   *
   * The one operation on this screen that gives something away rather than
   * putting something in, and the reason a person wants it: to hand the
   * public half of a key they loaded to somebody who needs to encrypt to it
   * or verify with it. There was no way to get it out of the app at all.
   *
   * An empty slot answers with a sentence rather than silence
   * ("Error no ECC Private Key set in this slot", okcore.cpp:5243-5245), so
   * this is also how to find out whether a slot holds anything.
   */
  const readPublic = useCallback(async () => {
    setBusy('pubkey');
    setError(null);
    setStatus(null);
    setPubKey(null);
    setPubNote(null);
    try {
      const kind = PUB_KEY_SIZES.find(k => k.name === pubKind) ?? PUB_KEY_SIZES[0];
      const {device} = await getKey();
      const key = await device.getPublicKey(pubSlot, {
        bytes: kind.bytes,
        keyType: kind.keyType,
        timeoutMs: 15000,
      });
      setPubKey({
        slot: pubSlot,
        hex: okbytes.toHex(key),
        b64: okbytes.toBase64(key),
      });
      setPubNote(`Slot ${pubSlot} returned ${key.length} bytes.`);
    } catch (e) {
      setPubNote(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [getKey, pubSlot, pubKind]);

  /**
   * Ask the DEVICE to make a post-quantum key, and show what it can be
   * addressed by.
   *
   * The private half is a seed generated inside the key and written to flash.
   * It never crosses the wire, so unlike every other button on this screen
   * there is nothing here the phone could leak.
   *
   * What comes back is only useful once it is encoded: the RECIPIENT is what
   * someone else encrypts to, and the IDENTITY is what this person keeps to
   * read those files. Both are the same strings python-onlykey writes, so a
   * file encrypted against one of these opens with the command-line plugin
   * and the other way round.
   */
  const generate = useCallback(async () => {
    setBusy('generate');
    setError(null);
    setStatus(null);
    setGenerated(null);
    try {
      const chosen = GENERATED_TYPES.find(t => t.name === genType) ?? GENERATED_TYPES[0];
      const {device, okcrypto} = await getKey();

      const publicKey = await device.generateKey(genSlot, chosen.type, {
        confirm: ({digits}: {digits: number[]}) => {
          setGenChallenge(digits);
        },
        timeoutMs: 60000,
      });

      /*
       * ENCODED BY THE LIBRARY, not here.
       *
       * This screen used to call encodeRecipient and encodeSlotIdentity
       * inline, which is a second copy of a decision the library already
       * makes - in particular WHICH identity form to write. The versioned one
       * carries a fingerprint of this exact key, so a slot generated again
       * can be told apart from the key a file was encrypted to; a screen that
       * built its own could quietly pick the other form.
       *
       * slotIdentity re-reads the slot to build it, which also proves the key
       * reached flash before anything is printed as usable.
       */
      const id = await okcrypto.deviceAge.slotIdentity(genSlot, {timeoutMs: 15000});
      setGenerated({
        slot: genSlot,
        recipient: id.recipientString,
        identity: id.identityString,
      });
      setStatus(
        `Generated a ${chosen.name} key in slot ${genSlot}. ` +
        'The private half never left the key.',
      );
      if (keyRows) void refreshKeys();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setGenChallenge(null);
      setBusy(null);
    }
  }, [getKey, genType, genSlot, keyRows, refreshKeys]);

  /** Press the challenge on the key's behalf, where the key takes presses. */
  const pressGenChallenge = useCallback(async () => {
    if (!genChallenge) return;
    /* One crossing for the whole challenge - see CryptoScreen.pressChallenge. */
    await emu.pressRun(genChallenge);
  }, [genChallenge, emu]);

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

      <Section title="Loaded keys">
        <Text style={styles.note}>
          The names the device holds for its key slots. A name is not proof of
          a key — the firmware keeps the two apart — so this says which slots
          are named, not which hold key material.
        </Text>
        <Btn
          title={busy === 'labels' ? 'Reading…' : keyRows ? 'Read again' : 'Read the key names'}
          disabled={busy !== null || locked}
          onPress={() => void refreshKeys()}
        />
        {locked ? <Text style={styles.note}>Unlock the key first.</Text> : null}
        {keysError ? <Text style={styles.error}>{keysError}</Text> : null}
        {keyRows
          ? (() => {
              const named = keyRows.filter(k => k.label);
              if (!named.length) {
                return (
                  <Text style={styles.note}>
                    All {keyRows.length} key slots answered, and none of them is
                    named.
                  </Text>
                );
              }
              return (
                <>
                  {named.map(k => (
                    <View key={k.slot} style={styles.keyRow}>
                      <Text style={styles.keySlot}>
                        {k.kind === 'rsa' ? `RSA ${k.slot}` : `ECC ${k.slot}`}
                      </Text>
                      <Text style={styles.keyLabel}>{k.label}</Text>
                    </View>
                  ))}
                  <Text style={styles.note}>
                    {named.length} named of {keyRows.length} key slots.
                  </Text>
                </>
              );
            })()
          : null}
      </Section>

      {/* Above the form, because a message under three screens of fields is a
          message nobody reads. */}
      {status ? <Text style={styles.status}>{status}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}


      {/*
        * WRITES ONLY, and only in config mode. Outside it OKSETPRIV is
        * silently dropped - no error, nothing on any interface - and the first
        * symptom is a later signing failure. Dimmed and inert beats offered
        * and ignored.
        */}
      <Section
        title="Load a key"
        unavailable={configMode === ON ? null : NEEDS_CONFIG_MODE}>
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
              title={pgpBackup ? 'Also the backup key' : 'Not the backup key'}
              tone={pgpBackup ? 'primary' : 'default'}
              onPress={() => setPgpBackup(v => !v)}
            />
            <Text style={styles.note}>
              Signing and decryption subkeys go to their usual slots on their
              own; whether this key also decrypts backups is the choice.
            </Text>
            <Btn
              title={busy === 'pgp' ? 'Loading…' : 'Load PGP key'}
              tone="primary"
              disabled={busy !== null || !armored.trim()}
              onPress={loadPgp}
            />
          </>
        ) : mode === 'SSH' ? (
          <>
            <Text style={styles.note}>
              An OpenSSH private key — the "BEGIN OPENSSH PRIVATE KEY" block
              ssh-keygen writes — Ed25519, P-256 or RSA. One key, one slot:
              pick it below (an ECC key goes to 101 and up, RSA to 1–4). A
              passphrase-protected key has to be opened first, with
              ssh-keygen -p -N "" — the app cannot.
            </Text>
            <SlotPicker slot={slot} onChange={setSlot} />
            <Text style={styles.label}>Used for</Text>
            <View style={styles.chips}>
              <Btn title="Signature" tone={roles.signature ? 'primary' : 'default'} onPress={() => toggleRole('signature')} />
              <Btn title="Decryption" tone={roles.decryption ? 'primary' : 'default'} onPress={() => toggleRole('decryption')} />
              <Btn title="Backup key" tone={roles.backup ? 'primary' : 'default'} onPress={() => toggleRole('backup')} />
            </View>
            <Text style={styles.note}>
              ssh-agent signs with it; Signature is what an SSH key is for.
            </Text>
            <Text style={styles.label}>Name for this slot (optional)</Text>
            <TextInput
              value={keyName2}
              onChangeText={setKeyName2}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={16}
              placeholder="taken from the key's own comment"
              placeholderTextColor={theme.textDim}
              style={styles.input}
            />
            <Text style={styles.label}>Key</Text>
            <TextInput
              value={ssh}
              onChangeText={setSsh}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              placeholderTextColor={theme.textDim}
              style={[styles.input, styles.textarea]}
            />
            <Btn
              title={busy === 'ssh' ? 'Loading…' : 'Load SSH key'}
              tone="primary"
              disabled={busy !== null || !ssh.trim()}
              onPress={loadSsh}
            />
          </>
        ) : (
          <>
            <Text style={styles.note}>
              The escape hatch: raw key bytes as hex, written to the slot you
              pick. No parsing, no checking beyond the length.
            </Text>
            <SlotPicker slot={slot} onChange={setSlot} />
            <Text style={styles.label}>Used for</Text>
            <View style={styles.chips}>
              <Btn title="Signature" tone={roles.signature ? 'primary' : 'default'} onPress={() => toggleRole('signature')} />
              <Btn title="Decryption" tone={roles.decryption ? 'primary' : 'default'} onPress={() => toggleRole('decryption')} />
              <Btn title="Backup key" tone={roles.backup ? 'primary' : 'default'} onPress={() => toggleRole('backup')} />
            </View>
            <Text style={styles.note}>
              The key refuses an operation its type byte does not allow, so a
              key loaded without a role is stored and useless. Backup marks it
              as the key that decrypts a backup, which the Backup tab explains.
            </Text>
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
                {/*
                  HMAC-SHA1 ARRIVED IN THE 3.0 LINE. KEYTYPE_HMACSHA1 is in
                  okcore.h at v3.0.0, v3.0.1 and v3.0.2 and NOT at v2.1.0 or
                  v2.1.1 - measured, not assumed. Older firmware takes the
                  write and stores a key it has no code to use, which is the
                  quiet kind of wrong: nothing fails until something asks the
                  key for an HMAC and gets nothing back.

                  Said here rather than faded, because the choice sits inside
                  a picker: greying one option out of four leaves no room to
                  explain why, and this needs the why.
                */}
                {RAW_TYPES.find(t => t.name === keyType)?.hmacOnly &&
                !supports(emu.capabilities, 'hmacSha1', overrides) ? (
                  <Text style={styles.warn}>
                    This firmware predates HMAC-SHA1 (it arrived in 3.0.0). It
                    will accept the write and store a key it cannot use.
                  </Text>
                ) : null}
              </>
            ) : null}
            <Text style={styles.label}>Name for this slot (optional)</Text>
            <TextInput
              value={keyName2}
              onChangeText={setKeyName2}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={16}
              placeholder="up to 16 characters"
              placeholderTextColor={theme.textDim}
              style={styles.input}
            />
            <Text style={styles.note}>
              The device keeps a name per key slot and nothing has ever
              written one — not this app, not the desktop app, not the Python
              client. Leave it empty and the slot stays unnamed, as it is now.
            </Text>
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
              disabled={busy !== null || !hex.trim()}
              onPress={loadHex}
            />
          </>
        )}
      </Section>

      <Section
        title="Yubico OTP (legacy)"
        unavailable={configMode === ON ? null : NEEDS_CONFIG_MODE}>
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
          disabled={busy !== null}
          onPress={writeYubi}
        />
      </Section>


      <Section title="Read a public key">
        <Text style={styles.body}>
          The public half of whatever is in a slot, to hand to someone who
          needs to encrypt to it or check a signature from it. Nothing secret
          leaves the key, and no button press is needed.
        </Text>
        <Text style={styles.note}>
          The reply carries no length, so the size has to be chosen: ask for
          too few bytes and the key comes back truncated without complaint.
          An empty slot answers with a sentence, so this also tells you
          whether a slot holds anything at all.
        </Text>

        <Segmented
          options={PUB_KEY_SIZES.map(k => k.name)}
          value={pubKind}
          onChange={setPubKind}
        />
        <SlotPicker slot={pubSlot} onChange={setPubSlot} />

        <Btn
          title={busy === 'pubkey' ? 'Reading\u2026' : `Read slot ${pubSlot}`}
          tone="primary"
          disabled={busy !== null || locked}
          onPress={readPublic}
        />
        {locked ? <Text style={styles.note}>Unlock the key first.</Text> : null}
        {pubNote ? <Text style={styles.note}>{pubNote}</Text> : null}

        {pubKey ? (
          <>
            <Text style={styles.note}>Slot {pubKey.slot}, hex:</Text>
            <Text style={styles.mono} selectable>{pubKey.hex}</Text>
            <Text style={styles.note}>base64:</Text>
            <Text style={styles.mono} selectable>{pubKey.b64}</Text>
          </>
        ) : null}
      </Section>

      <Section
        title="Generate a post-quantum key"
        faded={!pqc}
        unavailable={configMode === ON ? null : NEEDS_CONFIG_MODE}>
        {pqc ? null : <Text style={styles.note}>{missingNote('postQuantum')}</Text>}
        <Text style={styles.body}>
          The key makes this one itself. A seed is generated inside it,
          encrypted and written to flash, and only the public half comes back.
          Unlike a key you paste in, there is no moment when this phone has
          held the private part.
        </Text>
        <Text style={styles.note}>
          Needs config mode, and the key asks for a three-button confirmation.
        </Text>

        <Segmented
          options={GENERATED_TYPES.map(t => t.name)}
          value={genType}
          onChange={setGenType}
        />
        <SlotPicker
          slot={genSlot}
          onChange={setGenSlot}
          slots={ECC_SLOTS}
          note="101–116 only. A post-quantum key cannot live in an RSA slot."
        />

        <Btn
          title={busy === 'generate' ? 'Generating\u2026' : `Generate in slot ${genSlot}`}
          tone="primary"
          disabled={busy !== null || !pqc}
          onPress={generate}
        />

        {genChallenge ? (
          <>
            <Text style={styles.status}>
              The key is waiting: press {genChallenge.join(' - ')} on it.
            </Text>
            {emu.canPress === true ? (
              <Btn title="Press them for me" onPress={pressGenChallenge} />
            ) : null}
          </>
        ) : null}

        {generated ? (
          <>
            <Text style={styles.note}>
              Recipient \u2014 give this to anyone encrypting to you:
            </Text>
            <Text style={styles.mono} selectable>{generated.recipient}</Text>
            <Text style={styles.note}>
              Identity \u2014 keep this; it is how you read those files:
            </Text>
            <Text style={styles.mono} selectable>{generated.identity}</Text>
          </>
        ) : null}
      </Section>

      {/*
        * OKWIPEPRIV, which the firmware gates on `configmode == true`
        * (okcore.cpp:502) - unlike OKWIPESLOT next door, which does not. Same
        * treatment as Load a key: dim and inert rather than a live-looking
        * button over a message that will be dropped.
        */}
      <Section
        title="Wipe a slot"
        unavailable={configMode === ON ? null : NEEDS_CONFIG_MODE}>
        <Text style={styles.note}>
          Erases the key in one slot. Irreversible, and it also needs config
          mode.
        </Text>
        <SlotPicker slot={slot} onChange={setSlot} />
        <Btn
          title={busy === 'wipe' ? 'Wiping…' : `Wipe slot ${slot}`}
          tone="danger"
          disabled={busy !== null}
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
      {/*
        THE WAY IN, AT THE FOOT - after the panels it unlocks.
    
        Writing a key to a slot, and wiping one, are the same firmware rule:
        OKSETPRIV and the wipes are on the config-mode allowlist and refused
        outside it. Four panels on this tab need it.
      */}
      <ConfigModePanel
        state={configMode}
        emu={emu}
        backend={backend}
        onWant={onWantConfigMode}
        purpose="load a key, or wipe a slot"
      />
    </ScrollView>
  );
}

function SlotPicker({
  slot,
  onChange,
  slots,
  note,
}: {
  slot: number;
  onChange: (n: number) => void;
  /**
   * Which slots to offer. Defaults to all of them, which is right for
   * loading and wiping and WRONG for anything a slot cannot hold.
   *
   * The post-quantum generator is the case that forced this: 1 to 4 are RSA
   * slots, a post-quantum key lives only in 101 to 116, and the firmware
   * does not refuse the difference - okcrypto.cpp has no else for a slot
   * outside the range, so the request simply produces no answer at all. A
   * picker that offers an impossible slot is offering a silent timeout.
   */
  slots?: number[];
  note?: string;
}) {
  return (
    <View style={styles.picker}>
      <Text style={styles.label}>Slot</Text>
      <View style={styles.chips}>
        {(slots ?? [...RSA_SLOTS, ...ECC_SLOTS]).map(n => (
          <Btn
            key={n}
            title={String(n)}
            tone={n === slot ? 'primary' : 'default'}
            onPress={() => onChange(n)}
          />
        ))}
      </View>
      <Text style={styles.note}>
        {note ?? '1–4 are RSA, 101–116 are ECC.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  warn: {color: theme.warn, fontSize: 12, lineHeight: 18, marginTop: 8},
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
    /* Off the paragraph or field above it. See components.tsx btn. */
    marginTop: 8,
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
  keyRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6},
  keySlot: {color: theme.textDim, fontSize: 12, minWidth: 74, fontFamily: 'monospace'},
  keyLabel: {color: theme.text, fontSize: 13, flexShrink: 1},
});
