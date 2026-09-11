import React, {useCallback, useState} from 'react';
import {StyleSheet, Text, TextInput, View} from 'react-native';
import {Btn, KeyValue, Section} from '../ui/components';
import {theme} from '../ui/theme';
import {getOnlyKey} from '../onlykey';
import {useConfigMode} from '../hooks/useConfigMode';
import {CONFIRM_WORD, summarizeFirmware} from '../firmwareFile';
import type {FirmwareSummary} from '../firmwareFile';
import type {EmuSession} from '../hooks/useOkEmu';

/**
 * Firmware update - the desktop's Firmware panel, for a HARD key.
 *
 * NOT YET RUN ON A KEY. Every step below is the library's
 * (device.requestFirmwareUpdate, device.sendFirmware; src/device/firmware.js
 * in node-onlykey-lib), tested against a fake bootloader and the desktop's
 * byte layout, and never against a physical key: the bench key is a
 * developer build nobody can re-image, and this is the one operation that
 * can brick one. It lives on the Testing tab for that reason, and this
 * paragraph goes when a production key has taken an update through it.
 *
 * THE SHAPE. The desktop takes a file; this app has no document picker and
 * a signed firmware file is hundreds of kilobytes of hex, so the file comes
 * from a URL - the release asset the desktop's own update check points at -
 * fetched on an explicit press and never on its own (the air-gapped rule,
 * same as the key lookup on the Messages screen). Then two gated steps in
 * the firmware's own order: the reboot request, which the firmware accepts
 * only in config mode (okcore.cpp:619), and the send, which only a key in
 * its bootloader can take. Each is behind a typed word, because the button
 * two rows down does something the one above it cannot undo.
 */
/**
 * `emu` is the ACTIVE key - the one getOnlyKey() talks to and the one
 * config mode is entered on - and it has to be the hard key: a firmware
 * update of the soft key is a rebuild, not a screen. `backend` says which
 * is active; everything below is off until it says usb.
 */
export function FirmwareScreen({emu, backend}: {emu: EmuSession; backend: 'embedded' | 'usb'}) {
  const isHard = backend === 'usb';
  const config = useConfigMode(emu);
  const [url, setUrl] = useState('');
  const [text, setText] = useState<string | null>(null);
  const [summary, setSummary] = useState<FirmwareSummary | null>(null);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState<'fetch' | 'reboot' | 'send' | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchFile = useCallback(async () => {
    setBusy('fetch');
    setError(null);
    setNote(null);
    setSummary(null);
    setText(null);
    try {
      const where = url.trim();
      if (!/^https:\/\//i.test(where)) throw new Error('The URL has to start with https://.');
      const res = await fetch(where);
      if (!res.ok) throw new Error(`${where} answered ${res.status}.`);
      const body = await res.text();
      setSummary(summarizeFirmware(body)); // throws on anything that is not signed firmware
      setText(body);
      setNote(`Fetched from ${where}. Compare the first signature with the release page before going on.`);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [url]);

  const reboot = useCallback(async () => {
    setBusy('reboot');
    setError(null);
    setNote(null);
    try {
      const {device} = await getOnlyKey();
      const said = await device.requestFirmwareUpdate();
      setNote(`The key said "${said}". Wait for it to come back as BOOTLOADER, then send.`);
      setConfirm('');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, []);

  const send = useCallback(async () => {
    if (!text) return;
    setBusy('send');
    setError(null);
    setNote(null);
    setProgress(null);
    try {
      const {device} = await getOnlyKey();
      const result = await device.sendFirmware(text, {
        onProgress: (p: {block: number; of: number; packet: number; packets: number}) =>
          setProgress(`block ${p.block} of ${p.of}, packet ${p.packet} of ${p.packets}`),
      });
      setNote(`All ${result.blocks} blocks accepted: the key said SUCCESSFULLY LOADED FW and is booting the new firmware.`);
      setConfirm('');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [text]);

  const inBootloader = isHard && emu.device === 'bootloader';
  const confirmed = confirm.trim() === CONFIRM_WORD;

  return (
    <Section title="Firmware update — Hard Key">
      <Text style={styles.warn}>
        Not yet run on a key. The steps are the desktop app's, read from its
        source and the firmware's, and tested against a fake bootloader; no
        physical key has taken an update through this screen. Do not use it
        on a key you cannot afford to lose.
      </Text>
      {!isHard ? (
        <Text style={styles.error}>
          The soft key is selected. Pick the hard key on This Key first; this
          screen acts on whichever key is active.
        </Text>
      ) : null}
      <Text style={styles.note}>
        1. Fetch the signed firmware file from its release URL. 2. In config
        mode, ask the key to reboot into its bootloader. 3. When it comes back
        saying BOOTLOADER, send the file. The key boots the new firmware
        itself when the last block is accepted.
      </Text>

      <Text style={styles.label}>Signed firmware URL (https)</Text>
      <TextInput
        style={styles.input}
        value={url}
        onChangeText={setUrl}
        placeholder="https://github.com/trustcrypto/OnlyKey-Firmware/releases/download/…/Signed_OnlyKey_….txt"
        placeholderTextColor={theme.textDim}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Btn
        title={busy === 'fetch' ? 'Fetching…' : 'Fetch signed firmware'}
        disabled={busy !== null || !url.trim()}
        onPress={() => void fetchFile()}
      />
      {summary ? (
        <View style={styles.kv}>
          <KeyValue label="blocks" value={String(summary.blocks)} />
          <KeyValue label="bytes" value={String(summary.bytes)} />
          <KeyValue label="first signature" value={summary.first.signature} />
          <KeyValue label="chains to" value={summary.first.nextSignature} />
          <KeyValue label="last signature" value={summary.last.signature} />
        </View>
      ) : null}

      <Text style={styles.label}>Type {CONFIRM_WORD} to enable the two steps below</Text>
      <TextInput
        style={styles.input}
        value={confirm}
        onChangeText={setConfirm}
        placeholder={CONFIRM_WORD}
        placeholderTextColor={theme.textDim}
        autoCapitalize="characters"
        autoCorrect={false}
      />

      {!config.entered ? (
        <>
          <Text style={styles.note}>
            The reboot request is accepted only in config mode, which locks the
            key: hold button 6 (the app does this), then enter the PIN again.
          </Text>
          <Btn
            title={config.entering ? 'Holding…' : 'Enter config mode'}
            disabled={config.entering || !isHard || emu.device !== 'unlocked' || busy !== null}
            onPress={config.enter}
          />
          {config.error ? <Text style={styles.error}>{config.error}</Text> : null}
        </>
      ) : null}
      <Btn
        title={busy === 'reboot' ? 'Asking…' : 'Reboot the key into its bootloader'}
        tone="danger"
        disabled={busy !== null || !isHard || !confirmed || !summary || !config.ready || inBootloader}
        onPress={() => void reboot()}
      />
      <Btn
        title={busy === 'send' ? 'Sending…' : 'Send the firmware'}
        tone="danger"
        disabled={busy !== null || !isHard || !confirmed || !text || !inBootloader}
        onPress={() => void send()}
      />
      <Text style={styles.note}>
        {inBootloader
          ? 'The key is in its bootloader and waiting for firmware.'
          : `The key reports "${emu.device}"; Send stays off until it says BOOTLOADER.`}
      </Text>
      {progress ? <Text style={styles.note}>{progress}</Text> : null}
      {note ? <Text style={styles.note}>{note}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  warn: {color: theme.warn, fontSize: 12, lineHeight: 18, marginBottom: 6},
  note: {color: theme.textDim, fontSize: 12, lineHeight: 18, marginTop: 6},
  error: {color: theme.error, fontSize: 13, lineHeight: 20, marginTop: 6},
  label: {color: theme.textSecondary, fontSize: 12, marginTop: 10, marginBottom: 4},
  input: {
    color: theme.text,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    marginBottom: 8,
  },
  kv: {marginTop: 6},
});
