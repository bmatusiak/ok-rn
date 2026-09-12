import React, {useCallback, useEffect, useState} from 'react';
import {StyleSheet, Text, TextInput, View} from 'react-native';
import {Btn, KeyValue, Section, Segmented} from '../ui/components';
import {theme} from '../ui/theme';
import {getOnlyKey} from '../onlykey';
import {useConfigMode} from '../hooks/useConfigMode';
import NativeShare from '../../specs/NativeShare';
import {
  BUNDLED_DIR,
  CONFIRM_WORD,
  nameVersionMismatch,
  summarizeFirmware,
} from '../firmwareFile';
import type {FirmwareSummary} from '../firmwareFile';
import type {EmuSession} from '../hooks/useOkEmu';

/**
 * Firmware update - the desktop's Firmware panel, for a HARD key.
 *
 * NOT YET RUN ON A KEY. Every step below is the library's
 * (device.requestFirmwareUpdate, device.sendFirmware; src/device/firmware.js
 * in node-onlykey-lib), tested against a fake bootloader and the desktop's
 * byte layout, and never against a physical key. This paragraph goes when a
 * production key has taken an update through it.
 *
 * THERE ARE TWO BOOTLOADERS, AND THEY ACCEPT OPPOSITE THINGS.
 *
 *   production  takes SIGNED firmware only. That signature is the whole
 *               protection against somebody installing malicious firmware on
 *               a user's key, which is why nobody here can produce one.
 *   developer   REFUSES signed firmware. The only thing it takes is an
 *               unsigned build, made with the Docker firmware builder.
 *
 * So a developer key cannot be updated from this screen at all - not as a
 * policy, but because its bootloader will not have what this screen can offer.
 * Every file in `signed_firmware/` is a signed production release. The bench
 * key is a developer key, which is why the update path has never been run on
 * hardware here, and why running it needs the production key instead.
 *
 * The screen says so when a developer key is attached rather than letting
 * somebody type the word and watch the bootloader refuse it.
 *
 * THREE WAYS IN, and the first is the one that matters. A release BUNDLED in
 * the app works with the phone in airplane mode, which is the whole premise of
 * this app and the one thing a URL cannot do. The picker covers a release that
 * is newer than the build. The URL stays because it is how the desktop does
 * it and somebody will want it.
 *
 * Then two gated steps in the firmware's own order: the reboot request, which
 * the firmware accepts only in config mode (okcore.cpp:619), and the send,
 * which only a key in its bootloader can take. Each is behind a typed word,
 * because the button two rows down does something the one above it cannot
 * undo.
 *
 * AND THE FILE IS ASKED WHAT IT IS. `summarizeFirmware` reads the version
 * compiled into the image, so the screen states the version rather than
 * repeating the filename back. A name and an image that disagree stop the
 * flow: see nameVersionMismatch.
 */
/**
 * `emu` is the ACTIVE key - the one getOnlyKey() talks to and the one
 * config mode is entered on - and it has to be the hard key: a firmware
 * update of the soft key is a rebuild, not a screen. `backend` says which
 * is active; everything below is off until it says usb.
 */
const SOURCES = ['Bundled', 'A file', 'A URL'] as const;
type Source = (typeof SOURCES)[number];

export function FirmwareScreen({emu, backend}: {emu: EmuSession; backend: 'embedded' | 'usb'}) {
  const isHard = backend === 'usb';

  /*
   * A DEVELOPER KEY CANNOT TAKE ANYTHING THIS SCREEN OFFERS.
   *
   * Its bootloader refuses signed firmware, and signed production releases are
   * the only thing here. Read from the build rather than asked: a debug build
   * is a developer key, and `debugConsole` is exactly that - derived from the
   * -test / -prod keyword in the version string (version.js).
   *
   * Null is UNKNOWN and is left alone. A firmware older than the keyword says
   * nothing about its bootloader, and refusing on a guess would block the one
   * device somebody might legitimately be trying to update.
   */
  const developerKey = isHard && emu.capabilities?.debugConsole === true;
  const config = useConfigMode(emu);

  const [source, setSource] = useState<Source>('Bundled');
  const [bundled, setBundled] = useState<string[] | null>(null);
  const [url, setUrl] = useState('');
  const [text, setText] = useState<string | null>(null);
  const [from, setFrom] = useState<string | null>(null);
  const [summary, setSummary] = useState<FirmwareSummary | null>(null);
  const [mismatch, setMismatch] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState<'load' | 'reboot' | 'send' | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * What is bundled, asked once. Listing an asset directory touches no
   * network and no key, so it is the one thing on this screen that may happen
   * without a press.
   */
  useEffect(() => {
    let alive = true;
    NativeShare.listAssets(BUNDLED_DIR)
      .then(names => {
        if (alive) setBundled(names.filter(n => n.endsWith('.txt')));
      })
      .catch(() => {
        if (alive) setBundled([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * One place where a candidate file becomes the loaded one.
   *
   * Every source ends here, so the parse, the version readout and the
   * name check happen once and cannot drift between the three.
   */
  const accept = useCallback((name: string, body: string, where: string) => {
    const parsed = summarizeFirmware(body); // throws on anything not signed firmware
    const clash = nameVersionMismatch(name, parsed.declares);
    setSummary(parsed);
    setMismatch(clash);
    setText(clash ? null : body);
    setFrom(name);
    setNote(
      clash
        ? null
        : `${where}. It says it is ${parsed.declares ?? 'a version it does not state'}. ` +
          'Compare the first signature with the release page before going on.',
    );
  }, []);

  const start = useCallback(() => {
    setBusy('load');
    setError(null);
    setNote(null);
    setSummary(null);
    setMismatch(null);
    setText(null);
    setFrom(null);
  }, []);

  const loadBundled = useCallback(
    async (name: string) => {
      start();
      try {
        accept(name, await NativeShare.readAsset(`${BUNDLED_DIR}/${name}`), `Bundled: ${name}`);
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
      } finally {
        setBusy(null);
      }
    },
    [accept, start],
  );

  const loadPicked = useCallback(async () => {
    start();
    try {
      const file = await NativeShare.pickTextFile('text/plain');
      if (!file.picked) {
        setNote('Nothing chosen.');
        return;
      }
      accept(file.name, file.content, `Read ${file.name}`);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [accept, start]);

  const loadUrl = useCallback(async () => {
    start();
    try {
      const where = url.trim();
      if (!/^https:\/\//i.test(where)) throw new Error('The URL has to start with https://.');
      const res = await fetch(where);
      if (!res.ok) throw new Error(`${where} answered ${res.status}.`);
      const body = await res.text();
      accept(where.split('/').pop() ?? where, body, `Fetched from ${where}`);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [accept, start, url]);

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
      {developerKey ? (
        <Text style={styles.error}>
          This is a DEVELOPER key, and its bootloader refuses signed firmware.
          Everything this screen can offer is a signed production release, so
          there is nothing here it will accept. A developer key takes only an
          unsigned build from the Docker firmware builder. Updating a
          production key is what this screen is for.
        </Text>
      ) : null}
      <Text style={styles.note}>
        1. Choose the signed firmware. 2. In config mode, ask the key to reboot
        into its bootloader. 3. When it comes back saying BOOTLOADER, send the
        file. The key boots the new firmware itself when the last block is
        accepted.
      </Text>

      <Text style={styles.label}>Where the firmware comes from</Text>
      <Segmented options={SOURCES} value={source} onChange={setSource} />

      {source === 'Bundled' ? (
        <>
          <Text style={styles.note}>
            Shipped inside the app, so this works with the phone offline. These
            are the files in the repo's signed_firmware folder at build time.
          </Text>
          {bundled === null ? (
            <Text style={styles.note}>Reading what is bundled…</Text>
          ) : bundled.length === 0 ? (
            <Text style={styles.note}>
              Nothing is bundled in this build. Use a file or a URL.
            </Text>
          ) : (
            bundled.map(name => (
              <Btn
                key={name}
                title={name.replace(/^Signed_OnlyKey_/, '').replace(/\.txt$/, '')}
                disabled={busy !== null}
                onPress={() => void loadBundled(name)}
              />
            ))
          )}
        </>
      ) : source === 'A file' ? (
        <>
          <Text style={styles.note}>
            For a release newer than this build. The picker reaches Drive and
            anywhere else the phone can open a document from.
          </Text>
          <Btn
            title={busy === 'load' ? 'Opening…' : 'Choose a file'}
            disabled={busy !== null}
            onPress={() => void loadPicked()}
          />
        </>
      ) : (
        <>
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
            title={busy === 'load' ? 'Fetching…' : 'Fetch signed firmware'}
            disabled={busy !== null || !url.trim()}
            onPress={() => void loadUrl()}
          />
        </>
      )}

      {summary ? (
        <View style={styles.kv}>
          <KeyValue label="from" value={from ?? '—'} />
          <KeyValue label="says it is" value={summary.declares ?? 'not stated'} />
          <KeyValue label="blocks" value={String(summary.blocks)} />
          <KeyValue label="bytes" value={String(summary.bytes)} />
          <KeyValue label="first signature" value={summary.first.signature} />
          <KeyValue label="chains to" value={summary.first.nextSignature} />
          <KeyValue label="last signature" value={summary.last.signature} />
        </View>
      ) : null}
      {mismatch ? <Text style={styles.error}>{mismatch}</Text> : null}

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
        disabled={busy !== null || !isHard || developerKey || !confirmed || !text || !config.ready || inBootloader}
        onPress={() => void reboot()}
      />
      <Btn
        title={busy === 'send' ? 'Sending…' : 'Send the firmware'}
        tone="danger"
        disabled={busy !== null || !isHard || developerKey || !confirmed || !text || !inBootloader}
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
