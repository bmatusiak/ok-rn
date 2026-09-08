import React from 'react';
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import {Logo} from '../ui/Logo';
import {theme} from '../ui/theme';

/**
 * Held while the firmware boots.
 *
 * Not decoration: setup() runs on its own thread and takes a moment to reach
 * the main loop, and every screen after this one asks the device something. A
 * login screen drawn before the device can answer shows "unknown" and then
 * flickers, which reads as a bug.
 */
export function SplashScreen({message}: {message?: string}) {
  return (
    <View style={styles.root}>
      <Logo height={48} />
      <ActivityIndicator color={theme.textDim} style={styles.spinner} />
      <Text style={styles.message}>{message ?? 'Starting the key\u2026'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4},
  spinner: {marginTop: 28},
  message: {color: theme.textDim, fontSize: 13, marginTop: 10},
});
