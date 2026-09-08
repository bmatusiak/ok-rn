import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Btn, KeyValue, Section} from '../ui/components';
import {Keypad} from '../ui/Keypad';
import {theme} from '../ui/theme';
import {getOnlyKey} from '../onlykey';
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
  const [slots, setSlots] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const {device} = await getOnlyKey();
      const {labels} = await device.readLabels({timeoutMs: 10000});
      setSlots(labels);
    } catch (e) {
      /*
       * A label read on a locked device times out saying so rather than
       * failing fast, because the firmware answers it with nothing at all -
       * no error frame. Show whatever it worked out; it is more useful than
       * "failed".
       */
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Read them once on arrival; the device has to be unlocked to answer.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <Section title="Key">
        <View style={styles.kv}>
          <KeyValue label="state" value="unlocked" />
          <KeyValue label="firmware" value={emu.version || '-'} />
          <KeyValue label="LED" value={describeLed(emu.led)} />
        </View>
      </Section>

      <Section
        title="Slots"
        right={
          <Btn title={loading ? '…' : 'Refresh'} disabled={loading} onPress={refresh} />
        }>
        {loading && slots === null ? (
          <ActivityIndicator color={theme.textDim} style={styles.spinner} />
        ) : error ? (
          <Text style={styles.error}>{error}</Text>
        ) : slots && slots.length ? (
          slots.map((label, i) => (
            <View key={i} style={styles.slot}>
              <Text style={styles.slotId}>{slotName(i)}</Text>
              <Text
                style={[styles.slotLabel, !label && styles.slotEmpty]}
                numberOfLines={1}>
                {label || 'empty'}
              </Text>
            </View>
          ))
        ) : (
          <Text style={styles.hint}>No slots reported.</Text>
        )}
        <Text style={styles.hint}>
          Only labels ever leave the key. What a slot types is never read back.
        </Text>
      </Section>

      <Section title="Buttons">
        <Text style={styles.hint}>
          The key's entire input surface. A site asking for a security key
          waits on one of these — any of them will do.
        </Text>
        <View style={styles.pad}>
          <Keypad onPress={emu.press} />
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

/**
 * Slot names as the device means them: two profiles of six.
 *
 * readLabels returns them in wire order, which is 1a-6a then 1b-6b - the same
 * ids setSlot takes.
 */
function slotName(index: number): string {
  const profile = index < 6 ? 'a' : 'b';
  return `${(index % 6) + 1}${profile}`;
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
