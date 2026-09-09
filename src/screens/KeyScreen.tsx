import React from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {Btn, KeyValue, Section} from '../ui/components';
import {Keypad} from '../ui/Keypad';
import {theme} from '../ui/theme';
import OkEmu from '../transport/OkEmu';
import {PinScreen} from './PinScreen';
import {SetupScreen} from './SetupScreen';
import type {EmuSession} from '../hooks/useOkEmu';

/**
 * The key itself: what state it is in, what it holds, and its buttons.
 *
 * Shows one thing at a time, chosen by the DEVICE's state rather than the
 * firmware process's. Those are different questions - the firmware can be
 * running perfectly while the device is locked and refuses everything - and
 * conflating them is what produced a screen that said "running" over a device
 * that would not answer.
 */
/** "OnlyKey DUO (24 slots)", or a dash when the device has not said. */
function describeModel(identity: EmuSession['identity']): string {
  if (!identity || identity.model === 'unknown') {
    return '-';
  }
  const names: Record<string, string> = {
    classic: 'OnlyKey Classic',
    duo: 'OnlyKey DUO',
    original: 'OnlyKey Original',
  };
  const name = names[identity.model] ?? identity.model;
  // A DUO is the one model that says whether a PIN has been set.
  if (identity.pinSet === false) {
    return `${name} (no PIN set)`;
  }
  return name;
}

/** Which firmware build, and what that means for the console. */
function describeBuild(caps: EmuSession['capabilities']): string {
  if (!caps || caps.debugConsole === null) {
    return 'unknown';
  }
  return caps.debugConsole ? 'debug (console)' : 'production (no console)';
}

export function KeyScreen({emu}: {emu: EmuSession}) {
  if (emu.state === 'halted') {
    return (
      <Message
        title="The key has stopped"
        body={
          'The firmware thread cannot be replaced in this process — it is ' +
          'linked into the same library as the bridge, so nothing short of a ' +
          'new process resets it. Restarting the app is the way back, and ' +
          'nothing is lost: flash and EEPROM are files, so the key comes back ' +
          'exactly as it was.'
        }
        tone="error"
        action={{title: 'Restart the app', onPress: () => OkEmu.restartApp()}}
      />
    );
  }

  if (emu.state === 'unavailable') {
    return (
      <Message
        title="No firmware for this device"
        body={
          'libokemu.so was not built for this ABI. Check the APK carries it — ' +
          'a 32-bit-only handset needs armeabi-v7a.'
        }
        tone="error"
      />
    );
  }

  /*
   * A blank key offers SETUP, for the same reason a locked one offers the
   * keypad: a screen that only names the problem is a dead end, and testing
   * mode can land here without ever passing the login flow.
   */
  if (emu.device === 'uninitialized') {
    return <SetupScreen />;
  }

  /*
   * A locked key shows the KEYPAD, not a sign saying it is locked.
   *
   * Telling someone the door is shut while offering no handle is not a screen,
   * it is a dead end - and it is reachable: testing mode skips the login flow
   * entirely, so a locked device landed here with nothing to press. The same
   * pad the door uses works just as well inside, and it means there is exactly
   * one place a PIN is ever typed.
   */
  if (emu.device !== 'unlocked') {
    return <PinScreen onPress={emu.press} />;
  }

  return <Unlocked emu={emu} />;
}

function Unlocked({emu}: {emu: EmuSession}) {
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <Section title="Key">
        <View style={styles.kv}>
          <KeyValue label="state" value="unlocked" />
          <KeyValue label="firmware" value={emu.version || '-'} />
          {/*
            Model and build, not just a version string.

            The build matters to someone reading this screen: a production
            build has no serial console, so the provisioning steps that wait
            on console prompts cannot work against it. Saying "unknown" for
            firmware too old to report a build is deliberate - it is not the
            same claim as "no console".
          */}
          <KeyValue label="model" value={describeModel(emu.identity)} />
          <KeyValue label="build" value={describeBuild(emu.capabilities)} />
          <KeyValue label="LED" value={describeLed(emu.led)} />
        </View>
      </Section>

      <Section title="Buttons">
        <Text style={styles.hint}>
          The key's entire input surface. A site asking for a security key
          waits on one of these — any of them will do. Hold one to count ticks:
          up to 20 types the slot, past 20 types its b profile. It releases
          itself at 71, before the band that takes a backup.
        </Text>
        <View style={styles.pad}>
          <Keypad
            onPress={emu.press}
            onHoldStart={emu.beginHold}
            onHoldEnd={emu.endHold}
            ticks={emu.pressTicks}
          />
        </View>
      </Section>
    </ScrollView>
  );
}

function Message({
  title,
  body,
  tone = 'dim',
  action,
}: {
  title: string;
  body: string;
  tone?: 'dim' | 'error';
  action?: {title: string; onPress: () => void};
}) {
  return (
    <View style={styles.message}>
      <Text style={[styles.messageTitle, tone === 'error' && styles.messageError]}>
        {title}
      </Text>
      <Text style={styles.messageBody}>{body}</Text>
      {action ? (
        <View style={styles.messageAction}>
          <Btn title={action.title} tone="primary" onPress={action.onPress} />
        </View>
      ) : null}
    </View>
  );
}

function describeLed(pixels: number[]): string {
  if (!pixels.length) {
    return 'off';
  }
  return pixels
    .slice(0, 2)
    .map(p => `#${p.toString(16).padStart(6, '0')}`)
    .join(' ');
}

const styles = StyleSheet.create({
  root: {flex: 1},
  content: {paddingBottom: 4},
  kv: {marginTop: 6},
  spinner: {marginVertical: 18},
  hint: {color: theme.textDim, fontSize: 11, lineHeight: 16, marginTop: 10},
  error: {color: theme.error, fontSize: 12, lineHeight: 17, marginTop: 6},

  slot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  slotId: {
    color: theme.textDim,
    fontSize: 12,
    fontFamily: theme.mono,
    width: 26,
  },
  slotLabel: {color: theme.text, fontSize: 14, flexShrink: 1},
  slotEmpty: {color: theme.textDim, fontStyle: 'italic'},

  pad: {marginTop: 12},

  message: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28},
  messageTitle: {color: theme.text, fontSize: 20, fontWeight: '700'},
  messageError: {color: theme.error},
  messageBody: {
    color: theme.textDim,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 10,
  },
  messageAction: {marginTop: 22, alignSelf: 'stretch', paddingHorizontal: 24},
});
