import React, {useCallback, useEffect, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput} from 'react-native';
import {Btn, Section, Segmented} from '../ui/components';
import {theme} from '../ui/theme';
import {useActiveKey, useKeyName} from '../hooks/KeyContext';
import {device as okdevice} from 'node-onlykey-lib';
import OkEmu from '../transport/OkEmu';
import NativeShare from '../../specs/NativeShare';
import {useSecureScreen} from '../hooks/useSecureScreen';
import {useConfigMode} from '../hooks/useConfigMode';
import {PinScreen} from './PinScreen';
import type {EmuSession} from '../hooks/useOkEmu';

/*
 * Backup and restore.
 *
 * THE DEVICE TYPES ITS BACKUP. There is no command that reads one out - the
 * firmware answers the backup gesture by pressing the whole file at the
 * keyboard, one character at a time (okcore.cpp:6296-6340, 61 slots of it).
 * On hardware that means into a text editor you opened first. Here the
 * keystrokes arrive in-process, so the app captures and decodes them, which is
 * the same machinery the slot reader uses.
 *
 * WHAT COMES OUT IS THE WHOLE KEY. Every slot, every private key, everything -
 * encrypted under the backup passphrase if one is set, and in the clear if not.
 * That is why this screen blocks screenshots, stages the file where only a
 * chosen app can read it, and wipes the staging directory afterwards.
 */

/**
 * Where the backup key can come from.
 *
 * Both land on the same slot. A passphrase is hashed to a key the device
 * stores; a PGP key supplies one of its own private scalars. The desktop app
 * offers both, in two separate wizard steps.
 */
const BACKUP_SOURCES = ['Passphrase', 'PGP key'] as const;
type BackupSource = (typeof BACKUP_SOURCES)[number];

export function BackupScreen({
  emu,
  blockScreenshots = true,
}: {
  emu: EmuSession;
  blockScreenshots?: boolean;
}) {
  /* The ACTIVE key, not whichever one this file used to assume. */
  const getKey = useActiveKey();
  /* Named in every panel that states a fact about it. See useKeyName. */
  const keyName = useKeyName();

  useSecureScreen(blockScreenshots);

  const [text, setText] = useState<string | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [restoreText, setRestoreText] = useState('');
  const [restoreFrom, setRestoreFrom] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [backupSource, setBackupSource] = useState<BackupSource>('Passphrase');
  const [backupArmored, setBackupArmored] = useState('');
  const [backupKeyPassphrase, setBackupKeyPassphrase] = useState('');

  /*
   * Whether the device has told us it has no backup key.
   *
   * Not inferred from a failed capture - the firmware says so outright, and
   * this is the one repair the screen can offer, so it is worth showing only
   * when it applies.
   */
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const locked = emu.device !== 'unlocked';

  /*
   * Setting a backup passphrase is an OKSETPRIV, so it needs config mode just
   * as loading a key does. Shared with the Keys screen rather than written
   * twice - the sequence is three firmware quirks deep and only worth getting
   * right once.
   */
  const config = useConfigMode();

  /* A staged backup must not outlive the screen that made it. */
  useEffect(() => () => { void NativeShare.clearShared().catch(() => {}); }, []);

  const capture = useCallback(async () => {
    setBusy('capture');
    setError(null);
    setStatus(null);
    setText(null);
    setVerified(null);
    setProgress(0);

    try {
      const {device} = await getKey();

      /*
       * capabilities() is null until the device has SAID what it is, and
       * getOnlyKey only builds the app - it does not connect. Guessing a
       * band here would defeat the point of reading one.
       */
      if (!device.capabilities) await device.connect();
      const backup = device.capabilities.gestures.backup;
      const result = await device.captureBackup({
        /*
         * The trigger is ours because pressing a button is platform-specific;
         * the library does the capture, decode and verification - and it says
         * which button and how long, because THAT BAND MOVED. The 2.1 line
         * leaves the backup hold open-ended on classic hardware while the 3.0
         * line bounds it at 180, where the same button becomes a DUO's
         * config-mode gesture. A hold this screen picked itself would be a
         * backup on one key and a typed slot on another.
         */
        trigger: () => OkEmu.holdTicks(backup.button, backup.ticks, {allowGesture: true}),
        timeoutMs: 120000,
        onProgress: ({characters}: {characters: number}) => setProgress(characters),
      });

      setText(result.text);
      setVerified(result.verified);
      setDigest(result.digest ?? null);
      setStatus(
        result.verified
          ? `Captured ${result.text.length} characters. The digest chain checks out.`
          : `Captured ${result.text.length} characters, but the digest DOES NOT match.`,
      );
    } catch (e) {
      const err = e as Error & {partial?: string};
      const message = String(err?.message ?? e);

      /*
       * A backup with no backup key set is not a failure to capture - it is
       * the device declining, and there is exactly one thing to do about it.
       * The partial is NOT shown in that case: it is the refusal sentence the
       * firmware typed, not a damaged backup, and offering to share it would
       * be offering to save a link to the documentation.
       */
      if (/no backup key/i.test(message)) {
        setNeedsPassphrase(true);
        setError(
          'This key has no backup passphrase, so it will not produce a backup. ' +
            'Set one below and try again.',
        );
        return;
      }

      if (err.partial) {
        setText(err.partial);
        setVerified(false);
      }
      setError(message);
    } finally {
      setBusy(null);
    }
  }, [getKey]);

  /*
   * Take the backup key from a PGP key instead of a passphrase.
   *
   * The scalar and its CURVE both come from the key. Guessing the curve writes
   * a key the device accepts and that then decrypts nothing, which is only
   * discovered at restore time - the worst possible moment.
   */
  const setBackupFromPgp = useCallback(async () => {
    setBusy('pgpBackup');
    setError(null);
    setStatus(null);
    try {
      const openpgp = require('node-onlykey-lib/crypto/pgp');
      let key = await openpgp.readPrivateKey({armoredKey: backupArmored});
      if (backupKeyPassphrase && !key.isDecrypted()) {
        key = await openpgp.decryptKey({
          privateKey: key,
          passphrase: backupKeyPassphrase,
        });
      }

      const candidates = okdevice.keys.fromPgpKey(key);
      if (!candidates.length) {
        throw new Error('that key carries no private material this device can use');
      }

      /*
       * ECC only. An RSA candidate has p and q rather than a scalar and no
       * curve at all, and a backup key's type byte IS a curve - so an RSA key
       * cannot be one, and saying that beats writing something the device
       * accepts and cannot use.
       *
       * The first ECC candidate is the primary, which is what the desktop's own
       * form starts on. Choosing among subkeys is a picker this screen does not
       * have yet.
       */
      const chosen = candidates.find(c => c.kind === 'ecc');
      if (!chosen || chosen.scalar === undefined || chosen.curve === undefined) {
        throw new Error(
          'that key is RSA. A backup key is typed by its curve, so it has to be ' +
            'an Ed25519 or NIST P-256 key.',
        );
      }

      const {device} = await getKey();
      const result = await device.setBackupKeyFromPgp(chosen.scalar, {
        curve: chosen.curve,
      });
      setStatus(
        `Backup key set from the PGP key, on slot ${result.slot}. ` +
          'A backup made from now on needs THAT key to restore.',
      );
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [getKey, backupArmored, backupKeyPassphrase]);

  const setBackupPassphrase = useCallback(async () => {
    setBusy('passphrase');
    setError(null);
    setStatus(null);
    try {
      const {device} = await getKey();
      await device.setBackupPassphrase(passphrase);
      setNeedsPassphrase(false);
      setPassphrase('');
      setStatus(
        'Backup passphrase set. Restart the app to leave config mode, then back up.',
      );
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [getKey, passphrase]);

  const share = useCallback(async () => {
    if (!text) return;
    setBusy('share');
    setError(null);
    try {
      /* Sortable, and it says what it is without saying whose it is. */
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const shown = await NativeShare.shareFile(
        `onlykey-backup-${stamp}.txt`,
        text,
        'text/plain',
        'Save your OnlyKey backup',
      );
      setStatus(
        shown
          ? 'Handed to the app you chose. Delete it from this phone once it is somewhere safe.'
          : 'Nothing on this phone can receive a file.',
      );
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [text]);

  const pick = useCallback(async () => {
    setBusy('pick');
    setError(null);
    setStatus(null);
    try {
      const file = await NativeShare.pickTextFile('text/plain');
      /* Cancelling is the commonest outcome of a picker, and says nothing. */
      if (!file.picked) return;

      setRestoreText(file.content);
      setRestoreFrom(file.name);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, []);

  const restore = useCallback(async () => {
    setBusy('restore');
    setError(null);
    setStatus(null);
    try {
      const {device} = await getKey();
      const result = await device.restore(restoreText);
      setStatus(
        `Restored ${result.bytes} bytes. Restart the app so the key reloads what it now holds.`,
      );
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [getKey, restoreText]);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <Section title={`Backup — ${keyName}`}>
        <Text style={styles.body}>
          The key types its backup rather than sending it, so this asks it to
          type and reads what it types. It contains everything the key holds —
          encrypted under your backup passphrase if you set one, and in the
          clear if you did not.
        </Text>
        <Btn
          title={busy === 'capture' ? `Reading… ${progress} chars` : 'Back up now'}
          tone="primary"
          disabled={busy !== null || locked}
          onPress={capture}
        />
        {locked ? <Text style={styles.note}>Unlock the key first.</Text> : null}
      </Section>

      {status ? <Text style={styles.status}>{status}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {text ? (
        <Section title={verified ? 'Backup captured' : 'Backup captured — unverified'}>
          {verified === false ? (
            <Text style={styles.error}>
              The digest chain does not match, which means the capture is
              incomplete or damaged. Do not rely on this file; take it again.
            </Text>
          ) : (
            <Text style={styles.note}>
              Each line is hashed together with the running digest, so this
              check catches a reordering as well as an edit.
            </Text>
          )}
          {digest ? <Text style={styles.digest}>{digest}</Text> : null}
          <Btn
            title={busy === 'share' ? 'Sharing…' : 'Save or share'}
            tone="primary"
            disabled={busy !== null}
            onPress={share}
          />
          <Text style={styles.note}>
            Sent as a file, so a storage app can save it rather than paste it.
            The copy this app staged is deleted when you leave this screen.
          </Text>
        </Section>
      ) : null}

      {needsPassphrase ? (
        <Section title="Set a backup key">
          <Segmented
            value={backupSource}
            options={BACKUP_SOURCES}
            onChange={setBackupSource}
          />
          {backupSource === 'PGP key' ? (
            <>
              <Text style={styles.body}>
                One of a PGP key&apos;s own private keys becomes the backup key
                — the desktop app&apos;s Setup step 9. It goes to the same slot
                a passphrase would, and the CURVE is read from the key, because
                the device is told the type and cannot work it out from the
                bytes.
              </Text>
              <TextInput
                value={backupArmored}
                onChangeText={setBackupArmored}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
                placeholderTextColor={theme.textDim}
                style={[styles.input, styles.textarea]}
              />
              <TextInput
                value={backupKeyPassphrase}
                onChangeText={setBackupKeyPassphrase}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Passphrase, if the key has one"
                placeholderTextColor={theme.textDim}
                style={styles.input}
              />
              {config.ready ? (
                <Btn
                  title={busy === 'pgpBackup' ? 'Setting…' : 'Use this key for backups'}
                  tone="primary"
                  disabled={busy !== null || !backupArmored.trim()}
                  onPress={setBackupFromPgp}
                />
              ) : null}
            </>
          ) : null}
          {backupSource === 'Passphrase' ? (
          <>
          <Text style={styles.body}>
            A backup is encrypted under a passphrase, and the key will not make
            one until it has it. The passphrase never reaches the device — only
            a key derived from it does — so THIS IS THE ONLY COPY. A backup
            cannot be restored without it.
          </Text>
          <TextInput
            value={passphrase}
            onChangeText={setPassphrase}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="at least 25 characters"
            placeholderTextColor={theme.textDim}
            style={styles.input}
          />
          {!config.ready ? (
            <>
              <Text style={styles.note}>
                The key only accepts a backup key in config mode, and getting
                there locks it. The app holds button 6, you enter your PIN
                again, and afterwards the app has to be restarted — config mode
                ends only at a restart.
              </Text>
              <Btn
                title={config.entering ? 'Holding…' : 'Enter config mode'}
                tone="primary"
                disabled={config.entering || locked}
                onPress={config.enter}
              />
              {config.error ? (
                <Text style={styles.error}>{config.error}</Text>
              ) : null}
              {config.entered ? (
                <>
                  <Text style={styles.note}>
                    The key locked itself. Enter your PIN to carry on.
                  </Text>
                  <PinScreen onPress={emu.press} canPress={emu.canPress} />
                </>
              ) : null}
            </>
          ) : (
            <Btn
              title={busy === 'passphrase' ? 'Setting…' : 'Set passphrase'}
              tone="primary"
              disabled={busy !== null || passphrase.length < 25}
              onPress={setBackupPassphrase}
            />
          )}
          <Text style={styles.note}>
            {passphrase.length}/25 characters
          </Text>
          </>
          ) : null}
        </Section>
      ) : null}

      <Section title="Restore">
        <Text style={styles.body}>
          Choose a backup file, or paste one, to write it back. It is verified
          before a single byte is sent, so a damaged file fails with nothing
          changed.
        </Text>
        <Btn
          title={busy === 'pick' ? 'Opening…' : 'Choose a file'}
          disabled={busy !== null}
          onPress={pick}
        />
        {restoreFrom ? (
          <Text style={styles.note}>
            Read {restoreFrom} — {restoreText.length} characters. Check it below
            before restoring.
          </Text>
        ) : null}
        <TextInput
          value={restoreText}
          onChangeText={t => {
            setRestoreText(t);
            /* Edited by hand, so it is no longer what the file said. */
            if (restoreFrom) setRestoreFrom(null);
          }}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="-----BEGIN ONLYKEY BACKUP-----"
          placeholderTextColor={theme.textDim}
          style={styles.textarea}
        />
        <Btn
          title={busy === 'restore' ? 'Restoring…' : 'Restore'}
          tone="danger"
          disabled={busy !== null || locked || !restoreText.trim()}
          onPress={restore}
        />
        <Text style={styles.note}>
          A restore replaces what is on the key.
        </Text>
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
  digest: {color: theme.textDim, fontSize: 11, fontFamily: theme.mono},

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

  textarea: {
    minHeight: 120,
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
});
