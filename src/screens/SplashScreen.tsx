import React from 'react';
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import {AnimatedLogo} from '../ui/AnimatedLogo';
import {theme} from '../ui/theme';

/**
 * Held while the firmware boots - and for the logo's three seconds.
 *
 * Not decoration: setup() runs on its own thread and takes a moment to reach
 * the main loop, and every screen after this one asks the device something. A
 * login screen drawn before the device can answer shows "unknown" and then
 * flickers, which reads as a bug.
 *
 * The logo opens as "OK" and spreads into the full wordmark (AnimatedLogo:
 * one second of OK, one of spreading, one of ONLYKEY). onDone fires at the
 * end of that, and App.tsx leaves the splash only once it has AND the
 * firmware has settled - so the animation is never cut off half-way.
 */
export function SplashScreen({message, onDone}: {message?: string; onDone?: () => void}) {
  return (
    <View style={styles.root}>
      <AnimatedLogo height={48} onDone={onDone} />
      <ActivityIndicator color={theme.textDim} style={styles.spinner} />
      <Text style={styles.message}>{message ?? 'Starting the key…'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4},
  spinner: {marginTop: 28},
  message: {color: theme.textDim, fontSize: 13, marginTop: 10},
});
