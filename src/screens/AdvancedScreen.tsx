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
import {Linking, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Btn, KeyValue, Section} from '../ui/components';
import {theme} from '../ui/theme';
import {device as okdevice} from 'node-onlykey-lib';
import {FirmwareScreen} from './FirmwareScreen';
import {KeySource} from '../ui/KeySource';
import {ConfigModePanel} from '../ui/ConfigModePanel';
import type {ConfigState} from '../ui/configModeNotes';
import {useActiveKeyWithBackend, useKeyName} from '../hooks/KeyContext';
import type {EmuSession} from '../hooks/useOkEmu';
import type {HardKeySession} from '../hooks/useHardKey';
import type {KeyControl} from '../hooks/useKey';
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
  keys,
  configMode,
  onWantConfigMode,
  caps,
}: {
  /** The ACTIVE key - everything here acts on whichever one is in use. */
  emu: EmuSession;
  /**
   * Which key is active, and the controls that decide it.
   *
   * Moved here from This Key on 2026-09-19. It had been lifted to the top of
   * that screen so the choice could be made BEFORE unlocking - "the choice
   * decides WHICH key you would be unlocking" - and that case is now covered
   * at the door instead: PinScreen takes `keyPick` and offers the same choice
   * whenever a hard key is attached, which is the only time there is anything
   * to choose between.
   *
   * It belongs here because it decides what every other panel on this tab
   * acts on, which is why it is rendered first.
   */
  keys: KeyControl;
  /** Firmware update needs config mode; the panel at the foot is the way in. */
  configMode: ConfigState;
  onWantConfigMode: () => void;
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

  const [detected, setDetected] = useState<string | null>(null);
  const [override, setOverride] = useState<string | null>(null);
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
      } catch {
        /* Nothing to report: the rows below say "not said yet". */
      }
    })();
    return () => {
      alive = false;
    };
  }, [getKey]);

  const forceType = useCallback(
    async (next: string | null) => {
      reset();
      /*
       * The only thing on this tab that still sets `busy`.
       *
       * The Model buttons were already disabled on `working`, but nothing
       * drove it here - so they stayed live through their own await. It was
       * masked while the wipe and the debug console shared this state; with
       * both moved to the Testing tab, the guard had nothing left behind it.
       */
      setBusy('type');
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
      } finally {
        setBusy(null);
      }
    },
    [getKey],
  );

  const working = busy !== null;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      {/* First, because it decides which key everything below acts on. */}
      <KeySource keys={keys} />

      <Section title={`Advanced — ${keyName}`}>
        {/*
          Reworded when the wipe and the debug console moved to Testing. It
          used to promise "things only a developer key can do", which was those
          two - what is left needs a hard key rather than a developer one, and
          only the firmware update is irreversible.
        */}
        <Text style={styles.body}>
          Things that cannot be undone, and settings the app will not change
          for you. The firmware update says what it will do and needs its word
          typed first.
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
      {/*
        HARD KEYS ONLY. The soft key's firmware is staged by this build, so
        buildInfo.unreleased already tells capabilities() whether it is a
        pinned release or the working tree - a working-tree build simply has
        its features on, with nothing to switch. A hard key arrives with
        whatever somebody flashed onto it, and an unsigned build there reports
        the same version string as the release it is ahead of.
      */}
      {ALLOW_OVERRIDE && backend !== 'embedded' ? (
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
            This is forgotten the moment the key is unplugged or disconnects —
            the next key on the bus may be a different one, and an override
            that outlived this key would be describing the wrong device.
          </Text>
        </Section>
      ) : null}

      {hard.state === 'running' ? (
        <FirmwareScreen emu={emu} backend={backend} configMode={configMode} />
      ) : (
        <Section title="Firmware update">
          <Text style={styles.note}>
            Needs a hard key on the USB bus. The soft key runs firmware built
            from source by this repository, so there is nothing to update.
          </Text>
        </Section>
      )}

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
      {/*
        THE WAY IN, AT THE FOOT - after the panels it unlocks.
    
        Firmware update is the one thing on this tab that needs config
        mode: the reboot-into-bootloader request is refused outside it.
        That screen used to carry its own Enter button, which pressed
        button 6 through the debug console and so could not work on the
        production key it exists to update. This panel replaces it, and
        on a hard key it asks for the only thing that can do the job - a
        thumb on button 6.
      */}
      <ConfigModePanel
        state={configMode}
        emu={emu}
        backend={backend}
        onWant={onWantConfigMode}
        purpose="update the firmware"
      />
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
});
