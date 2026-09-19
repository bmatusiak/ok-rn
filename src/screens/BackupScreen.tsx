import React, {useCallback, useEffect, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput} from 'react-native';
import {Btn, Section, Segmented} from '../ui/components';
import {theme} from '../ui/theme';
import {useActiveKey, useKeyName} from '../hooks/KeyContext';
import {device as okdevice} from 'node-onlykey-lib';
import {useKeyboardLayout} from '../hooks/useKeyboardLayout';
import {useSharedBtKeyboard} from '../hooks/BtKeyboardContext';
import NativeShare from '../../specs/NativeShare';
import {useSecureScreen} from '../hooks/useSecureScreen';
import {ConfigModePanel} from '../ui/ConfigModePanel';
import {ConfigModeRequired} from '../ui/ConfigModeBlocked';
import {summarizeBackup} from '../backupFile';
import type {BackupSummary} from '../backupFile';
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
  configMode,
  setConfigMode,
  probe,
  onCheck,
  checking,
}: {
  configMode: boolean;
  setConfigMode: (on: boolean) => void;
  /** The label probe App runs while in config mode; `ok` means unlocked. */
  probe: {at: number; ok: boolean; note: string} | null;
  /** Runs one label probe, on demand. See App: never on a timer. */
  onCheck: () => Promise<void>;
  checking: boolean;
  emu: EmuSession;
  blockScreenshots?: boolean;
}) {
  /* The ACTIVE key, not whichever one this file used to assume. */
  const getKey = useActiveKey();
  /* What the key types in, remembered per key. See useKeyboardLayout. */
  const {layout} = useKeyboardLayout();
  /* Named in every panel that states a fact about it. See useKeyName. */
  const keyName = useKeyName();

  useSecureScreen(blockScreenshots);

  const [text, setText] = useState<string | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [restoreText, setRestoreText] = useState('');
  const [restoreFrom, setRestoreFrom] = useState<string | null>(null);
  const [checked, setChecked] = useState<BackupSummary | null>(null);
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
  /*
   * THE PROBE IS THE TRUTH, and it runs by itself - see the effect below.
   *
   * Config mode locks the key, and the firmware does not announce the
   * re-unlock (OnlyKey.ino:707 skips the broadcast while in config mode), so
   * the only way to know the PIN went back in is to ask. `probe.ok` is that
   * answer and stays the gate.
   *
   * What changed is WHEN it is asked. It used to wait for somebody to find a
   * "Check config mode" button at the foot of the tab, so the whole screen sat
   * dimmed after a successful unlock with nothing saying why.
   */
  /*
   * IN CONFIG MODE AND UNLOCKED IS THE PROOF. There is nothing left to ask.
   *
   * Config mode locks the key, so a key that is unlocked AFTER entering it can
   * only have got there by the PIN going back in. If the app can see that, the
   * question is already answered - and it usually can: the header pill reads
   * `unlocked` throughout.
   *
   * This used to demand `probe.ok` alone, a slot-label read triggered by a
   * "Check config mode" button at the foot of the tab. So the whole screen sat
   * dimmed after a successful unlock, with the thing standing in the way being
   * a button nothing pointed at.
   *
   * THE PROBE REMAINS, as the fallback it was always meant to be. A hard key on
   * production firmware need not report the re-unlock at all - the firmware
   * skips the broadcast while in config mode - so `emu.device` can sit at
   * something other than 'unlocked' with the PIN plainly in. There the button
   * is the only way to settle it, and removing it would strand exactly the
   * device this feature is for.
   *
   * An earlier attempt hooked the locked -> unlocked TRANSITION instead. It
   * never fired: `emu.device` does not go to 'locked' when config mode locks
   * the key, so there was no edge to catch. Keying on an edge assumed a signal
   * that does not exist.
   */
  const configReady =
    configMode && (emu.device === 'unlocked' || probe?.ok === true);



  /*
   * WHY a section is inert, said where the section is.
   *
   * Two different blockers used to read as one. Not being in config mode and
   * being in it with the PIN not yet confirmed are different problems with
   * different next actions, and both showed up as the same dimming - so
   * standing IN config mode with Restore dead gave no clue that the thing to
   * press was at the foot of the tab.
   *
   * Null when the section is usable, so the caller renders nothing.
   */
  const blockedBecause = !configMode
    ? 'Needs config mode — the panel at the foot of this tab turns it on.'
    : !probe?.ok
      ? 'Config mode is on, but the key locked itself — enter your PIN, then press “Check config mode” at the foot.'
      : null;

  /*
   * THE BRIDGE MUST NOT RELAY A BACKUP.
   *
   * `captureBackup` makes the key type its whole encrypted backup as
   * keystrokes, and the Bluetooth keyboard forwards IFACE.KEYBOARD frames to
   * the paired computer. With a host connected, the backup went there too -
   * measured twice, into a terminal on the other machine.
   *
   * The bridge cannot tell a backup from a password by looking at reports. It
   * can be told that the app is about to make the key talk, and that none of
   * it is for the host.
   */
  const {suspend: suspendBridge} = useSharedBtKeyboard();

  /*
   * Whether the app can hold the button, or only listen while you do.
   * `canPress` is the debug-console probe; a production key answers no.
   */
  const canTrigger = emu.canPress === true;

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
      const result = (await suspendBridge(() => device.captureBackup({
        /*
         * The trigger is ours because pressing a button is platform-specific;
         * the library does the capture, decode and verification - and it says
         * which button and how long, because THAT BAND MOVED. The 2.1 line
         * leaves the backup hold open-ended on classic hardware while the 3.0
         * line bounds it at 180, where the same button becomes a DUO's
         * config-mode gesture. A hold this screen picked itself would be a
         * backup on one key and a typed slot on another.
         */
        /*
         * NO TRIGGER ON A KEY THE APP CANNOT PRESS.
         *
         * `holdTicks` throws without the debug console (useHardKey.ts), which
         * is every production key - so on one of those the app cannot start a
         * backup at all, and a button that tries can only fail. The library
         * makes `trigger` optional (plugins/device/index.js:2276) and simply
         * listens when it is absent, which is exactly right: the person holds
         * button 1 themselves and the capture picks it up off the same stream.
         *
         * Same capture, same decode, same verification either way. The only
         * difference is whose finger starts it.
         */
        /* The ACTIVE key's hold, not the emulator's. See useOkEmu.holdTicks. */
        trigger: canTrigger
          ? () => emu.holdTicks(backup.button, backup.ticks, {allowGesture: true})
          : undefined,
        layout,
        timeoutMs: 120000,
        onProgress: ({characters}: {characters: number}) => setProgress(characters),
      }))) as {text: string; verified: boolean; digest?: string | null};

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
  }, [getKey, suspendBridge, canTrigger]);

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

  /**
   * Read the file WITHOUT sending it anywhere.
   *
   * summarizeBackup is pure and carries the reasoning; this is the state
   * around it. The verdict is cleared whenever the text changes, so what is
   * on screen is always a verdict about the text that is on screen.
   */
  const check = useCallback(() => {
    setError(null);
    setStatus(null);
    setChecked(summarizeBackup(restoreText));
  }, [restoreText]);

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
      {/*
        * A BACKUP CANNOT BE TAKEN IN CONFIG MODE.
        *
        * The key TYPES its backup, and in config mode it will not type - that
        * is what the banner says and what the firmware does. So the capture
        * would hold button 1, receive nothing, and sit there until its
        * two-minute timeout before failing for a reason the screen could have
        * given up front.
        *
        * The mirror of Restore directly below, which needs config mode; these
        * two are never both available, which is worth seeing rather than
        * discovering.
        */}
      {/*
        The app-wide banner already says the key will not type in config mode,
        the section below is dimmed, and it carries its own one-line reason.
        A fourth statement of the same fact was noise.
      */}
      <ConfigModeRequired ready={!configMode}>
      <Section title={`Backup — ${keyName}`}>
        <Text style={styles.body}>
          The key types its backup rather than sending it, so this asks it to
          type and reads what it types. It contains everything the key holds —
          encrypted under your backup passphrase if you set one, and in the
          clear if you did not.
        </Text>
        {!canTrigger ? (
          <Text style={styles.note}>
            This key takes no presses from the app, so you start the backup:
            press below, then hold button 1 on the key until it finishes typing.
          </Text>
        ) : null}
        <Btn
          title={
            busy === 'capture'
              ? canTrigger
                ? `Reading… ${progress} chars`
                : `Listening… ${progress} chars — hold button 1`
              : canTrigger
                ? 'Back up now'
                : 'Capture backup'
          }
          tone="primary"
          disabled={busy !== null || locked}
          onPress={capture}
        />
        {locked ? <Text style={styles.note}>Unlock the key first.</Text> : null}
      </Section>
      </ConfigModeRequired>


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

      {/*
        ALWAYS HERE, and that is the whole point.
        This used to render only when `needsPassphrase`, a flag set in the
        capture error handler when the device refused for want of a backup key.
        So the only way to reach the control was to FAIL a backup first - and
        setting a backup key needs config mode, and entering config mode locks
        the key, which remounts this screen and clears the flag. The section
        vanished at the exact moment it became usable.
        A backup passphrase could not be set from this tab at all. Not awkward:
        unreachable. Observed end to end on device.
        The flag survives, demoted to what it is good for - saying WHY the
        section matters right now, after a backup has just failed for want of
        it. It no longer decides whether the section exists.
      */}
      {/*
        DIMMED THE SAME WAY RESTORE IS. Both need config mode, both say so in
        the same words - so they must LOOK the same too. Left undimmed, this
        section read as usable while its own line said it was not, which is a
        worse lie than either state alone.
        Dimmed, not hidden: the point of the panel being at the foot is that
        you can see what config mode would give you before committing to it.
      */}
      <ConfigModeRequired ready={configReady}>
        <Section title="Set a backup key">
          {/*
            The flag's remaining job: say why this matters RIGHT NOW, when a
            backup has just been refused for want of a key. It no longer
            decides whether the section exists.
          */}
          {needsPassphrase ? (
            <Text style={styles.warn}>
              The backup you just asked for needs this.
            </Text>
          ) : null}
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
              {configReady ? (
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
          {/*
            ONE PANEL FOR THE TAB, at the bottom - not one per section.
            This used to carry its own ConfigModePanel, so once the section was
            open TWO rendered together: this one and Restore's, identical but
            for step 3, two buttons for one switch. It also nested an entire
            PinScreen, so entering config mode grew a second PIN pad inside a
            backup form.
            The line below says what this section needs; the single panel at
            the foot of the tab is how to get there.
          */}
          {!configReady ? (
            <Text style={styles.note}>{blockedBecause}</Text>
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
      </ConfigModeRequired>

      {/*
        * RESTORE NEEDS CONFIG MODE on a provisioned key.
        *
        * The firmware takes OKRESTORE under `configmode == true` OR
        * `!initcheck` (okcore.cpp:600), and `initcheck` is set once a nonce
        * exists in flash - so the second branch is a key that has never been
        * set up, which is Setup's business. On this tab it is always the first.
        *
        * Outside config mode the write is SILENTLY DROPPED - no
        * acknowledgement, no error, nothing on any interface. A restore that
        * looked like it worked and did nothing is the worst thing this screen
        * could do, so the panel goes dim and inert rather than inviting it.
        */}
      <ConfigModeRequired ready={configReady}>
      <Section title="Restore">
        <Text style={styles.body}>
          Choose a backup file, or paste one, to write it back. Read it first:
          nothing is sent until the file has passed, and a damaged one is
          refused with nothing changed either way.
        </Text>
        {/*
          Restore had NO reason of its own. It relied on the config-mode panel
          that used to sit directly above it, and moving that panel to the foot
          left this section dimmed with its explanation a screen away.
        */}
        {blockedBecause ? (
          <Text style={styles.note}>{blockedBecause}</Text>
        ) : null}
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
            /* And no longer the text that was read, so the verdict goes. */
            setChecked(null);
          }}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="-----BEGIN ONLYKEY BACKUP-----"
          placeholderTextColor={theme.textDim}
          style={styles.textarea}
        />
        <Btn
          title="Read this file"
          disabled={busy !== null || !restoreText.trim()}
          onPress={check}
        />

        {checked ? (
          <>
            <Text style={checked.ok ? styles.status : styles.error}>
              {checked.ok
                ? `${checked.lines} lines, ${checked.bytes} bytes, and the `
                  + 'digest chain checks out.'
                : `Not restorable: ${checked.reason}`}
            </Text>
            {checked.ok ? null : (
              <Text style={styles.note}>
                Which line broke is not knowable. There is one expected value,
                at the end, and each step folds in the one before it — so
                a mismatch says the file is not the file that was captured,
                and nothing finer.
              </Text>
            )}
            {checked.expected && checked.digest && !checked.ok ? (
              <>
                <Text style={styles.note}>the file says:</Text>
                <Text style={styles.digest} selectable>{checked.expected}</Text>
                <Text style={styles.note}>its bytes compute:</Text>
                <Text style={styles.digest} selectable>{checked.digest}</Text>
              </>
            ) : null}
          </>
        ) : null}

        {/*
         * ARMED BY THE CHECK, not by there being text in the box. The restore
         * verifies for itself and always did, so this gate protects nothing on
         * the key - it puts the failure on a button that is not coloured like
         * an overwrite, and makes pressing the one that is a deliberate second
         * act rather than the first thing to hand.
         */}
        <Btn
          title={busy === 'restore' ? 'Restoring…' : 'Restore'}
          tone="danger"
          disabled={busy !== null || locked || !checked?.ok}
          onPress={restore}
        />
        <Text style={styles.note}>
          {checked?.ok
            ? 'A restore replaces what is on the key.'
            : 'Read the file first. A restore replaces what is on the key.'}
        </Text>
      </Section>
      </ConfigModeRequired>

      {/*
        THE WAY IN, AT THE FOOT - after everything it unlocks.
        Placed last on purpose. Config mode locks the key and ends only at a
        restart, so being asked to enter it before you have seen what it is
        for is a demand made blind. Read the tab, see which parts say they
        need it, then decide.
        It also goes QUIET once its job is done: there is nothing to offer
        somebody already through it, and a control that cannot act must not
        look like one that can - the sections it unlocked are above it,
        usable and waiting.
      */}
      {configReady ? (
        <Section title="Config mode">
          <Text style={styles.note}>
            The key is in config mode, so the sections above are available.
            Restart the key when you are done — that is the only way out, and
            until then it will not sign or type.
          </Text>
        </Section>
      ) : (
        <ConfigModePanel
          emu={emu}
          configMode={configMode}
          setConfigMode={setConfigMode}
          probe={probe}
          onCheck={onCheck}
          checking={checking}
          purpose="set a backup key or restore a backup"
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  warn: {color: theme.warn, fontWeight: '600'},
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
