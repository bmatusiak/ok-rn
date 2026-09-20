import React, {useState} from 'react';
import {ScrollView, StyleSheet, Switch, Text, TextInput, View} from 'react-native';
import {Btn, KeyValue, Section} from '../ui/components';
import {OFF, ON, type ConfigState} from '../ui/configModeNotes';
import OkEmu from '../transport/OkEmu';
import {theme} from '../ui/theme';
import {E2EScreen} from './E2EScreen';
import {UsbScreen} from './UsbScreen';
import type {Backend} from '../hooks/keySession';
import type {EmuSession} from '../hooks/useOkEmu';
import type {HardKeySession} from '../hooks/useHardKey';
import {getOnlyKey} from '../onlykey';
import type {UsbSession} from '../hooks/useUsbHid';
import type {LogEntry} from '../hooks/useLog';

/** Digits are button numbers, so each must be 1-6, and the firmware wants 7-10. */
const TEST_PIN = '1234561';

/**
 * Everything that is useful while building this and dangerous while using it.
 *
 * Reachable only in testing mode, which is the point: the E2E suite stops the
 * firmware and cannot restart it, and a factory reset is exactly as final as it
 * sounds. Neither belongs one stray tap away from a PIN pad.
 *
 * ## IT IS ALWAYS THE SOFT KEY, whatever the app is otherwise reading
 *
 * Starting and stopping firmware, the storage files, a factory reset - these
 * are the emulator's controls and a hard key has none of them. Following the
 * active key would put a Start button over a device that cannot be started and
 * a storage path over one whose storage is inside it.
 *
 * The USB panel further down is the other half: that one is only ever about a
 * physical key. So this tab shows both, each labelled, rather than one that
 * changes meaning underneath you.
 */
export function TestingScreen({
  configMode,
  setConfigMode,
  emu,
  hard,
  active,
  backend,
  hid,
  usbEntries,
  clearUsb,
}: {
  /**
   * The app's config-mode flag, and the only way to change it.
   *
   * Not a reading of the key and not pretending to be one - see App.tsx. It is
   * here because this is a developer tab and the flag is being rebuilt from
   * nothing: a switch, so the banner and whatever gets attached to it later
   * can be seen working before any of it depends on a device.
   */
  configMode: ConfigState;
  setConfigMode: (next: ConfigState) => void;
  emu: EmuSession;
  /** The hard key, for the one bench operation this tab offers on it. */
  hard: HardKeySession;
  /** The ACTIVE key and which it is - the firmware screen acts on it, and only when it is the hard one. */
  active: EmuSession;
  backend: Backend;
  hid: UsbSession;
  usbEntries: LogEntry[];
  clearUsb: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const [armedHard, setArmedHard] = useState(false);
  const [hardWipe, setHardWipe] = useState<string | null>(null);

  /*
   * THE DEBUG CONSOLE, MOVED HERE FROM THE ADVANCED TAB on 2026-09-19.
   *
   * It is a back door: over it, unauthenticated and in plain text, you can
   * wipe the key, restart it, or type its PIN. Production firmware is compiled
   * without the interface, which is the security property rather than a gap -
   * so a control that drives it has no business on a tab a user opens, however
   * carefully it was gated there.
   *
   * On this tab it is absent from a release build outright: metro.config.js
   * swaps TestingScreen for TestingScreen.release.tsx, and tools/release.js
   * greps the built bundle to prove it.
   */
  const [line, setLine] = useState('');
  const [transcript, setTranscript] = useState('');
  const [consoleBusy, setConsoleBusy] = useState(false);

  const readConsole = async () => {
    setConsoleBusy(true);
    try {
      const {device} = await getOnlyKey('usb');
      setTranscript(device.console.text);
    } catch (e) {
      setTranscript(String((e as Error)?.message ?? e));
    } finally {
      setConsoleBusy(false);
    }
  };

  const sendLine = async () => {
    setConsoleBusy(true);
    try {
      const {device} = await getOnlyKey('usb');
      await device.press(line);
      setLine('');
      /* A moment for the key to answer before reading what it said. */
      await new Promise<void>(r => setTimeout(() => r(), 400));
      setTranscript(device.console.text);
    } catch (e) {
      setTranscript(String((e as Error)?.message ?? e));
    } finally {
      setConsoleBusy(false);
    }
  };

  /**
   * The bench key's factory reset: the firmware's own "0C" through the
   * console, which the library names (device.wipeUserspace). It wipes PIN,
   * profiles and slots and reboots the key - what hardKeyProvision does
   * before it re-provisions - so it is offered only for a developer key
   * whose console answers, and only armed twice, like the soft key's.
   */
  const wipeHardKey = async () => {
    if (!armedHard) {
      setArmedHard(true);
      return;
    }
    setArmedHard(false);
    try {
      const {device} = await getOnlyKey('usb');
      await device.wipeUserspace();
      setHardWipe('Wipe sent. The key reboots into an unprovisioned state; set it up again from This Key.');
    } catch (e) {
      setHardWipe(String((e as Error)?.message ?? e));
    }
  };

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      {/*
        THE ONLY WRITER IN THE APP, and it is behind testing mode.

        Config mode decides which features the app offers - things usable in
        it, things not. Nothing is attached yet; this turns the flag on so the
        banner and, later, each feature put behind it can be watched working
        before any of it depends on a key.

        Deliberately NOT a claim about the device. The version removed in
        98f8760 had a switch here too, and its note explained how the KEY
        enters config mode - which made this look like a mirror of the
        hardware while being nothing of the sort.
      */}
      <Section title="Config mode">
        <View style={styles.row}>
          <View style={styles.cell}>
            <Text style={styles.note}>
              {configMode === ON
                ? 'The app is in config mode.'
                : 'The app is not in config mode.'}
            </Text>
          </View>
          {/*
            Straight to ON or OFF, skipping -1 and 1. Those two are waits on a
            key, and this switch exists to look at what config mode CHANGES
            without needing one - the real path through them is the panel.
          */}
          <Switch
            value={configMode === ON}
            onValueChange={next => setConfigMode(next ? ON : OFF)}
          />
        </View>
        <Text style={styles.note}>
          The app's own flag. It shows the banner and nothing else — no feature
          reads it yet, and the key is neither asked nor told.
        </Text>
      </Section>

      {/*
        "Soft Key firmware", not "Firmware". Both keys run firmware, and this
        panel can only ever be about one of them.
      */}
      <Section title="Soft Key firmware">
        <View style={styles.kv}>
          <KeyValue label="state" value={emu.state} />
          <KeyValue label="device" value={emu.device} />
          <KeyValue label="version" value={emu.version || '-'} />
          <KeyValue label="storage" value={tail(emu.storageDir)} />
          <KeyValue label="LED" value={describeLed(emu.led)} />
        </View>
        <View style={styles.row}>
          <View style={styles.cell}>
            <Btn
              title="Start"
              disabled={emu.state === 'running' || emu.busy || emu.state === 'halted'}
              onPress={emu.start}
            />
          </View>
          <View style={styles.cell}>
            <Btn title="OKCONNECT" onPress={emu.connect} disabled={emu.busy} />
          </View>
          <View style={styles.cell}>
            <Btn title="Stop" tone="danger" onPress={emu.stop} />
          </View>
        </View>

        <View style={styles.row}>
          <View style={styles.cell}>
            <Btn
              title={'Set PIN ' + TEST_PIN}
              disabled={emu.busy || emu.state !== 'running'}
              onPress={() => emu.provision(TEST_PIN)}
            />
          </View>
        </View>
        <Text style={styles.note}>
          Set PIN provisions a fixed PIN and only works on a key that has none.
          It takes effect on the next boot, and the firmware thread cannot be
          restarted in place — so reopen the app to see whether it stuck. The
          real setup flow lives behind the login screen.
        </Text>
      </Section>

      <Section title="Wipe the Soft Key">
        <Text style={styles.note}>
          The soft key, always — a hard key is not reachable from this tab, and
          wiping one would not be a developer convenience.
          {' '}
          Fills flash and EEPROM with 0xFF and asks the firmware to reboot,
          which leaves an unprovisioned key — the state a brand new one is in.
          It is the only way to reach the setup flow on a key that already has
          a PIN, and it is exactly as final as it sounds.
        </Text>
        <View style={styles.row}>
          <View style={styles.cell}>
            <Btn
              title={armed ? 'Really wipe it' : 'Factory reset'}
              tone={armed ? 'danger' : 'default'}
              disabled={emu.state !== 'running'}
              onPress={() => {
                /*
                 * Two taps, because there is no undo and this button sits on a
                 * screen people scroll through looking for something else.
                 */
                if (!armed) {
                  setArmed(true);
                  return;
                }
                setArmed(false);
                void OkEmu.factoryReset();
              }}
            />
          </View>
          {armed ? (
            <View style={styles.cell}>
              <Btn title="Cancel" onPress={() => setArmed(false)} />
            </View>
          ) : null}
        </View>
      </Section>

      {hard.state === 'running' && hard.canPress ? (
        <Section title="Wipe the Hard Key">
          <Text style={styles.note}>
            A developer key, whose console answers: this sends the firmware's
            own wipe-userspace command (PIN, profiles, slots — not the
            firmware) and the key reboots unprovisioned. The named-only
            hardKeyProvision suite does the same before it sets the PIN again.
          </Text>
          <View style={styles.row}>
            <View style={styles.cell}>
              <Btn
                title={armedHard ? 'Really wipe the hard key' : 'Wipe the hard key'}
                tone={armedHard ? 'danger' : 'default'}
                onPress={() => void wipeHardKey()}
              />
            </View>
            {armedHard ? (
              <View style={styles.cell}>
                <Btn title="Cancel" onPress={() => setArmedHard(false)} />
              </View>
            ) : null}

      {hard.state === 'running' && hard.canPress ? (
        <Section title="Debug console">
          <Text style={styles.note}>
            This key answers on its serial console, which means it is a
            DEVELOPER build. The console is how the test suites drive it and
            how the firmware says what it is doing internally. Lines go to the
            key exactly as typed.
          </Text>
          <TextInput
            style={styles.consoleInput}
            value={line}
            onChangeText={setLine}
            placeholder="a line to send"
            placeholderTextColor={theme.textDim}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.row}>
            <View style={styles.cell}>
              <Btn
                title={consoleBusy ? 'Working…' : 'Send'}
                tone="primary"
                disabled={consoleBusy || !line}
                onPress={() => void sendLine()}
              />
            </View>
            <View style={styles.cell}>
              <Btn
                title="Read"
                disabled={consoleBusy}
                onPress={() => void readConsole()}
              />
            </View>
          </View>
          {transcript ? (
            <Text style={styles.transcript} selectable>
              {transcript.slice(-2000)}
            </Text>
          ) : (
            <Text style={styles.note}>Nothing read yet.</Text>
          )}
        </Section>
      ) : null}
          </View>
          {hardWipe ? <Text style={styles.note}>{hardWipe}</Text> : null}
        </Section>
      ) : null}

      {/*
        The firmware updater MOVED to the Advanced tab. It was here because
        this tab was where gated things went; it belongs where a person can
        find it, behind its own typed word rather than behind a developer
        switch. See AdvancedScreen.
      */}

      <E2EScreen />

      <UsbScreen hid={hid} entries={usbEntries} clear={clearUsb} />

      <Text style={styles.note}>
        Testing mode bypasses the PIN, so nothing here is behind one. It is on
        by default in a debug build because the terminal e2e runner cannot type
        a PIN.
      </Text>
    </ScrollView>
  );
}

function tail(path: string): string {
  if (!path) {
    return '-';
  }
  return path.split('/').slice(-2).join('/');
}

function describeLed(pixels: number[]): string {
  if (!pixels.length) {
    return 'off';
  }
  return pixels
    .slice(0, 3)
    .map(p => `#${p.toString(16).padStart(6, '0')}`)
    .join(' ');
}

const styles = StyleSheet.create({
  root: {flex: 1},
  content: {paddingBottom: 4},
  kv: {marginTop: 6},
  consoleInput: {backgroundColor: theme.surfaceAlt, borderRadius: 8, color: theme.text, fontFamily: theme.mono, fontSize: 13, marginTop: 8, paddingHorizontal: 10, paddingVertical: 8},
  transcript: {color: theme.textSecondary, fontFamily: theme.mono, fontSize: 11, lineHeight: 15, marginTop: 10},
  row: {flexDirection: 'row', gap: 8, marginTop: 12},
  cell: {flex: 1},
  note: {
    color: theme.textDim,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 4,
    paddingHorizontal: 4,
  },
});
