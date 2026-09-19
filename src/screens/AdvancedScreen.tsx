/**
 * The controls that are irreversible, or only meaningful on a developer key.
 *
 * These used to sit behind "testing mode", which is a switch meant for running
 * the test harness - not a safety mechanism. Hiding a factory wipe behind a
 * developer toggle protects nobody who has found the toggle, and it kept two
 * genuinely useful things - a firmware update, and the key's own console - out
 * of reach of the person the key belongs to.
 *
 * So they live here, in the open, and the protection is what it should have
 * been: each irreversible action states its consequence on screen and needs
 * its exact word typed before its button does anything. That is the gate the
 * firmware updater has always used, and the reason it is a TYPED WORD rather
 * than a confirmation dialog is that a dialog is dismissed by the same reflex
 * that opened it.
 *
 * Nothing here is new capability. Every one of these already existed in the
 * library and could be reached from a test suite and nowhere else.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {Linking, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Btn, KeyValue, Section} from '../ui/components';
import {theme} from '../ui/theme';
import {device as okdevice} from 'node-onlykey-lib';
import {FirmwareScreen} from './FirmwareScreen';
import {useActiveKeyWithBackend, useKeyName} from '../hooks/KeyContext';
import type {EmuSession} from '../hooks/useOkEmu';
import type {HardKeySession} from '../hooks/useHardKey';
import {ALLOW_OVERRIDE, type Overrides} from '../capabilityOverride';
import type {FirmwareFeature} from '../firmwareFeatures';

/** The capabilities a screen fades on, in the order they are shown. */
const CAPABILITY_ROWS: {feature: FirmwareFeature; label: string}[] = [
  {feature: 'postQuantum', label: 'Post-quantum keys'},
  {feature: 'hmacSha1', label: 'HMAC-SHA1 slot keys'},
];

/**
 * WHY the library answered the way it did, in one sentence.
 *
 * Reconstructed from the same inputs `capabilities()` reads - the parsed
 * release and the build keyword - rather than reported by it. That is a
 * duplication, and a deliberate one: the alternative is teaching the library
 * to explain itself to a screen, which is a bigger change to a file that is
 * shared with the e2e suites and the host plugin.
 *
 * It follows that this can DRIFT from the real rule. If the gate in
 * version.js moves, this sentence has to move with it - which is the trade
 * for a panel that is meant to be deleted rather than maintained.
 */
function capabilityReason(
  emu: EmuSession,
  feature: FirmwareFeature,
): string {
  const info = emu.identity;
  if (!info) return 'The key has not said what it is yet.';
  const version = info.version ?? '(no version)';

  if (feature === 'postQuantum') {
    const build = String(info.build ?? 'unknown');
    if (build === 'debug') {
      return `${version} is a -test build, which is the development line, so this reads as present.`;
    }
    return (
      `${version} is a -prod build, so it reads as a release — and no release ` +
      'carries post-quantum keys. A working tree built as production reports ' +
      'exactly this, which is why the switch exists.'
    );
  }

  return `Needs firmware 3.0.0 or newer; this key reports ${version}.`;
}

/** Typed before the key is wiped. Not a dialog; see this file's header. */
const WIPE_WORD = 'WIPE THIS KEY';

/**
 * The two things the Tools tab had that this app cannot do for you.
 *
 * That tab was a board of links to the web app, and it went away because
 * almost every link pointed at a page for something this app now does itself
 * - sending somebody to a browser for that is worse than not offering it,
 * since the page cannot reach this key anyway: it talks to a device over
 * WebAuthn, and here the device is the phone.
 *
 * These two are different. They are setup guides for agents that run ON A
 * COMPUTER, using the key over USB, and no amount of app can perform them
 * from a phone. They are the whole reason the tab is not simply deleted.
 */
const DOCS = 'https://docs.crp.to';
const AGENTS = [
  {
    label: 'OnlyKey GPG Agent',
    detail: 'Use the key as an OpenPGP smartcard on a computer.',
    href: `${DOCS}/gpgagentquickstart.html`,
  },
  {
    label: 'OnlyKey SSH Agent',
    detail: 'Sign SSH logins with a key that never leaves the device.',
    href: `${DOCS}/sshagentquickstart.html`,
  },
];

const DEVICE_TYPES = Object.values(okdevice.slots.DEVICE_TYPE) as string[];

export function AdvancedScreen({
  emu,
  hard,
  caps,
}: {
  /** The ACTIVE key - everything here acts on whichever one is in use. */
  emu: EmuSession;
  /** The hard key, for the one control that only means anything on hardware. */
  hard: HardKeySession;
  /** Forced capabilities: what is on, and how to change it. */
  caps: {
    overrides: Overrides;
    setOverride: (feature: FirmwareFeature, on: boolean) => void;
  };
}) {
  const keyName = useKeyName();
  const {backend, getKey} = useActiveKeyWithBackend();

  const [wipeWord, setWipeWord] = useState('');
  const [detected, setDetected] = useState<string | null>(null);
  const [override, setOverride] = useState<string | null>(null);
  const [answers, setAnswers] = useState<boolean | null>(null);
  const [transcript, setTranscript] = useState('');
  const [line, setLine] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setError(null);
    setStatus(null);
  };

  /*
   * What the device says it is, and whether it will talk on its console.
   *
   * Both are cheap reads and neither needs a button, so they happen when the
   * tab opens rather than behind a "check" a person has to find first.
   */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const {device} = await getKey();
        if (!alive) return;
        setDetected(device.detectedType ?? null);
        setOverride(device.deviceType ?? null);
        setAnswers(await device.consoleAnswers());
      } catch {
        if (alive) setAnswers(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [getKey]);

  const wipe = useCallback(async () => {
    reset();
    setBusy('wipe');
    try {
      const {device} = await getKey();
      await device.wipeUserspace();
      setWipeWord('');
      setStatus(
        'Wipe sent. The key reboots with no PIN, no slots and no keys. Set it ' +
          'up again from This Key.',
      );
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [getKey]);

  const forceType = useCallback(
    async (next: string | null) => {
      reset();
      try {
        const {device} = await getKey();
        const now = device.setDeviceType(next);
        setOverride(now);
        setStatus(
          next === null
            ? `Override cleared. Reading the device again: ${now}.`
            : `Treating this key as a ${now}.`,
        );
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
      }
    },
    [getKey],
  );

  /** Whatever the key has printed on its console so far. */
  const readConsole = useCallback(async () => {
    reset();
    setBusy('console');
    try {
      const {device} = await getKey();
      setTranscript(device.console.text);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [getKey]);

  const sendLine = useCallback(async () => {
    reset();
    setBusy('console');
    try {
      const {device} = await getKey();
      await device.press(line);
      setLine('');
      /* A moment for the key to answer before reading what it said. */
      await new Promise<void>(r => setTimeout(() => r(), 400));
      setTranscript(device.console.text);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [getKey, line]);

  const working = busy !== null;
  const canWipe = wipeWord.trim() === WIPE_WORD;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <Section title={`Advanced — ${keyName}`}>
        <Text style={styles.body}>
          Things that cannot be undone, and things only a developer key can do.
          Each one says what it will do, and needs its word typed first.
        </Text>
      </Section>

      {/*
        WHAT WAS DETECTED, WHY, AND THE SWITCH.

        The "why" is the point. Every bug of this shape in this project - the
        vault seal, provisioning on a release, and this one - was a wrong
        conclusion that looked like a fact, and none of them were visible from
        a screen. A line reading "postQuantum: false, because the build keyword
        is -prod" would have shown this in seconds instead of a long chase.

        Rendered only while ALLOW_OVERRIDE. It is meant to be deleted.
      */}
      {ALLOW_OVERRIDE ? (
        <Section title="Capabilities">
          <Text style={styles.body}>
            What this key says it can do, and why the app thinks so. Forcing one
            on tells the app the firmware has it — which is how unsigned
            firmware is used before a release carries it.{' '}
            <Text style={styles.warn}>
              If the firmware does not have it, the operation fails at the key.
            </Text>
          </Text>
          {CAPABILITY_ROWS.map(({feature, label}) => {
            const detected = emu.capabilities?.[feature];
            const forced = caps.overrides[feature] === true;
            return (
              <View key={feature} style={styles.capRow}>
                <KeyValue
                  label={label}
                  value={
                    detected === undefined
                      ? 'not read yet'
                      : detected
                        ? 'yes'
                        : forced
                          ? 'no — forced on'
                          : 'no'
                  }
                />
                <Text style={styles.note}>{capabilityReason(emu, feature)}</Text>
                {/*
                  NO BUTTON WHEN IT IS ALREADY THERE. A greyed-out "Force it
                  on" beside a feature the key reports having is a control with
                  nothing to do, and an explanation the reader has to invent.
                */}
                {detected === true ? null : (
                  <Btn
                    title={forced ? 'Stop forcing it on' : 'Force it on'}
                    tone={forced ? 'default' : 'primary'}
                    onPress={() => caps.setOverride(feature, !forced)}
                  />
                )}
              </View>
            );
          })}
          <Text style={styles.note}>
            {backend === 'embedded'
              ? 'The soft key remembers this across a restart — it is this app’s own firmware and cannot be swapped underneath it.'
              : 'A hard key forgets this the moment it is unplugged or disconnects, because the next key on the bus may be a different one.'}
          </Text>
        </Section>
      ) : null}

      {hard.state === 'running' ? (
        <FirmwareScreen emu={emu} backend={backend} />
      ) : (
        <Section title="Firmware update">
          <Text style={styles.note}>
            Needs a hard key on the USB bus. The soft key runs firmware built
            from source by this repository, so there is nothing to update.
          </Text>
        </Section>
      )}

      <Section title="Erase this key">
        <Text style={styles.body}>
          Wipes the PIN, every profile and every slot, and reboots the key
          unprovisioned. Keys loaded into slots go with it. There is no backup
          unless you made one, and no undo.
        </Text>
        <Text style={styles.label}>Type {WIPE_WORD} to enable it</Text>
        <TextInput
          style={styles.input}
          value={wipeWord}
          onChangeText={setWipeWord}
          placeholder={WIPE_WORD}
          placeholderTextColor={theme.textDim}
          autoCapitalize="characters"
          autoCorrect={false}
        />
        <Btn
          title={busy === 'wipe' ? 'Wiping…' : 'Erase everything on this key'}
          tone="danger"
          disabled={working || !canWipe}
          onPress={wipe}
        />
      </Section>

      <Section title="Model">
        <KeyValue label="detected" value={detected ?? 'not said yet'} />
        <KeyValue label="in use" value={override ?? '—'} />
        <Text style={styles.note}>
          The device announces its model and the library believes it. An
          override exists because that detection was wrong once: a DUO read as
          a classic wrote to the wrong slot and listed 12 of its 24, with no
          error either time. Change this only to work around something.
        </Text>
        <View style={styles.row}>
          {DEVICE_TYPES.map(t => (
            <Btn
              key={t}
              title={t}
              tone={override === t ? 'primary' : undefined}
              disabled={working}
              onPress={() => forceType(t)}
            />
          ))}
          <Btn
            title="Use what it says"
            disabled={working}
            onPress={() => forceType(null)}
          />
        </View>
      </Section>

      <Section title="Debug console">
        {answers ? (
          <>
            <Text style={styles.note}>
              This key answers on its serial console, which means it is a
              DEVELOPER build. The console is how the test suites drive it and
              how the firmware says what it is doing internally. Lines go to
              the key exactly as typed.
            </Text>
            <TextInput
              style={styles.input}
              value={line}
              onChangeText={setLine}
              placeholder="a line to send"
              placeholderTextColor={theme.textDim}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.row}>
              <Btn
                title={busy === 'console' ? 'Working…' : 'Send'}
                tone="primary"
                disabled={working || !line}
                onPress={sendLine}
              />
              <Btn title="Read" disabled={working} onPress={readConsole} />
            </View>
            {transcript ? (
              <Text style={styles.transcript} selectable>
                {transcript.slice(-2000)}
              </Text>
            ) : (
              <Text style={styles.note}>Nothing read yet.</Text>
            )}
          </>
        ) : (
          <Text style={styles.note}>
            {answers === null
              ? 'Asking the key whether it reads its console…'
              : 'This key does not answer on its console. Production firmware ' +
                'is built without it, which is why the suites that drive a key ' +
                'this way only run against developer builds.'}
          </Text>
        )}
      </Section>

      <Section title="On a computer">
        <Text style={styles.note}>
          Guides for the agents that run on a desktop with the key plugged
          into it. Nothing here happens on the phone.
        </Text>
        {AGENTS.map(tool => (
          <View key={tool.label} style={styles.tool}>
            <Text style={styles.toolLabel}>{tool.label}</Text>
            <Text style={styles.note}>{tool.detail}</Text>
            <Btn
              title="Open the guide"
              onPress={() => {
                setError(null);
                Linking.openURL(tool.href).catch(e =>
                  setError(String((e as Error)?.message ?? e)),
                );
              }}
            />
          </View>
        ))}
      </Section>

      {status ? <Text style={styles.status}>{status}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  capRow: {gap: 6, paddingVertical: 8},
  warn: {color: theme.warn},
  root: {flex: 1, backgroundColor: theme.bg},
  content: {padding: 14, paddingBottom: 48},
  body: {color: theme.text, fontSize: theme.fontSize, lineHeight: theme.lineHeight},
  note: {color: theme.textDim, fontSize: 12, lineHeight: 18, marginTop: 8},
  label: {color: theme.textDim, fontSize: 12, marginTop: 10},
  status: {color: theme.ok, fontSize: 13, lineHeight: 20, marginTop: 8},
  error: {color: theme.error, fontSize: 13, lineHeight: 20, marginTop: 8},
  row: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8},
  tool: {marginTop: 12},
  toolLabel: {color: theme.text, fontSize: 14, fontWeight: '700'},
  input: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 8,
    color: theme.text,
    fontFamily: theme.mono,
    fontSize: 13,
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  transcript: {
    color: theme.textDim,
    fontFamily: theme.mono,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 10,
  },
});
