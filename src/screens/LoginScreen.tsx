import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Logo} from '../ui/Logo';
import {Btn} from '../ui/components';
import {theme} from '../ui/theme';
import {buildInfo} from '../buildInfo';
import type {DeviceState} from '../hooks/useOkEmu';

/**
 * The first thing you see, and a provenance screen as much as a door.
 *
 * "Which firmware and which library is this actually running" is the first
 * question worth answering on a device whose whole premise is that it carries
 * someone else's C compiled for Android - so the versions lead, rather than
 * hiding in an About box.
 */
export function LoginScreen({
  device,
  onContinue,
}: {
  device: DeviceState;
  onContinue: () => void;
}) {
  const setup = device === 'uninitialized';


  return (
    <View style={styles.root}>
      <Logo height={44} />

      <View style={styles.versions}>
        <Row label="firmware" value={buildInfo.firmware} />
        {buildInfo.sources ? <Row label="sources" value={buildInfo.sources} /> : null}
        <Row label="built for" value={buildInfo.builtFor} />
        <Row label="library" value={buildInfo.library} />
        <Row label="app" value={buildInfo.app} />
      </View>

      <View style={styles.action}>
        <Btn
          title={setup ? 'Set up this key' : 'Log in'}
          tone="primary"
          onPress={onContinue}
        />
        <Text style={styles.hint}>
          {setup
            ? 'This key has no PIN yet. Choose one to finish setting it up.'
            : device === 'locked'
              /*
               * A DUO IS NOT UNLOCKED ON A KEYPAD. Its PIN travels in the
               * message body, so telling its owner to press six buttons is
               * wrong twice over - it has three, and none of them enter a PIN.
               *
               * Read from the BUILD rather than from the device: this screen is
               * the soft key's own door, and the model is a property of the
               * firmware that was staged. The device's capabilities are not
               * available here anyway - they are parsed from the status the
               * firmware broadcasts on UNLOCK, which is the thing this screen
               * exists to reach.
               */
              ? buildInfo.model === 'duo'
                ? 'Enter your PIN.'
                : 'Enter your PIN on the six-button keypad.'
              : 'Waiting for the key\u2026'}
        </Text>
      </View>
    </View>
  );
}

function Row({label, value}: {label: string; value: string}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24},
  versions: {
    marginTop: 36,
    width: '100%',
    maxWidth: 320,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  row: {flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6},
  rowLabel: {color: theme.textDim, fontSize: 12},
  rowValue: {color: theme.textSecondary, fontSize: 12, fontFamily: theme.mono, flexShrink: 1},
  action: {marginTop: 32, width: '100%', maxWidth: 320, gap: 12},
  hint: {color: theme.textDim, fontSize: 12, textAlign: 'center', lineHeight: 17},
});
